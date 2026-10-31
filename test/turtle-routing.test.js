import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const candidates = process.env.LUA_BIN ? [process.env.LUA_BIN] : ["lua", "lua5.2", "lua5.3", "lua5.4", "luajit"];
const interpreter = candidates.find((candidate) => spawnSync(candidate, ["-v"]).status === 0);

test("turtle route persistence, shortcuts, obstacles, and optimal turn costs", {
  skip: interpreter ? false : "Install Lua or set LUA_BIN to run the turtle simulation.",
}, () => {
  const result = spawnSync(interpreter, ["test/turtle-routing.lua"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Passed \d+ turtle routing scenarios/);
});
