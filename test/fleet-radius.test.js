import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLEET, planFleetJob } from "../fleet.js";

const fleet = () => ({
  ...structuredClone(DEFAULT_FLEET),
  depot: { x: 1000, y: 67, z: 1000, junk: "down", valuables: "north", fuel: "west" },
});
const turtle = (id, x) => ({ id, name: `Miner ${id}`, home: { x, y: 67, z: -55, facing: "south" } });
const SETTINGS = { routeMode: "southRow", y: 50, radius: 26 };
const READY = [turtle(1, 100), turtle(2, 107)];
const plan = (params = SETTINGS, ready = READY, config = fleet(), homes = []) =>
  planFleetJob(config, "branchMine", params, ready, homes);
const point = (x, y, z) => ({ name: "Keep safe", x1: x, x2: x, y1: y, y2: y, z1: z, z2: z });
const inside = (a, x, z) => (x - a.routeHome.x) ** 2 + (z - a.routeHome.z) ** 2 <= a.radius ** 2;

test("a new radius is required instead of inferring one from an old job length", () => {
  for (const radius of [undefined, null, 0, -1, 1025, 1.5, NaN, Infinity, true, "256"]) {
    assert.match(plan({ ...SETTINGS, radius, length: 10 }).error, /mining radius from 1 to 1024/);
  }
  assert.equal(plan({ ...SETTINGS, y: 67, radius: 1 }, READY.slice(0, 1)).error, undefined);
  const { args } = plan({ ...SETTINGS, y: 67, radius: 1024 }, READY.slice(0, 1)).assignments[0];
  assert.equal(args.length, 1025, "the starting cell and radius-boundary cell are both included");
});

test("each tunnel ends at the edge of the circle centered on its own original home", () => {
  const { assignments } = plan();
  assert.deepEqual(assignments.map(({ id, args: a }) => ({ id, x: a.x, z: a.z, length: a.length, homeX: a.routeHome.x, radius: a.radius })), [
    { id: 2, x: 107, z: -38, length: 10, homeX: 107, radius: 26 },
    { id: 1, x: 105, z: -38, length: 9, homeX: 100, radius: 26 },
  ]);
  for (const { args: a } of assignments) {
    for (let step = 0; step < a.length; step++) assert.ok(inside(a, a.x, a.z + step));
    assert.equal(inside(a, a.x, a.z + a.length), false, "another southward lane cell would leave the circle");
    assert.equal(a.veinBounds.z2, a.z + a.length, "the conservative ore-check box includes the end face");
  }
});

test("staircase and assembly checks use their actual horizontal positions in the home cylinder", () => {
  assert.match(plan({ ...SETTINGS, y: -59, radius: 125 }).error, /staircase leaves the home cylinder.*at least 126 blocks horizontally/);
  const selected = [turtle(1, 100), turtle(2, 105)];
  const result = plan({ ...SETTINGS, y: 63, radius: 5 }, selected);
  assert.equal(result.error, undefined);
  const a = result.assignments.find(({ id }) => id === 1).args;
  assert.equal(a.x, 103);
  assert.deepEqual(a.stairBottom, { x: 100, y: 63, z: -51 });
  assert.equal(a.length, 1, "a 3-4-5 lane start lies exactly on the circle");
  assert.match(plan({ ...SETTINGS, y: 63, radius: 4 }, selected).error, /Miner 1.*at least 5 blocks/);
});

test("a single turtle's world-XZ tunnel endpoint is unchanged by the selected mining Y", () => {
  const endpoints = [];
  for (const y of [67, 60, 50, 41]) {
    const result = plan({ ...SETTINGS, y }, READY.slice(0, 1));
    assert.equal(result.error, undefined);
    const { args } = result.assignments[0];
    endpoints.push({ x: args.x, z: args.z + args.length - 1 });
  }
  assert.deepEqual(endpoints, Array.from({ length: 4 }, () => ({ x: 100, z: -29 })));
});

test("the same fixed XZ is inside or outside the cylinder independently of its Y", () => {
  for (const y of [67, 66, 65, 64, 63, 62]) {
    const params = { ...SETTINGS, y, radius: 5 };
    const config = fleet();
    config.protect.areas = [point(101, y, -50)];
    assert.equal(plan(params, READY.slice(0, 1), config).error, undefined, `outside cylinder at Y=${y}`);
    config.protect.areas = [point(100, y, -50)];
    assert.match(plan(params, READY.slice(0, 1), config).error, /Keep safe/, `cylinder boundary at Y=${y}`);
  }
});

test("a small radius rejects a deep diagonal only because the staircase moves south outside the cylinder", () => {
  const shallow = plan({ ...SETTINGS, y: 62, radius: 5 }, READY.slice(0, 1));
  assert.equal(shallow.error, undefined);
  assert.deepEqual(shallow.assignments[0].args.stairBottom, { x: 100, y: 62, z: -50 });
  const result = plan({ ...SETTINGS, y: 61, radius: 5 }, READY.slice(0, 1));
  assert.match(result.error, /staircase leaves the home cylinder.*at least 6 blocks horizontally/);
  assert.doesNotMatch(result.error, /vertical|depth|Y=/);
});

test("mining bounds and radius stay tied to the saved home despite obsolete coordinate fields", () => {
  const { args } = plan({ ...SETTINGS, x: -1000, z: 300, radiusCenter: { x: 0, z: 0 }, dir: "north", length: 1 }).assignments[0];
  assert.deepEqual(args.routeHome, { x: 107, y: 67, z: -55, facing: "south" });
  assert.equal(args.x, 107);
  assert.equal(args.z, -38);
  assert.equal(args.radius, 26);
  assert.equal(args.length, 10);
});

test("protected rectangle corners outside the circle do not reject a circular mining job", () => {
  const params = { ...SETTINGS, y: 67, radius: 5 };
  const config = fleet();
  config.protect.areas = [point(101, 67, -50)];
  assert.equal(plan(params, READY.slice(0, 1), config).error, undefined);
  config.protect.areas = [point(100, 67, -50)];
  assert.match(plan(params, READY.slice(0, 1), config).error, /Keep safe/, "a block exactly at the circular boundary is protected");
  config.protect.areas = [{ name: "Spanning area", x1: 101, x2: 100, y1: 68, y2: 66, z1: -49, z2: -50 }];
  assert.match(plan(params, READY.slice(0, 1), config).error, /Spanning area/, "rectangle overlap must find its nearest included cell");
});

test("home protection ignores outside-circle corners and retains the circular boundary", () => {
  const params = { ...SETTINGS, y: 67, radius: 5 };
  const homes = [{ name: "Neighbour", home: { x: 101, y: 67, z: -50 } }];
  assert.equal(plan(params, READY.slice(0, 1), fleet(), homes).error, undefined);
  homes[0].home.x = 100;
  assert.match(plan(params, READY.slice(0, 1), fleet(), homes).error, /Neighbour's home/);
});

test("depot safety tests actual circular overlap instead of the ore box's outside corners", () => {
  const params = { ...SETTINGS, y: 67, radius: 5 };
  const config = fleet();
  // Depot waiting space begins at X101, Z-50: its nearest point is just
  // outside the radius-5 circle, while still intersecting the ore-check box.
  config.depot = { ...config.depot, x: 106, z: -45 };
  assert.equal(plan(params, READY.slice(0, 1), config).error, undefined);
  config.depot.x = 105;
  assert.match(plan(params, READY.slice(0, 1), config).error, /depot/);
});
