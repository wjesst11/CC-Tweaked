import assert from "node:assert/strict";
import test from "node:test";
import { COMPASS, DEFAULT_FLEET, planFleetJob } from "../fleet.js";

function fleet() {
  return {
    ...structuredClone(DEFAULT_FLEET),
    depot: { x: 1000, y: 64, z: 1000, junk: "down", valuables: "north", fuel: "west" },
  };
}

const settings = { x: 100, y: 50, z: 100, dir: "north", length: 10, entryY: 54 };
const ready = [{ id: 1, name: "One" }, { id: 2, name: "Two" }];
const point = (x, y, z, name = "Protected") => ({ name, x1: x, x2: x, y1: y, y2: y, z1: z, z2: z });
const plan = (f = fleet(), params = settings, selected = ready.slice(0, 1), homes = []) =>
  planFleetJob(f, "branchMine", params, selected, homes);

test("new branch assignments carry deterministic staircase access and preserve tunnel bottom coordinates", () => {
  const result = plan(fleet(), settings, ready);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.assignments.map(({ id, args }) => ({
    id, x: args.x, y: args.y, z: args.z, access: args.access, entryY: args.entryY,
  })), [
    { id: 1, x: 100, y: 50, z: 100, access: "stairs", entryY: 54 },
    { id: 2, x: 103, y: 50, z: 100, access: "stairs", entryY: 54 },
  ]);
  assert.deepEqual(result.assignments[0].volume, { x1: 99, x2: 101, y1: 50, y2: 51, z1: 91, z2: 100 });
});

test("defaults entrance Y to the depot level, or the target level when higher", () => {
  const params = { ...settings };
  delete params.entryY;
  assert.equal(plan(fleet(), params).assignments[0].args.entryY, 64);
  assert.equal(plan(fleet(), { ...params, y: 70 }).assignments[0].args.entryY, 70);
});

test("validates entrance Y including whole numbers, headroom, and target level", () => {
  for (const entryY of [49, 319, -65, 51.5, NaN, Infinity, null]) {
    assert.match(plan(fleet(), { ...settings, entryY }).error, /Entrance Y/);
  }
  assert.equal(plan(fleet(), { ...settings, entryY: 50 }).error, undefined);
  assert.equal(plan(fleet(), { ...settings, y: 318, entryY: 318 }).error, undefined);
  assert.match(plan(fleet(), { ...settings, y: 319, entryY: 319 }).error, /Entrance Y/);
});

test("checks every foot and headroom cell of all four staircase directions", () => {
  const dx = [0, 1, 0, -1], dz = [-1, 0, 1, 0];
  for (const [index, dir] of COMPASS.entries()) {
    for (let rise = 0; rise <= 4; rise++) {
      for (let head = 0; head <= 1; head++) {
        const f = fleet();
        f.protect.areas = [point(100 - rise * dx[index], 50 + rise + head, 100 - rise * dz[index])];
        assert.match(plan(f, { ...settings, dir }).error, /protected area/, `${dir}, rise ${rise}, head ${head}`);
      }
    }
  }
});

test("does not reject untouched blocks inside the staircase's enclosing rectangle", () => {
  const f = fleet();
  f.protect.areas = [point(100, 50, 104), point(100, 54, 100)];
  assert.equal(plan(f).error, undefined);
});

test("checks the access staircase of every selected turtle", () => {
  const f = fleet();
  f.protect.areas = [point(103, 52, 102, "Second stair")];
  assert.equal(plan(f, settings, ready.slice(0, 1)).error, undefined);
  assert.match(plan(f, settings, ready).error, /Second stair/);
});

test("refuses staircase intersections with depot waiting space and turtle homes", () => {
  const f = fleet();
  f.depot = { ...f.depot, x: 100, y: 54, z: 104 };
  assert.match(plan(f).error, /depot/);
  assert.match(plan(fleet(), settings, ready.slice(0, 1), [{
    name: "Neighbour", home: { x: 100, y: 53, z: 102 },
  }]).error, /Neighbour's home/);
  assert.equal(plan(fleet(), settings, ready.slice(0, 1), [{
    name: "Neighbour", home: { x: 100, y: 50, z: 104 },
  }]).error, undefined);
});

test("rejects an access staircase extending beyond world coordinate limits", () => {
  assert.match(plan(fleet(), { ...settings, x: -30_000_000, dir: "east" }).error, /world coordinate limits/);
});

test("quarry assignments retain their original box and never gain external stairs", () => {
  const f = fleet();
  f.protect.areas = [point(100, 70, 100)];
  const result = planFleetJob(f, "areaQuarry", {
    x1: 100, z1: 100, x2: 101, z2: 101, yTop: 69, yBottom: 60,
  }, ready, []);
  assert.equal(result.error, undefined);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.assignments[0].args.access, undefined);
  assert.equal(result.assignments[0].args.entryY, undefined);
});
