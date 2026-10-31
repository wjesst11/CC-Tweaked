import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLEET, sanitizeFleet } from "../fleet.js";

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
