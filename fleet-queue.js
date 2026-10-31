// A durable, single-job-at-a-time fleet scheduler. Turtle commands carry a
// stable queueId, so retrying a command after a disconnect is safe.

const TERMINAL = new Set(["completed", "cancelled"]);
const STATES = new Set(["queued", "running", "blocked", ...TERMINAL]);
const MAX_JOBS = 50;
const RETRY_MS = 5000;
const copy = (value) => structuredClone(value);
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

// Unconfirmed cancellations are still obligations: an offline turtle can
// reconnect with that assignment and must not lose its pending recall.
function settled(job) {
  return job.state === "completed" || (job.state === "cancelled" && job.assignments.every((assignment) => assignment.done));
}

function prune(jobs) {
  while (jobs.length > MAX_JOBS) {
    const index = jobs.findIndex(settled);
    if (index < 0) break;
    jobs.splice(index, 1);
  }
}

function idle(status) {
  return status && !status.job && !status.fleetJob && !status.miningRoute?.intent && !(Number(status.queued) > 0);
}

function rowPosition(position) {
  return position && Number.isInteger(position.x) && position.y === 67 && position.z === -55;
}

function located(status, kind) {
  // Initial row placement supplies the known south-facing orientation. A GPS
  // fix at that row is enough to start without first moving off the home cell.
  return status?.gpsTrusted || (kind === "branchMine" && !status?.miningRoute && rowPosition(status?.world));
}

export class FleetJobQueue {
  constructor({ state, persist, plan, inspect, dispatch, now = Date.now, makeId = () => crypto.randomUUID() }) {
    for (const [name, callback] of Object.entries({ persist, plan, inspect, dispatch, now, makeId })) {
      if (typeof callback !== "function") throw new TypeError(`${name} must be a function`);
    }
    this.persist = persist;
    this.plan = plan;
    this.inspect = inspect;
    this.dispatch = dispatch;
    this.now = now;
    this.makeId = makeId;
    this.state = { paused: state?.paused === true, jobs: copy(Array.isArray(state?.jobs) ? state.jobs : []) };
    if (this.state.jobs.some((job) => !job || !STATES.has(job.state))) throw new Error("Invalid saved fleet queue");
    prune(this.state.jobs);
    this.sentAt = new Map();
    this.recallSentAt = new Map();
    this.acknowledged = new Set();
  }

  snapshot() {
    return copy(this.state);
  }

  // Persist a separate copy before committing memory or sending a command.
  // Failed writes leave the previous in-memory state available for retry.
  commit(change) {
    const next = this.snapshot();
    change(next);
    prune(next.jobs);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.persist(copy(next));
    this.state = next;
    const retained = new Set(next.jobs.flatMap((job) => job.assignments.map((assignment) => assignment.queueId)));
    for (const id of this.sentAt.keys()) if (!retained.has(id)) this.sentAt.delete(id);
    for (const id of this.recallSentAt.keys()) if (!retained.has(id)) this.recallSentAt.delete(id);
    for (const id of this.acknowledged) if (!retained.has(id)) this.acknowledged.delete(id);
  }

