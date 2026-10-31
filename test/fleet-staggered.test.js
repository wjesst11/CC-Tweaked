import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLEET, STAGGERED_HIGHEST, STAGGERED_LOWEST, planFleetJob, staggeredTunnel, stairZ } from "../fleet.js";

const fleet = () => ({
  ...structuredClone(DEFAULT_FLEET),
  depot: { x: 1000, y: 67, z: 1000, junk: "down", valuables: "north", fuel: "west" },
});
const turtle = (id, x) => ({ id, name: `Miner ${id}`, home: { x, y: 67, z: -55, facing: "south" } });
const SETTINGS = { routeMode: "southRow", pattern: "staggered", yTop: -50, yBottom: -58, radius: 12 };
const plan = (params = SETTINGS, ready = [turtle(1, 100), turtle(2, 101), turtle(3, 102)], config = fleet()) =>
  planFleetJob(config, "branchMine", params, ready, []);
const half = (a, x) => Math.floor(Math.sqrt(a.radius ** 2 - (x - a.routeHome.x) ** 2));
const columnsOf = (a) => Array.from({ length: Math.abs(a.last - a.first) + 1 }, (_, i) => Math.min(a.first, a.last) + i);

// The tunnel blocks a set of assignments digs, keyed "x,y,z".
function tunnels(assignments) {
  const dug = new Set();
  for (const { args: a } of assignments) {
    for (const x of columnsOf(a)) {
      for (let y = a.y - 1; y >= a.low; y--) {
        if (!staggeredTunnel(x, y)) continue;
        for (let z = -55 - half(a, x); z <= -55 + half(a, x); z++) dug.add(`${x},${y},${z}`);
      }
    }
  }
  return dug;
}

test("every column of the cylinder goes to exactly one turtle, inside that turtle's own circle", () => {
  const result = plan();
  assert.equal(result.error, undefined);
  const owners = new Map();
  for (const { id, args: a } of result.assignments) {
    assert.equal(a.pattern, "staggered");
    for (const x of columnsOf(a)) {
      assert.ok(!owners.has(x), `column ${x} assigned twice`);
      assert.ok(Math.abs(x - a.routeHome.x) <= a.radius, `column ${x} is outside Miner ${id}'s circle`);
      owners.set(x, id);
    }
  }
  assert.deepEqual([...owners.keys()].sort((p, q) => p - q), Array.from({ length: 12 * 2 + 3 }, (_, i) => 100 - 12 + i));
});

test("every block from the top level to the bottom level touches a tunnel", () => {
  const result = plan();
  const dug = tunnels(result.assignments);
  // Each column is dug to the edge of its own turtle's circle.
  const owner = new Map(result.assignments.flatMap(({ args: a }) => columnsOf(a).map((x) => [x, a.routeHome.x])));
  const inside = (x, z) => owner.has(x) && (x - owner.get(x)) ** 2 + (z + 55) ** 2 <= 12 ** 2;
  let checked = 0;
  for (let x = 88; x <= 114; x++) {
    for (let y = SETTINGS.yBottom; y <= SETTINGS.yTop; y++) {
      for (let z = -67; z <= -43; z++) {
        // The outermost blocks of the cylinder can lack a neighbor inside it.
        if (!inside(x, z) || !inside(x - 1, z) || !inside(x + 1, z)) continue;
        const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => dug.has(`${x + dx},${y + dy},${z}`));
        assert.ok(near, `block ${x},${y},${z} is never checked`);
        checked++;
      }
    }
  }
  assert.ok(checked > 3000);
});

test("only one block in five of the covered levels is dug", () => {
  const dug = tunnels(plan().assignments);
  let inLevels = 0;
  for (const cell of dug) {
    const y = Number(cell.split(",")[1]);
    if (y >= SETTINGS.yBottom && y <= SETTINGS.yTop) inLevels++;
  }
  let volume = 0;
  for (let x = 88; x <= 114; x++) {
    for (let z = -67; z <= -43; z++) {
      if ([100, 101, 102].some((hx) => (x - hx) ** 2 + (z + 55) ** 2 <= 144)) volume += SETTINGS.yTop - SETTINGS.yBottom + 1;
    }
  }
  assert.ok(Math.abs(inLevels / volume - 0.2) < 0.02, `dug ${inLevels} of ${volume}`);
});

test("a single level checks every block on it with tunnels one above and one below", () => {
  const result = plan({ ...SETTINGS, yTop: -58, yBottom: -58 });
  assert.equal(result.error, undefined);
  for (const { args: a } of result.assignments) {
    assert.equal(a.y, -56, "the corridor and stair bottom are two above the level");
    assert.equal(a.low, -59);
  }
  const dug = tunnels(result.assignments);
  for (let x = 92; x <= 110; x++) {
    const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => dug.has(`${x + dx},${-58 + dy},-55`));
    assert.ok(near, `block ${x},-58,-55 is never checked`);
  }
});

test("levels stay above bedrock and below the home row", () => {
  assert.match(plan({ ...SETTINGS, yBottom: STAGGERED_LOWEST - 1 }).error, /bedrock/);
  assert.match(plan({ ...SETTINGS, yTop: STAGGERED_HIGHEST + 1 }).error, /Choose levels/);
  assert.match(plan({ ...SETTINGS, yTop: -58, yBottom: -50 }).error, /bottom at or below the top/);
  assert.equal(plan({ ...SETTINGS, yTop: STAGGERED_HIGHEST, yBottom: STAGGERED_HIGHEST }).error, undefined);
});

