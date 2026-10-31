import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLEET, planFleetJob } from "../fleet.js";

const SETTINGS = { routeMode: "southRow", y: 50, radius: 21 };
const READY = [1, 2, 3].map((id) => ({ id, name: `Miner ${id}`, home: { x: 100 - (id - 1), y: 67, z: -55, facing: "south" } }));
const fleet = () => ({ ...structuredClone(DEFAULT_FLEET), depot: { x: 1000, y: 67, z: 1000, junk: "down", valuables: "north", fuel: "west" } });
const contains = (b, p) => ["x", "y", "z"].every((axis) => p[axis] >= b[`${axis}1`] && p[axis] <= b[`${axis}2`]);
const plan = (params = SETTINGS, selected = READY, config = fleet()) => planFleetJob(config, "branchMine", params, selected, []);
const point = ({ x, y, z }) => ({ name: "Keep safe", x1: x, x2: x, y1: y, y2: y, z1: z, z2: z });

test("same-level mining defaults to one solid block between southbound parallel lanes", () => {
  const result = plan();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.assignments.map(({ args }) => [args.x, args.z, args.dir, args.spacing, args.band, args.goal]), [
    [100, -38, "south", 2, 0, 0], [98, -38, "south", 2, 0, 0], [96, -38, "south", 2, 0, 0],
  ]);
  for (const { args, volume } of result.assignments) {
    assert.equal(args.scan, true);
    assert.equal(args.coverage, "allSides");
    assert.deepEqual(args.veinBounds, volume);
  }
});

test("one turtle can follow exposed ore on every side of both tunnel heights", () => {
  const { args } = plan(SETTINGS, READY.slice(0, 1)).assignments[0];
  for (let height = 0; height < 2; height++) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      assert.ok(contains(args.veinBounds, { x: args.x + dx, y: args.y + height + dy, z: args.z + dz }), `side ${dx},${dy},${dz} at height ${height}`);
    }
  }
});

test("automatic shared walls have exactly one owner with no gaps or overlapping slices", () => {
  for (const obsoleteSpacing of [2, 3, 4]) {
    const { assignments } = plan({ ...SETTINGS, spacing: obsoleteSpacing });
    assert.ok(assignments.every(({ args }) => args.spacing === 2));
    for (let across = -1; across <= (READY.length - 1) * 2 + 1; across++) {
      for (const y of [SETTINGS.y, SETTINGS.y + 1]) {
        const p = { x: 100 - across, y, z: -38 };
        assert.equal(assignments.filter(({ volume }) => contains(volume, p)).length, 1, `legacy spacing ${obsoleteSpacing}, across ${across}, Y ${y}`);
      }
    }
  }
});

test("protection checks include exposed floor, roof, end walls, and outside walls", () => {
  const targets = [
    { x: 100, y: 49, z: -38 }, { x: 100, y: 52, z: -38 },
    { x: 99, y: 50, z: -38 }, { x: 101, y: 50, z: -38 },
    { x: 100, y: 50, z: -39 }, { x: 100, y: 51, z: -34 },
  ];
  for (const p of targets) {
    const config = fleet();
    config.protect.areas = [point(p)];
    assert.match(plan(SETTINGS, READY.slice(0, 1), config).error, /Keep safe/);
  }
});

test("scan allowance is bounded and clamps its lower limit to world height", () => {
  const { args } = plan().assignments[0];
  for (const p of [{ x: 102, y: 50, z: -38 }, { x: 100, y: 48, z: -38 }, { x: 100, y: 53, z: -38 }]) {
    assert.equal(contains(args.veinBounds, p), false);
  }
  assert.equal(plan({ ...SETTINGS, y: -64, radius: 256 }).assignments[0].args.veinBounds.y1, -64);
  assert.equal(plan({ ...SETTINGS, y: 67 }).assignments[0].args.veinBounds.y2, 69);
});

test("automatic mining settings ignore obsolete spacing, length, goals, bands, and scan switches", () => {
  const { args } = plan({ ...SETTINGS, spacing: 16, length: 999, band: 5, goal: 500, goalItem: "diamond", scan: false }).assignments[0];
  assert.equal(args.radius, 21);
  assert.equal(args.length, 5);
  assert.equal(args.spacing, 2);
  assert.equal(args.band, 0);
  assert.equal(args.goal, 0);
  assert.equal(args.goalItem, "valuables");
  assert.equal(args.scan, true);
  assert.equal(args.coverage, "allSides");
  assert.ok(args.veinBounds);
  assert.deepEqual(args.stairBottom, { x: 100, y: 50, z: -38 });
});
