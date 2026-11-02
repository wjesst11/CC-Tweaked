import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLEET, dimensionFleet, sanitizeFleet, validateFleet } from "../fleet.js";

const OLD_BLOCKS = ["*chest*", "*barrel*", "*shulker_box*", "*hopper*", "create:*"];

test("new settings protect Create blocks except its ores", () => {
  const fleet = sanitizeFleet(structuredClone(DEFAULT_FLEET));
  assert.ok(fleet.protect.blocks.includes("create:*"));
  assert.ok(fleet.protect.blocks.includes("!create:*_ore"));
});

test("older saved settings gain the Create ore exception once, with a newer timestamp", () => {
  const fleet = sanitizeFleet({ updatedAt: 500, protect: { blocks: OLD_BLOCKS, areas: [] } });
  assert.deepEqual(fleet.protect.blocks, [...OLD_BLOCKS, "!create:*_ore"]);
  assert.equal(fleet.protect.oreExceptions, true);
  assert.equal(fleet.updatedAt, 501, "turtles only adopt settings newer than their own copy");
});

test("removing the exception after the upgrade keeps Create's ores protected", () => {
  const fleet = sanitizeFleet({ updatedAt: 900, protect: { blocks: OLD_BLOCKS, areas: [], oreExceptions: true } });
  assert.deepEqual(fleet.protect.blocks, OLD_BLOCKS);
  assert.equal(fleet.updatedAt, 900);
});

test("lists without the whole Create namespace are left as they are", () => {
  const fleet = sanitizeFleet({ updatedAt: 900, protect: { blocks: ["*chest*", "create:mechanical_drill"], areas: [] } });
  assert.deepEqual(fleet.protect.blocks, ["*chest*", "create:mechanical_drill"]);
  assert.equal(fleet.updatedAt, 900);
});

test("the Nether keeps its own depot and protected areas, and shares everything else", () => {
  const fleet = sanitizeFleet({
    depot: { x: 1, y: 67, z: 2 },
    protect: { blocks: ["*chest*"], areas: [{ name: "Home", x1: 0, y1: 45, z1: 0, x2: 9, y2: 320, z2: 9 }] },
    dimensions: { nether: { depot: { x: 5, y: 67, z: -55 }, areas: [{ name: "Home", x1: -5, y1: 80, z1: -5, x2: 5, y2: 128, z2: 5 }] } },
  });
  const nether = dimensionFleet(fleet, "nether");
  assert.equal(nether.depot.x, 5);
  assert.equal(nether.protect.areas[0].y1, 80);
  assert.deepEqual(nether.protect.blocks, ["*chest*"]);
  const overworld = dimensionFleet(fleet, "overworld");
  assert.equal(overworld.depot.x, 1);
  assert.equal(overworld.protect.areas[0].y1, 45);
});

test("settings saved before the Nether existed give it no depot and no protected areas", () => {
  const nether = dimensionFleet(sanitizeFleet({ depot: { x: 1, y: 67, z: 2 } }), "nether");
  assert.equal(nether.depot, null);
  assert.deepEqual(nether.protect.areas, []);
});

test("each dimension's depot needs every chest on its own side", () => {
  const fleet = sanitizeFleet({ dimensions: { nether: { depot: { x: 0, y: 67, z: 0, junk: "down", valuables: "down", fuel: "west" } } } });
  assert.match(validateFleet(fleet), /own side/);
});
