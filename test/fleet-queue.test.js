import assert from "node:assert/strict";
import test from "node:test";
import { FleetJobQueue } from "../fleet-queue.js";

function ready(label = "Miner") {
  return { online: true, fresh: true, label, status: { queueSupported: true, staircaseSupported: true, oreScanSupported: true, gpsTrusted: true, queued: 0 } };
}

function setup(state) {
  let time = 1000, sequence = 0, failWrites = false;
  const turtles = new Map([[1, ready("One")], [2, ready("Two")]]);
  const writes = [], sends = [], plans = [], events = [];
  const controls = {
    planner: (kind, params, ids) => ({ assignments: ids.map((id) => ({ id, args: { kind, ...params } })) }),
  };
  const callbacks = {
    state,
    persist: (next) => {
      events.push("persist");
      if (failWrites) throw new Error("Disk is full");
      writes.push(structuredClone(next));
    },
    plan: (kind, params, ids) => {
      plans.push({ kind, params: structuredClone(params), ids: [...ids] });
      return controls.planner(kind, params, ids);
    },
    inspect: (id) => turtles.get(id),
    dispatch: (id, args, action = "fleetJob") => {
      events.push(`send:${action}:${id}`);
      sends.push({ id, args, action });
    },
    now: () => time,
    makeId: () => `job-${++sequence}`,
  };
  const queue = new FleetJobQueue(callbacks);
  return {
    queue, turtles, writes, sends, plans, events, controls, callbacks,
    advance: (amount = 5000) => { time += amount; },
    failWrites: (value) => { failWrites = value; },
    add: (ids = [1], params = {}) => queue.add({ kind: "branchMine", params, ids }),
    finish: (id, queueId, extra = {}) => {
      turtles.get(id).status = { queueSupported: true, staircaseSupported: true, oreScanSupported: true, gpsTrusted: true, lastFleetResult: { id: queueId, ok: true }, ...extra };
    },
  };
}

test("validates initially, replans when ready, and runs jobs in FIFO order", () => {
  const h = setup();
  const first = h.add([1, 2], { x: 10 });
  const second = h.add([1], { x: 20 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(h.plans.length, 2);
  assert.deepEqual(h.queue.snapshot().jobs.map((job) => job.assignments), [[], []]);
  h.queue.tick();
  assert.equal(h.plans.length, 3);
  assert.deepEqual(h.sends.map((send) => send.args.queueId), ["job-1:1", "job-1:2"]);
  assert.equal(h.queue.snapshot().jobs[1].state, "queued");
  h.finish(1, "job-1:1");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, true);
  h.finish(2, "job-1:2");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "completed");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[1].state, "running");
  assert.equal(h.sends.at(-1).args.queueId, "job-2:1");
});

test("waits for every selected turtle to be online, fresh, updated, GPS ready, and idle", async (t) => {
  const cases = [
    ["missing turtle", null],
    ["offline", { online: false }],
    ["stale status", { fresh: false }],
    ["old script", { status: { gpsTrusted: true } }],
    ["no staircase support", { status: { queueSupported: true, staircaseSupported: false, gpsTrusted: true } }],
    ["no all-side scan support", { status: { queueSupported: true, staircaseSupported: true, oreScanSupported: false, gpsTrusted: true } }],
    ["untrusted GPS", { status: { queueSupported: true, gpsTrusted: false } }],
    ["active job", { status: { queueSupported: true, gpsTrusted: true, job: { name: "quarry" } } }],
    ["saved fleet job", { status: { queueSupported: true, gpsTrusted: true, fleetJob: {} } }],
    ["queued command", { status: { queueSupported: true, gpsTrusted: true, queued: 1 } }],
  ];
  for (const [name, update] of cases) {
    await t.test(name, () => {
      const h = setup();
      h.add([1, 2]);
      if (update) Object.assign(h.turtles.get(2), update);
      else h.turtles.delete(2);
      h.queue.tick();
      assert.equal(h.sends.length, 0);
      assert.equal(h.plans.length, 1, "start planning must wait for readiness");
      assert.equal(h.queue.snapshot().jobs[0].state, "queued");
      h.turtles.set(2, ready("Two"));
      h.queue.tick();
      assert.equal(h.sends.length, 2);
    });
  }
});

