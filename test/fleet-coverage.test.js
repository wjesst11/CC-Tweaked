import assert from "node:assert/strict";
import test from "node:test";
import { COMPASS, DEFAULT_FLEET, planFleetJob } from "../fleet.js";

const SETTINGS = { x: 100, y: 50, z: 100, dir: "east", length: 5, entryY: 54 };
const READY = [{ id: 1, name: "One" }, { id: 2, name: "Two" }, { id: 3, name: "Three" }];
const fleet = () => ({ ...structuredClone(DEFAULT_FLEET), depot: { x: 1000, y: 64, z: 1000, junk: "down", valuables: "north", fuel: "west" } });
const contains = (b, p) => ["x", "y", "z"].every((axis) => p[axis] >= b[`${axis}1`] && p[axis] <= b[`${axis}2`]);
const plan = (params = SETTINGS, selected = READY, config = fleet()) => planFleetJob(config, "branchMine", params, selected, []);
const point = ({ x, y, z }) => ({ name: "Keep safe", x1: x, x2: x, y1: y, y2: y, z1: z, z2: z });

test("same-level mining defaults to one solid block between parallel lanes", () => {
  const result = plan();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.assignments.map(({ args }) => [args.x, args.z, args.spacing, args.band, args.goal]), [
    [100, 100, 2, 0, 0], [100, 102, 2, 0, 0], [100, 104, 2, 0, 0],
  ]);
  for (const { args, volume } of result.assignments) {
    assert.equal(args.coverage, "allSides");
    assert.deepEqual(args.veinBounds, volume);
  }
});

test("one turtle can follow exposed ore on every side of both tunnel heights", () => {
  for (const dir of COMPASS) {
    const result = plan({ ...SETTINGS, dir }, READY.slice(0, 1));
    const { args } = result.assignments[0];
    for (let height = 0; height < 2; height++) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        assert.ok(contains(args.veinBounds, { x: args.x + dx, y: args.y + height + dy, z: args.z + dz }), `${dir}: side ${dx},${dy},${dz} at height ${height}`);
      }
    }
  }
});

test("shared walls have exactly one owner with no gaps or overlapping slices", () => {
  const dx = [0, 1, 0, -1], dz = [-1, 0, 1, 0];
  for (const [direction, dir] of COMPASS.entries()) {
    for (const spacing of [2, 3]) {
      const { assignments } = plan({ ...SETTINGS, dir, spacing });
      const right = (direction + 1) % 4;
      for (let across = -1; across <= (READY.length - 1) * spacing + 1; across++) {
        for (const y of [SETTINGS.y, SETTINGS.y + 1]) {
          const p = { x: SETTINGS.x + across * dx[right], y, z: SETTINGS.z + across * dz[right] };
          assert.equal(assignments.filter(({ volume }) => contains(volume, p)).length, 1, `${dir}, spacing ${spacing}, across ${across}, Y ${y}`);
        }
      }
    }
  }
});

test("protection checks include exposed floor, roof, end walls, and outside walls", () => {
  const targets = [
    { x: 100, y: 49, z: 100 }, { x: 100, y: 52, z: 100 },
    { x: 99, y: 50, z: 100 }, { x: 105, y: 50, z: 100 },
    { x: 100, y: 50, z: 99 }, { x: 100, y: 51, z: 101 },
  ];
  for (const p of targets) {
    const config = fleet();
    config.protect.areas = [point(p)];
    assert.match(plan(SETTINGS, READY.slice(0, 1), config).error, /Keep safe/);
  }
});

test("scan allowance is bounded and clamped to world height", () => {
  const { args } = plan().assignments[0];
  for (const p of [{ x: 98, y: 50, z: 100 }, { x: 100, y: 48, z: 100 }, { x: 100, y: 53, z: 100 }]) {
    assert.equal(contains(args.veinBounds, p), false);
  }
  assert.equal(plan({ ...SETTINGS, y: -64, entryY: -64 }).assignments[0].args.veinBounds.y1, -64);
  assert.equal(plan({ ...SETTINGS, y: 318, entryY: 318 }).assignments[0].args.veinBounds.y2, 319);
});

test("disabled ore scanning does not reserve or enable an ore-check halo", () => {
  const { args, volume } = plan({ ...SETTINGS, scan: false }, READY.slice(0, 1)).assignments[0];
  assert.equal(args.coverage, undefined);
  assert.equal(args.veinBounds, undefined);
  assert.equal(volume.y1, SETTINGS.y);
  assert.equal(volume.y2, SETTINGS.y + 1);
  assert.equal(volume.x1, SETTINGS.x);
  assert.equal(volume.x2, SETTINGS.x + SETTINGS.length - 1);
});