test("deep levels with a small radius get switchback stairs inside the circle", () => {
  const result = plan({ ...SETTINGS, radius: 6 }, [turtle(1, 100)]);
  assert.equal(result.error, undefined);
  const { args: a } = result.assignments[0];
  assert.deepEqual(a.stairBottom, { x: 100, y: a.y, z: stairZ(67 - a.y, 6) });
  for (let step = 1; step <= 67 - a.y; step++) assert.ok(Math.abs(stairZ(step, 6) + 55) <= 6);
});

test("far-apart homes mine their own circles and leave the gap between them", () => {
  const result = plan({ ...SETTINGS, radius: 5 }, [turtle(1, 100), turtle(2, 130)]);
  assert.equal(result.error, undefined);
  const columns = result.assignments.flatMap(({ args }) => columnsOf(args));
  assert.ok(columns.every((x) => (x >= 95 && x <= 105) || (x >= 125 && x <= 135)));
  assert.equal(new Set(columns).size, 22);
});

test("each turtle starts at the end of its columns nearer its stairs", () => {
  for (const { args: a } of plan().assignments) {
    assert.ok(Math.abs(a.first - a.routeHome.x) <= Math.abs(a.last - a.routeHome.x));
    assert.equal(a.x, a.first);
  }
});

test("protected areas on the corridor or in the tunnels refuse the job", () => {
  const config = fleet();
  config.protect.areas = [{ name: "Vault", x1: 95, x2: 95, y1: -48, y2: -48, z1: -55, z2: -55 }];
  assert.match(plan(SETTINGS, undefined, config).error, /Vault/);
  config.protect.areas = [{ name: "Vault", x1: 104, x2: 104, y1: -55, y2: -55, z1: -60, z2: -60 }];
  assert.match(plan(SETTINGS, undefined, config).error, /Vault/);
  config.protect.areas = [{ name: "Far", x1: 300, x2: 301, y1: -55, y2: -55, z1: -60, z2: -60 }];
  assert.equal(plan(SETTINGS, undefined, config).error, undefined);
});

test("tunnels start at the ore's most common level, kept inside the tunnel levels", () => {
  const peakOf = (params) => plan({ ...SETTINGS, ...params }).assignments[0].args.peak;
  assert.equal(peakOf({ peak: -54 }), -54);
  assert.equal(peakOf({ peak: -64 }), -59, "diamond's peak is below bedrock; start at the lowest tunnel");
  assert.equal(peakOf({ peak: 232 }), -49, "a peak above the levels starts at the top tunnel");
  assert.equal(peakOf({}), -49, "without a peak, start at the top");
  assert.match(plan({ ...SETTINGS, peak: "deep" }).error, /whole-number level/);
});

const { planJoin } = await import("../fleet.js");
const member = (at, overrides = {}) => {
  const { assignments } = plan({ ...SETTINGS, radius: 20 }, [turtle(1, 100)]);
  const args = { ...assignments[0].args, first: 80, last: 120, x: 80, jobId: "job-1", ...overrides };
  return { id: 1, name: "Miner 1", args, at };
};

test("a joining turtle takes the far side of the busiest turtle's columns", () => {
  // Pass 1 sweeps from first (80) up to last (120); it is at column 90.
  const result = planJoin(fleet(), [member({ pass: 1, x: 90 })], [turtle(2, 101)], []);
  assert.equal(result.error, undefined);
  const [update] = result.updates, [join] = result.assignments;
  assert.deepEqual([update.args.first, update.args.last], [80, 100], "the busy turtle keeps the half it is working in");
  assert.deepEqual(update.args.done, { pass: 1, cols: [[80, 89]] }, "columns already swept in this pass stay done");
  assert.deepEqual([Math.min(join.args.first, join.args.last), Math.max(join.args.first, join.args.last)], [101, 120]);
  assert.deepEqual(join.args.done, { pass: 1, cols: [] }, "the helper's columns still need this pass");
  assert.equal(join.args.jobId, "job-1");
  assert.deepEqual(join.after, 1);
  assert.deepEqual(join.expect, { first: 80, last: 100 });
});

test("a turtle past the middle keeps its side, and the helper starts on the next pass there", () => {
  // A helper at X 95 reaches columns 80 to 100 inside its radius of 20.
  const result = planJoin(fleet(), [member({ pass: 1, x: 110 })], [turtle(2, 95)], []);
  const [update] = result.updates, [join] = result.assignments;
  assert.deepEqual([update.args.first, update.args.last], [101, 120]);
  assert.deepEqual(join.args.done, { pass: 1, cols: [[80, 100]] }, "pass 1 is done on the helper's side");
  assert.deepEqual(update.args.done, { pass: 1, cols: [[101, 109]] });
});

test("the busy turtle keeps the column it heads to next", () => {
  // Pass 2 sweeps back from 120 toward 80; at 101 it heads to 100 next.
  const result = planJoin(fleet(), [member({ pass: 2, x: 101 })], [turtle(2, 95)], []);
  const [update] = result.updates, [join] = result.assignments;
  assert.ok(Math.min(update.args.first, update.args.last) <= 100, "the next column went to the helper");
  assert.ok(Math.max(join.args.first, join.args.last) < Math.min(update.args.first, update.args.last));
});

test("helpers go to the busiest turtles, one each, and only inside their own radius", () => {
  const busy = member({ pass: 1, x: 82 });
  const nearlyDone = { ...member({ pass: 5, x: 118 }), id: 3, name: "Miner 3" };
  const result = planJoin(fleet(), [nearlyDone, busy], [turtle(2, 101), turtle(4, 300)], []);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].after, 1, "the busiest turtle shares first");
  assert.deepEqual(result.unused, ["Miner 4"], "a turtle whose radius can't reach is left out");
  assert.match(planJoin(fleet(), [busy], [turtle(4, 300)], []).error, /enough columns left to share/);
});