  add({ kind, params = {}, ids } = {}) {
    try {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256 ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== ids.length) {
        return { ok: false, msg: "Choose 1 to 256 different turtle IDs (non-negative integers)." };
      }
      if (this.state.jobs.filter((job) => !settled(job)).length >= MAX_JOBS) {
        return { ok: false, msg: "The queue already has 50 unfinished jobs or pending recalls." };
      }
      const safeParams = copy(params);
      const validation = this.plan(kind, copy(safeParams), [...ids]);
      const error = this.planError(validation, ids);
      if (error) return { ok: false, msg: error };
      const id = String(this.makeId());
      if (!id || this.state.jobs.some((job) => job.id === id)) return { ok: false, msg: "Could not create a unique job ID." };
      this.commit((next) => next.jobs.push({
        id, kind, params: safeParams, ids: [...ids], state: "queued", message: "Waiting to start",
        createdAt: this.now(), assignments: [],
      }));
      return { ok: true, msg: "Fleet job queued.", id };
    } catch (error) {
      return { ok: false, msg: `Could not queue job: ${errorMessage(error)}` };
    }
  }

  pause(paused) {
    if (typeof paused !== "boolean") return { ok: false, msg: "Paused must be true or false." };
    try {
      this.commit((next) => { next.paused = paused; });
      return { ok: true, msg: paused ? "Fleet queue paused." : "Fleet queue resumed." };
    } catch (error) {
      return { ok: false, msg: `Could not save queue: ${errorMessage(error)}` };
    }
  }

  cancel(id) {
    const job = this.state.jobs.find((entry) => entry.id === id);
    if (!job) return { ok: false, msg: "Queue job not found.", recall: [] };
    if (TERMINAL.has(job.state)) return { ok: false, msg: "This job has already finished.", recall: [] };
    const active = job.state === "running" || job.state === "blocked";
    const recall = active ? job.assignments.filter((assignment) => !assignment.done).map((assignment) => assignment.id) : [];
    try {
      this.commit((next) => {
        const entry = next.jobs.find((entry) => entry.id === id);
        entry.state = "cancelled";
        entry.message = "Cancelled";
        if (active) next.paused = true;
      });
      return { ok: true, msg: "Fleet job cancelled.", recall };
    } catch (error) {
      return { ok: false, msg: `Could not cancel job: ${errorMessage(error)}`, recall: [] };
    }
  }

  planError(result, ids) {
    if (result?.error) return String(result.error);
    if (!Array.isArray(result?.assignments) || result.assignments.length === 0) return "The job has no assignments.";
    const assigned = new Set();
    for (const assignment of result.assignments) {
      if (!assignment || !ids.includes(assignment.id) || assigned.has(assignment.id) ||
        !assignment.args || typeof assignment.args !== "object" || Array.isArray(assignment.args)) {
        return "The job planner returned invalid assignments.";
      }
      assigned.add(assignment.id);
    }
    return null;
  }

  waitReason(job) {
    for (const id of job.ids) {
      const turtle = this.inspect(id);
      const label = turtle?.label || `Turtle #${id}`;
      if (!turtle?.online) return `Waiting for ${label} to connect`;
      if (!turtle.fresh) return `Waiting for a fresh status from ${label}`;
      const status = turtle.status;
      if (!status?.queueSupported) return `Update ${label}'s script to use the fleet queue`;
      if (job.kind === "branchMine" && !status.staircaseSupported) return `Update ${label}'s script to use staircase mining`;
      if (job.kind === "branchMine" && !status.oreScanSupported) return `Update ${label}'s script to check every side for ore`;
      if (job.kind === "branchMine" && !status.southRowSupported) return `Update ${label}'s script for the saved south staircase`;
      if (job.kind === "branchMine" && !status.radiusSupported) return `Update ${label}'s script for the home mining radius`;
      if (job.kind === "branchMine" && !status.staggeredSupported) return `Update ${label}'s script for staggered tunnels`;
      if (!located(status, job.kind)) return `Waiting for ${label}'s GPS position`;
      if (!idle(status)) return `Waiting for ${label} to finish its current work`;
      if (job.kind === "branchMine") {
        const home = status.miningRoute?.home ?? status.world;
        if (!rowPosition(home) || !rowPosition(status.world) || home.x !== status.world.x) return `Waiting for ${label} at its home on Y=67, Z=-55`;
      }
    }
    return null;
  }

  tick() {
    // Cancellation survives an offline turtle. Recall only the cancelled
    // assignment itself, leaving unrelated later work alone.
    const resolved = new Set();
    const recalls = [];
    for (const cancelled of this.state.jobs.filter((entry) => entry.state === "cancelled")) {
      for (const assignment of cancelled.assignments) {
        if (assignment.done) continue;
        const turtle = this.inspect(assignment.id);
        const status = turtle?.status;
        if (!turtle?.online || !turtle.fresh || !status) continue;
        const matching = status.fleetJob?.queueId === assignment.queueId;
        const receipt = status.lastFleetResult?.id === assignment.queueId;
        if ((receipt && !matching) || (status.fleetJob && !matching)) {
          resolved.add(assignment.queueId);
          continue;
        }
        if (!matching) continue;
        if (status.job?.name && !["fleetJob", "resume"].includes(status.job.name)) continue;
        recalls.push(assignment);
      }
    }
    if (resolved.size) this.commit((next) => {
      for (const cancelled of next.jobs.filter((entry) => entry.state === "cancelled")) {
        for (const assignment of cancelled.assignments) {
          if (resolved.has(assignment.queueId)) assignment.done = true;
        }
      }
    });
    for (const assignment of recalls) {
      const time = this.now();
      if (this.recallSentAt.has(assignment.queueId) && time - this.recallSentAt.get(assignment.queueId) < RETRY_MS) continue;
      this.recallSentAt.set(assignment.queueId, time);
      this.dispatch(assignment.id, {}, "goHome");
    }
    let job = this.state.jobs.find((entry) => !TERMINAL.has(entry.state));
    if (!job || job.state === "blocked") return this.snapshot();

    if (job.state === "queued") {
      if (this.state.paused) return this.snapshot();
      const waiting = this.waitReason(job);
      if (waiting) {
        this.commit((next) => { next.jobs.find((entry) => entry.id === job.id).message = waiting; });
        return this.snapshot();
      }
      let result, error;
      try {
        result = this.plan(job.kind, copy(job.params), [...job.ids]);
        error = this.planError(result, job.ids);
      } catch (cause) {
        error = errorMessage(cause);
      }
      if (error) {
        this.block(job.id, error);
        return this.snapshot();
      }
      this.commit((next) => {
        const entry = next.jobs.find((entry) => entry.id === job.id);
        entry.state = "running";
        entry.message = "Running";
        entry.assignments = result.assignments.map(({ id, args }) => {
          const queueId = `${entry.id}:${id}`;
          return { id, queueId, args: { ...copy(args), queueId }, done: false };
        });
      });
      job = this.state.jobs.find((entry) => entry.id === job.id);
    }

    const completed = [];
    let message = "Running";
    for (const assignment of job.assignments) {
      if (assignment.done) continue;
      const turtle = this.inspect(assignment.id);
      const label = turtle?.label || `Turtle #${assignment.id}`;
      if (!turtle?.online || !turtle.fresh) {
        message = `Waiting for ${label} to reconnect and report its status`;
        continue;
      }
      const status = turtle.status;
      if (!status) continue;
      const active = status.fleetJob?.queueId === assignment.queueId;
      const result = status.lastFleetResult?.id === assignment.queueId ? status.lastFleetResult : null;
      if (active || result) this.acknowledged.add(assignment.queueId);
      if ((active && status.fleetJob.failed) || result?.ok === false) {
        this.block(job.id, `${label}: ${(active && status.fleetJob.failed) || result.msg || "Job failed"}`);
        return this.snapshot();
      }
      if (result?.ok === true && idle(status)) completed.push(assignment.queueId);
      else if ((active && status.fleetJob.paused) || status.job?.paused) message = `Waiting for ${label} to resume`;
    }
    if (completed.length || job.message !== message) {
      this.commit((next) => {
        const entry = next.jobs.find((entry) => entry.id === job.id);
        for (const assignment of entry.assignments) {
          if (completed.includes(assignment.queueId)) assignment.done = true;
        }
        entry.message = message;
        if (entry.assignments.every((assignment) => assignment.done)) {
          entry.state = "completed";
          entry.message = "Completed";
        }
      });
      job = this.state.jobs.find((entry) => entry.id === job.id);
    }
    if (job.state !== "running" || this.state.paused) return this.snapshot();

    for (const assignment of job.assignments) {
      if (assignment.done || this.acknowledged.has(assignment.queueId)) continue;
      const turtle = this.inspect(assignment.id);
      const status = turtle?.status;
      if (!turtle?.online || !turtle.fresh || !status?.queueSupported || !located(status, job.kind) || !idle(status)) continue;
      const time = this.now();
      if (this.sentAt.has(assignment.queueId) && time - this.sentAt.get(assignment.queueId) < RETRY_MS) continue;
      // Record attempts even if the transport throws; the same ID is retried.
      this.sentAt.set(assignment.queueId, time);
      this.dispatch(assignment.id, copy(assignment.args));
    }
    return this.snapshot();
  }

  block(id, message) {
    this.commit((next) => {
      const job = next.jobs.find((entry) => entry.id === id);
      job.state = "blocked";
      job.message = String(message);
      next.paused = true;
    });
  }
}