test("initial plan errors reject the job; changed safety checks block and pause before dispatch", () => {
  const h = setup();
  h.controls.planner = () => ({ error: "Protected base" });
  assert.deepEqual(h.add(), { ok: false, msg: "Protected base" });
  assert.equal(h.writes.length, 0);
  h.controls.planner = (kind, params, ids) => ({ assignments: ids.map((id) => ({ id, args: { kind } })) });
  h.add();
  h.controls.planner = () => ({ error: "Depot moved into this area" });
  h.queue.tick();
  const saved = h.queue.snapshot();
  assert.equal(saved.paused, true);
  assert.equal(saved.jobs[0].state, "blocked");
  assert.match(saved.jobs[0].message, /Depot moved/);
  assert.equal(h.sends.length, 0);
  h.queue.pause(false);
  h.queue.tick();
  assert.equal(h.sends.length, 0, "blocked work cannot silently advance");
});

test("allows the actual planner to assign fewer turtles, after all selected turtles are ready", () => {
  const h = setup();
  h.controls.planner = () => ({ assignments: [{ id: 1, args: { kind: "areaQuarry" } }] });
  h.add([1, 2]);
  h.turtles.get(2).online = false;
  h.queue.tick();
  assert.equal(h.sends.length, 0);
  h.turtles.get(2).online = true;
  h.queue.tick();
  assert.deepEqual(h.sends.map((send) => send.id), [1]);
  h.finish(1, "job-1:1");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "completed");
});

test("retries unacknowledged idle assignments every five seconds with the same queueId", () => {
  const h = setup();
  h.add();
  h.queue.tick();
  h.advance(4999);
  h.queue.tick();
  assert.equal(h.sends.length, 1);
  h.advance(1);
  h.queue.tick();
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends[0], h.sends[1]);
  h.turtles.get(1).status.fleetJob = { queueId: "job-1:1" };
  h.queue.tick();
  h.advance();
  h.queue.tick();
  assert.equal(h.sends.length, 2, "an acknowledged assignment must not restart");
  delete h.turtles.get(1).status.fleetJob;
  h.advance();
  h.queue.tick();
  assert.equal(h.sends.length, 2, "remember acknowledgements while waiting for a final result");
});

test("only correlated success with a fully idle turtle completes an assignment", () => {
  const h = setup();
  h.add();
  h.queue.tick();
  h.finish(1, "old-job:1");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  h.finish(1, "job-1:1", { job: { name: "goHome" } });
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  h.finish(1, "job-1:1", { fleetJob: { queueId: "other-job:1" } });
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  h.finish(1, "job-1:1", { queued: 1 });
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  h.finish(1, "job-1:1");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "completed");
});

test("ignores stale/offline successes and unrelated failures", () => {
  const h = setup();
  h.add();
  h.queue.tick();
  h.turtles.get(1).status.fleetJob = { queueId: "old-job:1", failed: "old error" };
  h.turtles.get(1).status.lastFleetResult = { id: "old-job:1", ok: false };
  h.queue.tick();
  assert.equal(h.queue.snapshot().paused, false);
  h.finish(1, "job-1:1");
  h.turtles.get(1).online = false;
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  h.turtles.get(1).online = true;
  h.turtles.get(1).fresh = false;
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  h.turtles.get(1).fresh = true;
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "completed");
});

test("correlated client failure blocks and pauses the queue", async (t) => {
  for (const failure of ["saved failure", "final failure"]) {
    await t.test(failure, () => {
      const h = setup();
      h.add([1, 2]);
      h.add([1]);
      h.queue.tick();
      h.turtles.get(1).status = {
        queueSupported: true, gpsTrusted: true,
        ...(failure === "saved failure"
          ? { fleetJob: { queueId: "job-1:1", failed: "Blocked by chest" } }
          : { lastFleetResult: { id: "job-1:1", ok: false, msg: "Blocked by chest" } }),
      };
      h.advance();
      h.queue.tick();
      assert.equal(h.queue.snapshot().jobs[0].state, "blocked");
      assert.match(h.queue.snapshot().jobs[0].message, /Blocked by chest/);
      assert.equal(h.queue.snapshot().paused, true);
      assert.equal(h.sends.length, 2);
      h.queue.tick();
      assert.equal(h.queue.snapshot().jobs[1].state, "queued");
    });
  }
});

