import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { DEFAULT_FLEET } from "../fleet.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FLEET = {
  ...structuredClone(DEFAULT_FLEET), updatedAt: 1,
  depot: { x: 0, y: 64, z: 0, junk: "down", valuables: "north", fuel: "west" },
};
const PARAMS = { x1: 100, x2: 103, z1: 100, z2: 103, yTop: 64, yBottom: 62 };
const IDLE = {
  label: "Test miner", queueSupported: true, staircaseSupported: true, oreScanSupported: true, forceHomeSupported: true, gpsTrusted: true, queued: 0,
  job: null, fleetJob: null, fuel: 10000,
  world: { x: 30, y: 64, z: 30 }, homeWorld: { x: 30, y: 64, z: 30 },
};

class Peer {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.messages = [];
    this.events = new EventEmitter();
    this.socket.on("message", (data) => {
      this.messages.push(JSON.parse(data));
      this.events.emit("message");
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    return this;
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  wait(predicate, after = 0) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.events.off("message", check); };
      const check = () => {
        const result = this.messages.slice(after).find(predicate);
        if (result) { cleanup(); resolve(result); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for WebSocket message; received ${JSON.stringify(this.messages.slice(after))}`));
      }, 8000);
      this.events.on("message", check);
      check();
    });
  }
  exchange(message, predicate) {
    const after = this.messages.length;
    this.send(message);
    return this.wait(predicate, after);
  }
  close() { this.socket.terminate(); }
}

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minerdash-queue-"));
  const queuePath = path.join(directory, "queue.json");
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
  let child;
  let output = "";
  const peers = [];
  const stop = async () => {
    for (const peer of peers.splice(0)) peer.close();
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await stopped;
    child = null;
  };
  const start = async () => {
    output = "";
    child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DASHBOARD_PASSWORD: "queue-test", TURTLE_TOKEN: "turtle-test", FLEET_QUEUE_PATH: queuePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
      } catch {}
      await delay(30);
    }
    throw new Error(`Server did not start: ${output}`);
  };
  const connect = async (endpoint) => {
    const peer = new Peer(`ws://127.0.0.1:${port}/ws/${endpoint}`);
    peers.push(peer);
    return peer.open();
  };
  const dashboard = async () => {
    const peer = await connect("dashboard");
    await peer.exchange({ type: "auth", password: "queue-test" }, (msg) => msg.type === "snapshot");
    return peer;
  };
  const turtle = async (status = IDLE, report = true) => {
    const peer = await connect("turtle");
    await peer.exchange({ type: "hello", token: "turtle-test", id: 7, label: "Test miner", version: "1.9.0", fleet: FLEET }, (msg) => msg.type === "welcome");
    if (report) peer.send({ type: "status", ...status });
    return peer;
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return { start, stop, dashboard, turtle, queuePath };
}

const queueMessage = (state, count) => (msg) => msg.type === "jobQueue" && msg.queue.jobs.some((job) => job.state === state) && (count === undefined || msg.queue.jobs.length === count);
const command = (msg) => msg.type === "cmd" && msg.action === "fleetJob";
const add = (dashboard, params = PARAMS) => dashboard.exchange(
  { type: "queueFleetJob", kind: "areaQuarry", params, ids: [7] }, (msg) => msg.type === "queueResult",
);

test("queue waits for new-client status, survives restart, and starts the next correlated job", { timeout: 30000 }, async (t) => {
  const app = await harness(t);
  let dashboard = await app.dashboard();
  let turtle = await app.turtle({ ...IDLE, queueSupported: false });
  assert.equal((await add(dashboard)).ok, true);
  const waiting = await dashboard.wait(queueMessage("queued"));
  const firstId = waiting.queue.jobs[0].id;
  await dashboard.wait((msg) => queueMessage("queued")(msg) && /Update/.test(msg.queue.jobs[0].message));
  assert.equal(turtle.messages.some(command), false);
  turtle.send({ type: "status", ...IDLE });
  const first = await turtle.wait(command);
  const busy = { ...IDLE, job: { name: "fleetJob", progress: 0.25 }, fleetJob: { queueId: first.args.queueId, kind: "areaQuarry", args: first.args } };
  await dashboard.exchange({ type: "pauseJobQueue", paused: true }, (msg) => msg.type === "queueResult");
  turtle.send({ type: "status", ...busy });
  assert.equal((await add(dashboard, { ...PARAMS, x1: 110, x2: 113 })).ok, true);
  const saved = JSON.parse(await readFile(app.queuePath, "utf8"));
  assert.equal(saved.jobs[0].state, "running");
  assert.equal(saved.jobs.length, 2);

  await app.stop();
  await app.start();
  dashboard = await app.dashboard();
  const snapshot = dashboard.messages.find((msg) => msg.type === "snapshot");
  assert.equal(snapshot.jobQueue.jobs[0].id, firstId);
  assert.equal(snapshot.jobQueue.paused, true);
  turtle = await app.turtle(busy, false);
  await dashboard.exchange({ type: "pauseJobQueue", paused: false }, (msg) => msg.type === "queueResult");
  await dashboard.wait((msg) => queueMessage("running")(msg) && /report|reconnect/.test(msg.queue.jobs[0].message));
  assert.equal(turtle.messages.some(command), false, "old status must never trigger a resend");
  turtle.send({ type: "status", ...busy });
  await delay(1200);
  assert.equal(turtle.messages.some(command), false, "acknowledged work must not restart");

  // An unrelated receipt must not unlock the following job.
  turtle.send({ type: "status", ...IDLE, lastFleetResult: { id: "some-other-job", ok: true } });
  await delay(1200);
  assert.equal(turtle.messages.some(command), false);
  turtle.send({ type: "status", ...IDLE, lastFleetResult: { id: first.args.queueId, ok: true } });
  const second = await turtle.wait(command);
  assert.notEqual(second.args.queueId, first.args.queueId);
  await dashboard.wait((msg) => msg.type === "jobQueue" && msg.queue.jobs[0].state === "completed" && msg.queue.jobs[1].state === "running");

  const pause = await dashboard.exchange({ type: "cmd", id: "all", action: "pause" }, (msg) => msg.type === "jobQueue" && msg.queue.paused);
  assert.equal(pause.queue.paused, true);
  await turtle.wait((msg) => msg.type === "cmd" && msg.action === "pause");
});

test("queued areas are checked again against changed protection before dispatch", { timeout: 15000 }, async (t) => {
  const app = await harness(t);
  const dashboard = await app.dashboard();
  const turtle = await app.turtle();
  await dashboard.exchange({ type: "pauseJobQueue", paused: true }, (msg) => msg.type === "queueResult");
  assert.equal((await add(dashboard)).ok, true);
  const protectedFleet = structuredClone(FLEET);
  protectedFleet.protect.areas.push({ name: "New base", x1: 100, x2: 103, y1: 62, y2: 64, z1: 100, z2: 103 });
  const saved = await dashboard.exchange({ type: "saveFleet", fleet: protectedFleet }, (msg) => msg.type === "fleetSaved");
  assert.equal(saved.ok, true);
  await dashboard.exchange({ type: "pauseJobQueue", paused: false }, (msg) => msg.type === "queueResult");
  const blocked = await dashboard.wait(queueMessage("blocked"));
  assert.equal(blocked.queue.paused, true);
  assert.match(blocked.queue.jobs[0].message, /New base/);
  assert.equal(turtle.messages.some(command), false);
});

test("Pause all still reaches turtles when queue storage fails and holds dispatch", { timeout: 15000 }, async (t) => {
  const app = await harness(t);
  const dashboard = await app.dashboard();
  const turtle = await app.turtle(IDLE, false);
  await dashboard.exchange({ type: "pauseJobQueue", paused: true }, (msg) => msg.type === "queueResult");
  assert.equal((await add(dashboard)).ok, true);
  await dashboard.exchange({ type: "pauseJobQueue", paused: false }, (msg) => msg.type === "queueResult");
  // Make the atomic-write staging path unwritable as a file, without changing
  // permissions or depending on the account's privileges.
  await mkdir(`${app.queuePath}.tmp`);
  const result = await dashboard.exchange({ type: "cmd", id: "all", action: "pause" }, (msg) => msg.type === "queueResult");
  assert.equal(result.ok, false);
  await turtle.wait((msg) => msg.type === "cmd" && msg.action === "pause");
  turtle.send({ type: "status", ...IDLE });
  await delay(1200);
  assert.equal(turtle.messages.some(command), false);
  assert.ok(dashboard.messages.some((msg) => msg.type === "jobQueue" && msg.queue.paused && msg.queue.error));
});

test("Recall all cancels active queued work and recalls an offline assignment on reconnect", { timeout: 15000 }, async (t) => {
  const app = await harness(t);
  const dashboard = await app.dashboard();
  let turtle = await app.turtle();
  assert.equal((await add(dashboard)).ok, true);
  const assigned = await turtle.wait(command);
  const busy = { ...IDLE, job: { name: "fleetJob" }, fleetJob: { queueId: assigned.args.queueId } };
  turtle.send({ type: "status", ...busy });
  await dashboard.wait((msg) => msg.type === "turtle" && msg.turtle.status?.fleetJob?.queueId === assigned.args.queueId);
  turtle.close();
  await dashboard.wait((msg) => msg.type === "turtle" && msg.turtle.online === false);
  const recalled = await dashboard.exchange({ type: "cmd", id: "all", action: "goHome" }, queueMessage("cancelled"));
  assert.equal(recalled.queue.paused, true);
  turtle = await app.turtle(busy);
  await turtle.wait((msg) => msg.type === "cmd" && msg.action === "goHome");
  assert.equal(turtle.messages.some(command), false);
});

test("cancelling an assignment leaves a turtle's unrelated work alone", { timeout: 15000 }, async (t) => {
  const app = await harness(t);
  const dashboard = await app.dashboard();
  const turtle = await app.turtle();
  assert.equal((await add(dashboard)).ok, true);
  await turtle.wait(command);
  const queue = await dashboard.wait(queueMessage("running"));
  turtle.send({ type: "status", ...IDLE, job: { name: "fleetJob" }, fleetJob: { queueId: "unrelated-work" } });
  await dashboard.wait((msg) => msg.type === "turtle" && msg.turtle.status?.fleetJob?.queueId === "unrelated-work");
  const after = turtle.messages.length;
  const cancelled = await dashboard.exchange({ type: "cancelQueuedJob", id: queue.queue.jobs[0].id }, (msg) => msg.type === "queueResult");
  assert.equal(cancelled.ok, true);
  await delay(1200);
  assert.equal(turtle.messages.slice(after).some((msg) => msg.type === "cmd"), false);
});

test("Force home can interrupt a queued assignment and its cancellation pauses the queue", { timeout: 15000 }, async (t) => {
  const app = await harness(t);
  const dashboard = await app.dashboard();
  const turtle = await app.turtle();
  assert.equal((await add(dashboard)).ok, true);
  const assigned = await turtle.wait(command);
  turtle.send({ type: "status", ...IDLE, job: { name: "fleetJob" }, fleetJob: { queueId: assigned.args.queueId } });
  await dashboard.wait((msg) => msg.type === "turtle" && msg.turtle.status?.fleetJob?.queueId === assigned.args.queueId);
  const after = turtle.messages.length;
  dashboard.send({ type: "cmd", id: 7, action: "forceHome" });
  await turtle.wait((msg) => msg.type === "cmd" && msg.action === "forceHome", after);
  turtle.send({ type: "status", ...IDLE, job: { name: "forceHome" }, lastFleetResult: { id: assigned.args.queueId, ok: false, msg: "Cancelled; forcing home" } });
  const blocked = await dashboard.wait(queueMessage("blocked"));
  assert.equal(blocked.queue.paused, true);
});

test("new level jobs wait for all-side support and send the checked ore bounds", { timeout: 15000 }, async (t) => {
  const app = await harness(t);
  const dashboard = await app.dashboard();
  const turtle = await app.turtle({ ...IDLE, oreScanSupported: false });
  const result = await dashboard.exchange({
    type: "queueFleetJob", kind: "branchMine", ids: [7],
    params: { x: 100, y: 50, z: 100, dir: "east", length: 5, entryY: 54 },
  }, (msg) => msg.type === "queueResult");
  assert.equal(result.ok, true);
  await dashboard.wait((msg) => queueMessage("queued")(msg) && /every side/.test(msg.queue.jobs[0].message));
  assert.equal(turtle.messages.some(command), false);
  turtle.send({ type: "status", ...IDLE });
  const { args } = await turtle.wait(command);
  assert.equal(args.spacing, 2);
  assert.equal(args.band, 0);
  assert.equal(args.goal, 0);
  assert.equal(args.coverage, "allSides");
  assert.deepEqual(args.veinBounds, { x1: 99, y1: 49, z1: 99, x2: 105, y2: 52, z2: 101 });
});
