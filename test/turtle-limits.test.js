import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// CC:Tweaked's Lua (Cobalt) allows 200 local variables, counted across every
// open function: a function's locals add to all those still active in the
// functions around it, up to the file's top level. Past the limit the whole
// script fails to load, and a turtle rejects the update as invalid. Standard
// Lua counts each function on its own, so the other tests can't catch this.
const LIMIT = 200;
const MARGIN = 10;
const KEYWORDS = new Set(["local", "function", "for", "in", "do", "while", "repeat", "until", "if", "then", "elseif", "else", "end", "return", "break"]);

function* tokens(src) {
  let i = 0, line = 1;
  const longBracket = (at) => /^\[(=*)\[/.exec(src.slice(at, at + 64));
  const skipTo = (close, from) => {
    const j = src.indexOf(close, from);
    const end = j < 0 ? src.length : j + close.length;
    line += (src.slice(i, end).match(/\n/g) ?? []).length;
    i = end;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; }
    else if (/\s/.test(c)) i++;
    else if (src.startsWith("--", i)) {
      const m = longBracket(i + 2);
      if (m) skipTo(`]${m[1]}]`, i + 2 + m[0].length);
      else {
        const j = src.indexOf("\n", i);
        i = j < 0 ? src.length : j;
      }
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      line += (src.slice(i, j).match(/\n/g) ?? []).length;
      i = j + 1;
      yield { kind: "str", text: '""', line };
    } else if (c === "[" && longBracket(i)) {
      const m = longBracket(i);
      skipTo(`]${m[1]}]`, i + m[0].length);
      yield { kind: "str", text: '""', line };
    } else if (/[A-Za-z_]/.test(c)) {
      const name = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 256))[0];
      i += name.length;
      yield { kind: "name", text: name, line };
    } else if (src.startsWith("...", i)) { i += 3; yield { kind: "op", text: "...", line }; }
    else { i++; yield { kind: "op", text: c, line }; }
  }
}

// The most locals active at once, counted the way Cobalt counts them.
function peakLocals(src) {
  const toks = [...tokens(src)];
  const stack = [0];
  let active = 0, peak = 0, where = 0, pending = 0;
  const add = (k, line) => {
    active += k;
    stack[stack.length - 1] += k;
    if (active > peak) [peak, where] = [active, line];
  };
  for (let i = 0; i < toks.length; i++) {
    const { kind, text, line } = toks[i];
    if (kind !== "name") continue;
    if (text === "local" && toks[i + 1]?.text === "function") add(1, line);
    else if (text === "local") {
      let j = i + 1, names = 0;
      while (toks[j]?.kind === "name" && !KEYWORDS.has(toks[j].text)) {
        names++;
        if (toks[j + 1]?.text !== ",") break;
        j += 2;
      }
      add(names, line);
      i = j;
    } else if (text === "function") {
      let j = i + 1, method = false;
      while (toks[j].text !== "(") { if (toks[j].text === ":") method = true; j++; }
      let params = 0;
      for (j++; toks[j].text !== ")"; j++) if (toks[j].kind === "name") params++;
      stack.push(0);
      add(params + (method ? 1 : 0), line);
      i = j;
    } else if (text === "for") {
      let j = i + 1, names = 0;
      for (; toks[j].text !== "=" && toks[j].text !== "in"; j++) if (toks[j].kind === "name") names++;
      // Numeric loops add three hidden locals plus the variable; generic
      // loops add three hidden locals plus each name.
      pending = toks[j].text === "=" ? 4 : 3 + names;
      i = j;
    } else if (text === "do" || text === "then" || text === "repeat") {
      stack.push(0);
      if (text === "do" && pending) { add(pending, line); pending = 0; }
    } else if (text === "else" || text === "elseif") {
      active -= stack.pop();
      if (text === "else") stack.push(0);
    } else if (text === "end" || text === "until") active -= stack.pop();
  }
  return { peak, where };
}

test("the turtle script stays clear of CC:Tweaked's 200-local limit", () => {
  const { peak, where } = peakLocals(readFileSync(new URL("../turtle/minerdash.lua", import.meta.url), "utf8"));
  assert.ok(peak <= LIMIT - MARGIN, `${peak} locals active at line ${where}; CC:Tweaked rejects the script past ${LIMIT}. Group helpers into tables.`);
});

test("the local counter matches Cobalt's shared count across nested functions", () => {
  // a, b and f, then f's x and y, the loop's four, and z: 10 on line 4.
  const nested = "local a, b\nlocal function f(x, y)\n  for i = 1, 2 do\n    local z\n  end\nend\nlocal c\n";
  assert.deepEqual(peakLocals(nested), { peak: 10, where: 4 });
});