test("pause prevents starts and retries but still reconciles results and failures", () => {
  const h = setup();
  h.add();
  h.queue.pause(true);
  h.queue.tick();
  assert.equal(h.sends.length, 0);
  h.queue.pause(false);
  h.queue.tick();
  h.queue.pause(true);
  h.advance();
  h.queue.tick();
  assert.equal(h.sends.length, 1);
  h.finish(1, "job-1:1");
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "completed");
  h.add();
  h.queue.pause(false);
  h.queue.tick();
  h.queue.pause(true);
  h.turtles.get(1).status.lastFleetResult = { id: "job-2:1", ok: false, msg: "No route" };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[1].state, "blocked");
});

test("a client pause leaves the job running with a waiting message", () => {
  const h = setup();
  h.add();
  h.queue.tick();
  h.turtles.get(1).status.fleetJob = { queueId: "job-1:1", paused: true };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].state, "running");
  assert.match(h.queue.snapshot().jobs[0].message, /resume/);
  assert.equal(h.queue.snapshot().paused, false);
});

test("persists running assignments before sending and writes only when state changes", () => {
  const h = setup();
  h.add([1, 2]);
  h.events.length = 0;
  h.queue.tick();
  assert.deepEqual(h.events, ["persist", "send:fleetJob:1", "send:fleetJob:2"]);
  assert.equal(h.writes.at(-1).jobs[0].assignments[0].args.queueId, "job-1:1");
  const before = h.writes.length;
  h.queue.tick();
  h.queue.pause(false);
  assert.equal(h.writes.length, before);
});

test("failed writes leave memory unchanged and prevent command dispatch", () => {
  const h = setup();
  h.failWrites(true);
  assert.equal(h.add().ok, false);
  assert.deepEqual(h.queue.snapshot(), { paused: false, jobs: [] });
  h.failWrites(false);
  h.add();
  const before = h.queue.snapshot();
  h.failWrites(true);
  assert.throws(() => h.queue.tick(), /Disk is full/);
  assert.deepEqual(h.queue.snapshot(), before);
  assert.equal(h.sends.length, 0);
  assert.equal(h.queue.pause(true).ok, false);
  assert.deepEqual(h.queue.snapshot(), before);
  assert.deepEqual(h.queue.cancel(before.jobs[0].id).recall, []);
  assert.deepEqual(h.queue.snapshot(), before);
  h.failWrites(false);
  h.queue.tick();
  assert.equal(h.sends.length, 1);
});

test("validates IDs, job limits, and malformed planner output without saving", () => {
  const h = setup();
  for (const ids of [undefined, [], [1, 1], [-1], [1.5], ["1"], [NaN], [Infinity], Array.from({ length: 257 }, (_, i) => i)]) {
    assert.equal(h.queue.add({ kind: "branchMine", params: {}, ids }).ok, false, `invalid IDs: ${String(ids)}`);
  }
  assert.equal(h.writes.length, 0);
  for (const assignments of [[], [{ id: 2, args: {} }], [{ id: 1 }], [{ id: 1, args: {} }, { id: 1, args: {} }]]) {
    h.controls.planner = () => ({ assignments });
    assert.equal(h.add().ok, false);
  }
  const full = setup({ paused: false, jobs: Array.from({ length: 50 }, (_, i) => ({
    id: `saved-${i}`, kind: "branchMine", params: {}, ids: [1], state: "queued", assignments: [],
  })) });
  assert.equal(full.add().ok, false);
  assert.equal(full.plans.length, 0);
});

test("snapshot and callback values cannot mutate the queue", () => {
  const h = setup();
  const params = { nested: { length: 10 } };
  h.add([1], params);
  params.nested.length = 900;
  const snapshot = h.queue.snapshot();
  snapshot.jobs[0].params.nested.length = 1000;
  assert.equal(h.queue.snapshot().jobs[0].params.nested.length, 10);
  h.queue.tick();
  h.sends[0].args.nested.length = 2000;
  h.writes.at(-1).jobs[0].assignments[0].args.nested.length = 3000;
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].args.nested.length, 10);
});

