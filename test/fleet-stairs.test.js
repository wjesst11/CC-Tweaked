import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLEET, planFleetJob } from "../fleet.js";

function fleet() {
  return {
    ...structuredClone(DEFAULT_FLEET),
    depot: { x: 1000, y: 67, z: 1000, junk: "down", valuables: "north", fuel: "west" },
  };
}

const settings = { routeMode: "southRow", y: 50, radius: 26 };
const turtle = (id, x) => ({ id, name: `Miner ${id}`, home: { x, y: 67, z: -55, facing: "south" } });
const ready = [turtle(1, 100), turtle(2, 107)];
const point = (x, y, z, name = "Protected") => ({ name, x1: x, x2: x, y1: y, y2: y, z1: z, z2: z });
const plan = (f = fleet(), params = settings, selected = ready.slice(0, 1), homes = []) =>
  planFleetJob(f, "branchMine", params, selected, homes);

test("assigns southbound lanes in home-X order while retaining each turtle's own staircase", () => {
  const result = plan(fleet(), settings, ready);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.assignments.map(({ id, args }) => ({
    id, x: args.x, y: args.y, z: args.z, dir: args.dir, routeMode: args.routeMode,
    access: args.access, entryY: args.entryY, routeHome: args.routeHome, stairBottom: args.stairBottom,
  })), [
    { id: 2, x: 107, y: 50, z: -38, dir: "south", routeMode: "southRow", access: "southStairs", entryY: 67,
      routeHome: ready[1].home, stairBottom: { x: 107, y: 50, z: -38 } },
    { id: 1, x: 105, y: 50, z: -38, dir: "south", routeMode: "southRow", access: "southStairs", entryY: 67,
      routeHome: ready[0].home, stairBottom: { x: 100, y: 50, z: -38 } },
  ]);
  assert.deepEqual(result.assignments[0].volume, { x1: 106, x2: 108, y1: 49, y2: 52, z1: -39, z2: -28 });
  assert.deepEqual(ready.map(({ id }) => id), [1, 2], "planning must not reorder the input list");
  result.assignments[0].args.routeHome.x = 0;
  assert.equal(ready[1].home.x, 107, "assigned home is an independent saved coordinate");
});

test("computes staircase bottoms from the surface home at every supported mining level", () => {
  for (const y of [-64, -59, 0, 50, 66, 67]) {
    const result = plan(fleet(), { ...settings, y, radius: 256 });
    assert.equal(result.error, undefined, `Y=${y}`);
    const { args } = result.assignments[0];
    assert.deepEqual(args.stairBottom, { x: 100, y, z: -55 + 67 - y });
    assert.equal(args.entryY, 67);
  }
  for (const y of [-65, 68, 50.5, NaN, Infinity, null, undefined]) {
    assert.match(plan(fleet(), { ...settings, y }).error, /tunnel settings/, `invalid Y=${y}`);
  }
});

test("requires the new layout explicitly so saved old jobs cannot silently change their route", () => {
  for (const routeMode of [undefined, null, "stairs", "other"]) {
    assert.match(plan(fleet(), { ...settings, routeMode }).error, /old route layout/);
  }
  const { args } = plan(fleet(), { ...settings, x: 999, z: 999, dir: "north", entryY: 20 }).assignments[0];
  assert.equal(args.x, 100);
  assert.equal(args.z, -38);
  assert.equal(args.dir, "south");
  assert.equal(args.entryY, 67);
});

test("requires real saved homes in the south-facing Y=67, Z=-55 surface row", () => {
  const invalid = [undefined, { x: 100, y: 66, z: -55, facing: "south" },
    { x: 100, y: 67, z: -54, facing: "south" }, { x: 100, y: 67, z: -55, facing: "north" },
    { x: 100.5, y: 67, z: -55, facing: "south" }, { x: 30_000_001, y: 67, z: -55, facing: "south" }];
  for (const home of invalid) {
    assert.match(plan(fleet(), settings, [{ ...ready[0], home, position: ready[0].home }]).error, /confirmed south-facing home/);
  }
  assert.match(plan(fleet(), settings, [ready[0], turtle(3, 100)]).error, /own X position/);
  const f = fleet();
  f.depot.y = 66;
  assert.match(plan(f).error, /depot must be at Y=67/);
});

test("allows protected areas on every initial stair foot and headroom cell away from the work volume", () => {
  // The last stair columns also touch the regular mining/ore-check volume.
  // They retain regular work protection rather than extending the exemption.
  for (let step = 1; step <= 14; step++) {
    for (let head = 0; head <= 1; head++) {
      const f = fleet();
      f.protect.areas = [point(100, 67 - step + head, -55 + step)];
      assert.equal(plan(f).error, undefined, `step ${step}, head ${head}`);
    }
  }
});

test("keeps normal mining and assembly corridors outside protected areas", () => {
  const f = fleet();
  f.protect.areas = [point(100, 50, -38, "Tunnel bottom")];
  assert.match(plan(f).error, /Tunnel bottom/);
  // Miner 1's bottom is X=100; its assigned lane is X=105. X=101 lies
  // outside all assigned work slices and is checked as assembly access.
  f.protect.areas = [point(101, 50, -38, "Assembly wall")];
  assert.equal(plan(f, settings, [ready[1]]).error, undefined);
  assert.match(plan(f, settings, ready).error, /Assembly wall/);
});

test("does not reserve untouched blocks in the staircase's enclosing rectangle", () => {
  const f = fleet();
  f.protect.areas = [point(100, 50, -50), point(100, 66, -38)];
  assert.equal(plan(f).error, undefined);
});

test("validates all initial stair foot and headroom cells against other homes", () => {
  for (const miner of ready) {
    for (let step = 1; step <= 17; step++) {
      for (let head = 0; head <= 1; head++) {
        const homes = [{ name: "Neighbour", home: { x: miner.home.x, y: 67 - step + head, z: -55 + step } }];
        assert.match(plan(fleet(), settings, ready, homes).error, /Neighbour's home/, `miner ${miner.id}, step ${step}, head ${head}`);
      }
    }
  }
});

test("does not reserve the surface home, but still protects depot waiting space and assembly homes", () => {
  assert.equal(plan(fleet(), settings, ready, ready).error, undefined);
  const f = fleet();
  f.depot = { ...f.depot, x: 100, z: -48 };
  assert.match(plan(f).error, /depot/);
  assert.match(plan(fleet(), settings, ready, [{ name: "Bottom neighbour", home: { x: 101, y: 51, z: -38 } }]).error, /Bottom neighbour's home/);
});

test("rejects lane or scan allowance beyond world coordinate limits", () => {
  for (const x of [-30_000_000, 30_000_000]) {
    assert.match(plan(fleet(), settings, [turtle(1, x)]).error, /world coordinate limits/);
  }
});

test("quarry assignments retain their original box without requiring surface-row homes", () => {
  const f = fleet();
  f.depot.y = 64;
  f.protect.areas = [point(100, 70, 100)];
  const result = planFleetJob(f, "areaQuarry", {
    x1: 100, z1: 100, x2: 101, z2: 101, yTop: 69, yBottom: 60,
  }, [{ id: 1 }, { id: 2 }], []);
  assert.equal(result.error, undefined);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.assignments[0].args.routeMode, undefined);
  assert.equal(result.assignments[0].args.access, undefined);
  assert.equal(result.assignments[0].args.entryY, undefined);
});
