import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const candidates = process.env.LUA_BIN ? [process.env.LUA_BIN] : ["lua", "lua5.2", "lua5.3", "lua5.4", "luajit"];
const interpreter = candidates.find((candidate) => spawnSync(candidate, ["-v"]).status === 0);

for (const [script, description, expected] of [
  ["test/turtle-routing.lua", "turtle ore coverage, obstacles, and optimal turn costs", /Passed \d+ turtle routing scenarios/],
  ["test/turtle-row-route.lua", "saved south staircases, return safety, and recovery", /Passed \d+ south-row route scenarios/],
  ["test/turtle-radius.lua", "mining stays inside each original home radius", /Passed \d+ home-radius scenarios/],
]) test(description, {
  skip: interpreter ? false : "Install Lua or set LUA_BIN to run the turtle simulation.",
}, () => {
  const result = spawnSync(interpreter, [script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, expected);
});