test("restart preserves running assignments, accepts persisted results, and safely resends missing acknowledgements", () => {
  const h = setup();
  h.add([1, 2]);
  h.queue.tick();
  const saved = h.queue.snapshot();
  h.finish(1, "job-1:1");
  h.sends.length = 0;
  const restarted = new FleetJobQueue({ ...h.callbacks, state: saved });
  restarted.tick();
  assert.equal(h.plans.length, 2, "running recovery must not replan");
  assert.deepEqual(h.sends.map((send) => send.args.queueId), ["job-1:2"]);
  assert.equal(restarted.snapshot().jobs[0].assignments[0].done, true);
  h.finish(2, "job-1:2");
  restarted.tick();
  assert.equal(restarted.snapshot().jobs[0].state, "completed");
});

test("cancels waiting work without recall, and running work with pause and unfinished recalls", () => {
  const h = setup();
  h.add([1, 2]);
  const waiting = h.add([1]);
  assert.deepEqual(h.queue.cancel(waiting.id), { ok: true, msg: "Fleet job cancelled.", recall: [] });
  assert.equal(h.queue.snapshot().paused, false);
  h.queue.tick();
  h.finish(1, "job-1:1");
  h.queue.tick();
  const cancelled = h.queue.cancel("job-1");
  assert.deepEqual(cancelled.recall, [2]);
  assert.equal(h.queue.snapshot().paused, true);
  assert.equal(h.queue.snapshot().jobs[0].state, "cancelled");
  assert.equal(h.queue.cancel("missing").ok, false);
  assert.equal(h.queue.cancel("job-1").ok, false);
});

test("cancelled offline turtles are recalled on reconnect, while unrelated work is left alone", () => {
  const h = setup();
  h.add();
  h.queue.tick();
  h.turtles.get(1).online = false;
  assert.deepEqual(h.queue.cancel("job-1").recall, [1]);
  h.queue.tick();
  assert.equal(h.sends.length, 1);
  h.turtles.get(1).online = true;
  h.turtles.get(1).status.fleetJob = { queueId: "job-1:1" };
  h.queue.tick();
  assert.deepEqual(h.sends.at(-1), { id: 1, args: {}, action: "goHome" });
  h.queue.tick();
  assert.equal(h.sends.length, 2);
  h.advance();
  h.queue.tick();
  assert.equal(h.sends.length, 3);
  h.advance();
  h.turtles.get(1).status.job = { name: "goHome" };
  h.queue.tick();
  assert.equal(h.sends.length, 3, "an active return home must not be interrupted");
  const restarted = new FleetJobQueue({ ...h.callbacks, state: h.queue.snapshot() });
  delete h.turtles.get(1).status.job;
  restarted.tick();
  assert.equal(h.sends.at(-1).action, "goHome");
  h.turtles.get(1).status.fleetJob.queueId = "other-job:1";
  const sends = h.sends.length;
  restarted.tick();
  assert.equal(h.sends.length, sends);
  assert.equal(restarted.snapshot().jobs[0].assignments[0].done, true);
});

test("prunes old terminal history while retaining unfinished jobs", () => {
  const jobs = Array.from({ length: 50 }, (_, i) => ({
    id: `history-${i}`, kind: "branchMine", params: {}, ids: [1],
    state: i === 0 ? "queued" : "completed", assignments: [],
  }));
  const h = setup({ paused: false, jobs });
  h.add();
  const saved = h.queue.snapshot();
  assert.equal(saved.jobs.length, 50);
  assert.equal(saved.jobs[0].id, "history-0");
  assert.equal(saved.jobs.some((job) => job.id === "history-1"), false);
  assert.equal(saved.jobs.at(-1).id, "job-1");
});

function cancelledJob(id, turtleId = 1) {
  const queueId = `${id}:${turtleId}`;
  return {
    id, kind: "branchMine", params: {}, ids: [turtleId], state: "cancelled", message: "Cancelled",
    assignments: [{ id: turtleId, queueId, args: { queueId, kind: "branchMine" }, done: false }],
  };
}

test("retains unresolved cancellations through history pruning and restart until the turtle returns", () => {
  const cancelled = cancelledJob("old-cancelled");
  const jobs = [cancelled, ...Array.from({ length: 49 }, (_, i) => ({
    id: `completed-${i}`, kind: "branchMine", params: {}, ids: [2], state: "completed", assignments: [],
  }))];
  const h = setup({ paused: true, jobs });
  h.turtles.get(1).online = false;
  assert.equal(h.add([2]).ok, true);
  const saved = h.queue.snapshot();
  assert.equal(saved.jobs.length, 50);
  assert.equal(saved.jobs[0].id, "old-cancelled");
  assert.equal(saved.jobs.some((job) => job.id === "completed-0"), false);
  const restarted = new FleetJobQueue({ ...h.callbacks, state: saved });
  restarted.tick();
  assert.equal(h.sends.length, 0);
  h.turtles.get(1).online = true;
  h.turtles.get(1).status.fleetJob = { queueId: "old-cancelled:1" };
  restarted.tick();
  assert.deepEqual(h.sends, [{ id: 1, args: {}, action: "goHome" }]);
});

test("pending recalls count toward the bounded job limit, while settled history can be pruned", () => {
  const jobs = Array.from({ length: 50 }, (_, i) => cancelledJob(`cancelled-${i}`));
  const h = setup({ paused: true, jobs });
  h.turtles.get(1).online = false;
  const rejected = h.add([2]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.msg, /pending recalls/);
  assert.equal(h.queue.snapshot().jobs.length, 50);
  assert.equal(h.plans.length, 0);
  h.turtles.get(1).online = true;
  h.turtles.get(1).status.lastFleetResult = { id: "cancelled-0:1", ok: false, msg: "Cancelled" };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, true);
  assert.equal(h.add([2]).ok, true);
  assert.equal(h.queue.snapshot().jobs.length, 50);
  assert.equal(h.queue.snapshot().jobs.some((job) => job.id === "cancelled-0"), false);
});

test("cancellation confirmation needs a matching receipt with no matching active job", () => {
  const h = setup({ paused: true, jobs: [cancelledJob("cancelled")] });
  h.turtles.get(1).status.lastFleetResult = { id: "unrelated:1", ok: false };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, false);
  h.turtles.get(1).status.lastFleetResult = { id: "cancelled:1", ok: false };
  h.turtles.get(1).status.fleetJob = { queueId: "cancelled:1" };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, false);
  assert.equal(h.sends.at(-1).action, "goHome");
  delete h.turtles.get(1).status.fleetJob;
  h.turtles.get(1).fresh = false;
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, false);
  h.turtles.get(1).fresh = true;
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, true);
  assert.equal(h.writes.at(-1).jobs[0].assignments[0].done, true);
  const writes = h.writes.length;
  h.queue.tick();
  assert.equal(h.writes.length, writes);
});

test("a matching successful receipt also resolves a cancellation after work already finished", () => {
  const h = setup({ paused: true, jobs: [cancelledJob("cancelled")] });
  h.turtles.get(1).status.lastFleetResult = { id: "cancelled:1", ok: true };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, true);
  assert.equal(h.sends.length, 0);
});

test("a different active fleet assignment resolves the old cancellation without recalling unrelated work", () => {
  const h = setup({ paused: true, jobs: [cancelledJob("cancelled")] });
  h.turtles.get(1).status.fleetJob = { queueId: "new-job:1" };
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, true);
  assert.equal(h.sends.length, 0);
});

test("failed cancellation confirmation writes retain the tombstone and prevent dispatch", () => {
  const h = setup({ paused: true, jobs: [cancelledJob("settling", 1), cancelledJob("recalling", 2)] });
  h.turtles.get(1).status.lastFleetResult = { id: "settling:1", ok: false };
  h.turtles.get(2).status.fleetJob = { queueId: "recalling:2" };
  h.failWrites(true);
  assert.throws(() => h.queue.tick(), /Disk is full/);
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, false);
  assert.equal(h.sends.length, 0);
  h.failWrites(false);
  h.queue.tick();
  assert.equal(h.queue.snapshot().jobs[0].assignments[0].done, true);
  assert.deepEqual(h.sends, [{ id: 2, args: {}, action: "goHome" }]);
});
