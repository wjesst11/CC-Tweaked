import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { DEFAULT_FLEET, planFleetJob, sanitizeFleet, validateFleet } from "./fleet.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
// Optional: force the URL baked into /turtle.lua (e.g. a custom domain).
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "");

const DASHBOARD_PASSWORD = secretFromEnv("DASHBOARD_PASSWORD");
const TURTLE_TOKEN = secretFromEnv("TURTLE_TOKEN");
// Changing DASHBOARD_PASSWORD invalidates every existing browser session.
const SESSION_KEY = crypto.createHash("sha256").update(`session:${DASHBOARD_PASSWORD}`).digest();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const AUTH_TIMEOUT_MS = 10_000;
const TURTLE_TIMEOUT_MS = 30_000;
const MAX_LOGS = 200;
const SNAPSHOT_LOGS = 50;
// Actions the dashboard may send to every turtle at once.
const BROADCAST_ACTIONS = new Set(["stop", "pause", "resume", "goHome", "update"]);
// After a restart, give turtles that held the dock time to reconnect and
// reclaim it before anyone else gets a turn.
const LEASE_GRACE_MS = 20_000;

function secretFromEnv(name) {
  if (process.env[name]) return process.env[name];
  const generated = crypto.randomBytes(12).toString("base64url");
  console.warn(`[warn] ${name} is not set. Using a temporary value for this run: ${generated}`);
  return generated;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Sessions are stateless "<expires>.<hmac>" tokens, so they survive redeploys.
function signSession(expires) {
  return crypto.createHmac("sha256", SESSION_KEY).update(String(expires)).digest("base64url");
}

function issueSession() {
  const expires = Date.now() + SESSION_TTL_MS;
  return `${expires}.${signSession(expires)}`;
}

function verifySession(token) {
  if (typeof token !== "string") return false;
  const [expires, sig] = token.split(".");
  if (!expires || !sig || !(Number(expires) > Date.now())) return false;
  return safeEqual(sig, signSession(expires));
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw.toString());
    return msg && typeof msg === "object" ? msg : null;
  } catch {
    return null;
  }
}

// Offline turtles have no socket; sending to them is a no-op.
function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// State. Kept in memory: turtles re-report everything within seconds of a
// reconnect, so a redeploy only loses the log history.

/** id -> { id, label, online, lastSeen, version, status, logs, socket } */
const turtles = new Map();
const dashboards = new Set();

// Fleet settings. Every turtle keeps a copy, so after a redeploy the newest
// copy a reconnecting turtle reports is adopted again.
let fleet = structuredClone(DEFAULT_FLEET);
// Blocks turtles have dug, for the dashboard's 3D map: "x,y,z" ->
// name code + turtle id * 65536. The oldest are dropped past MAX_MINED, and
// the history starts again after a redeploy.
const MAX_MINED = 250_000;
const mined = new Map();
const minedNames = [];
const minedNameCodes = new Map();
let pendingMined = []; // [x, y, z, code, turtle id, ...] not yet sent to dashboards

function nameCode(name) {
  let code = minedNameCodes.get(name);
  if (code === undefined) {
    code = minedNames.push(name) - 1;
    minedNameCodes.set(name, code);
  }
  return code;
}

function recordDug(turtle, { names, blocks }) {
  if (!Array.isArray(names) || !Array.isArray(blocks)) return;
  const codes = names.slice(0, 400).map((n) => nameCode(String(n).slice(0, 64)));
  for (let i = 0; i + 3 < blocks.length && i < 4 * 1000; i += 4) {
    const [x, y, z] = [blocks[i], blocks[i + 1], blocks[i + 2]];
    const code = codes[blocks[i + 3]];
    if (![x, y, z].every(Number.isInteger) || code === undefined) continue;
    const key = `${x},${y},${z}`;
    mined.delete(key); // re-insert so a re-dug block counts as newest
    mined.set(key, code + turtle.id * 65536);
    pendingMined.push(x, y, z, code, turtle.id);
  }
  for (const key of mined.keys()) {
    if (mined.size <= MAX_MINED) break;
    mined.delete(key);
  }
}

function minedSnapshot() {
  const blocks = [];
  for (const [key, value] of mined) {
    const [x, y, z] = key.split(",").map(Number);
    blocks.push(x, y, z, value % 65536, Math.floor(value / 65536));
  }
  return { type: "mined", names: minedNames, blocks };
}

// Only dashboards that have the 3D map open get the stream of dug blocks.
function broadcastMap(msg) {
  const data = JSON.stringify(msg);
  for (const ws of dashboards) if (ws.wantsMap && ws.readyState === ws.OPEN) ws.send(data);
}

// One turtle at a time may use the dock; the rest queue.
const depot = { holder: null, queue: [], since: 0 };
const startedAt = Date.now();
// Identify this copy of the server and the code it runs, so the dashboard can
// tell a redeploy apart from two copies running side by side (which splits
// turtles and dashboards between them).
const INSTANCE = crypto.randomBytes(4).toString("hex");
const BUILD = crypto
  .createHash("sha1")
  .update(["server.js", "fleet.js", ...readdirSync(path.join(ROOT, "public")).map((f) => `public/${f}`)]
    .map((f) => readFileSync(path.join(ROOT, f))).join("\0"))
  .digest("hex")
  .slice(0, 8);

// One bad message must never take the whole server down, and every turtle's
// connection with it.
function safely(label, fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[error] ${label}:`, err);
    }
  };
}

function turtleView(t, withLogs = false) {
  const view = {
    id: t.id,
    label: t.label,
    online: t.online,
    lastSeen: t.lastSeen,
    version: t.version,
    status: t.status,
  };
  if (withLogs) view.logs = t.logs.slice(-SNAPSHOT_LOGS);
  return view;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(data);
}

function addLog(t, level, msg) {
  const entry = { time: Date.now(), level, msg: String(msg).slice(0, 500) };
  t.logs.push(entry);
  if (t.logs.length > MAX_LOGS) t.logs.splice(0, t.logs.length - MAX_LOGS);
  broadcast({ type: "log", id: t.id, entry });
}

const nameOf = (t) => t.label || `Turtle #${t.id}`;

// ---------------------------------------------------------------------------
// Fleet: settings and the dock

function setFleet(next) {
  fleet = next;
  broadcast({ type: "fleet", fleet });
  for (const t of turtles.values()) send(t.socket, { type: "fleet", fleet });
}

function depotView() {
  return { holder: depot.holder, queue: depot.queue, since: depot.since };
}

function grant(id) {
  depot.holder = id;
  depot.since = Date.now();
  send(turtles.get(id)?.socket, { type: "lease", resource: "depot", granted: true });
}

function pumpDepot() {
  if (depot.holder === null && Date.now() - startedAt >= LEASE_GRACE_MS) {
    while (depot.queue.length) {
      const id = depot.queue.shift();
      if (turtles.get(id)?.socket) {
        grant(id);
        break;
      }
    }
  }
  broadcast({ type: "depot", depot: depotView() });
}

function releaseDepot(id) {
  depot.queue = depot.queue.filter((q) => q !== id);
  if (depot.holder === id) depot.holder = null;
  pumpDepot();
}

function handleLease(turtle, msg) {
  if (msg.resource !== "depot") return;
  if (msg.op === "release") {
    releaseDepot(turtle.id);
  } else if (msg.op === "acquire") {
    if (depot.holder === turtle.id) {
      grant(turtle.id);
    } else if (!depot.queue.includes(turtle.id)) {
      depot.queue.push(turtle.id);
    }
    pumpDepot();
  }
}

// Turtles that can take a fleet job right now.
function readyTurtles(ids) {
  const ready = [];
  const skipped = [];
  for (const id of ids) {
    const t = turtles.get(Number(id));
    if (!t) continue;
    const s = t.status ?? {};
    if (!t.socket) skipped.push(`${nameOf(t)} is offline`);
    else if (!s.gpsTrusted) skipped.push(`${nameOf(t)} doesn't know its GPS facing yet`);
    else if (s.job) skipped.push(`${nameOf(t)} is busy`);
    else ready.push({ id: t.id, name: nameOf(t) });
  }
  return { ready: ready.sort((a, b) => a.id - b.id), skipped };
}

function startFleetJob(ws, { kind, ids, params }) {
  if (!Array.isArray(ids) || typeof kind !== "string") return;
  const { ready, skipped } = readyTurtles(ids);
  const homes = [...turtles.values()].map((t) => ({ name: nameOf(t), home: t.status?.homeWorld }));
  const plan = planFleetJob(fleet, kind, params ?? {}, ready, homes);
  if (plan.error) {
    send(ws, { type: "fleetJobResult", ok: false, msg: [plan.error, ...skipped].join(" ") });
    return;
  }
  for (const { id, args } of plan.assignments) dispatch(turtles.get(id), "fleetJob", args);
  const msg = `Started ${plan.assignments.length} turtle${plan.assignments.length === 1 ? "" : "s"}.`;
  send(ws, { type: "fleetJobResult", ok: true, msg: [msg, ...skipped].join(" ") });
}

// ---------------------------------------------------------------------------
// Turtle connections

function handleTurtle(ws) {
  let turtle = null;
  const authTimer = setTimeout(() => turtle || ws.close(4000, "auth timeout"), AUTH_TIMEOUT_MS);

  ws.on("message", safely("turtle message", (raw) => {
    const msg = parse(raw);
    if (!msg) return;

    if (!turtle) {
      if (msg.type !== "hello" || !safeEqual(msg.token ?? "", TURTLE_TOKEN)) {
        send(ws, { type: "error", fatal: true, msg: "Invalid turtle token" });
        ws.close(4001, "unauthorized");
        return;
      }
      const id = Number(msg.id);
      if (!Number.isInteger(id)) {
        ws.close(4002, "bad id");
        return;
      }
      clearTimeout(authTimer);
      turtle = turtles.get(id) ?? { id, logs: [], status: null };
      turtles.set(id, turtle);
      if (turtle.socket && turtle.socket !== ws) turtle.socket.close(4003, "replaced");
      Object.assign(turtle, {
        socket: ws,
        online: true,
        label: typeof msg.label === "string" ? msg.label : null,
        version: msg.version ?? null,
        lastSeen: Date.now(),
      });
      send(ws, { type: "welcome" });

      // Keep whichever copy of the fleet settings is newest.
      const theirs = msg.fleet && typeof msg.fleet === "object" ? Number(msg.fleet.updatedAt) || 0 : 0;
      if (theirs > fleet.updatedAt) setFleet(sanitizeFleet(msg.fleet));
      else if (theirs < fleet.updatedAt) send(ws, { type: "fleet", fleet });

      // A turtle that was at the dock when the server restarted gets it back.
      if (msg.holding && (depot.holder === null || depot.holder === id)) {
        depot.holder = id;
        depot.since = Date.now();
      } else if (!msg.holding && depot.holder === id) {
        depot.holder = null;
      }
      pumpDepot();

      addLog(turtle, "info", "Connected");
      broadcast({ type: "turtle", turtle: turtleView(turtle) });
      return;
    }

    turtle.lastSeen = Date.now();
    switch (msg.type) {
      case "status": {
        const { type, ...status } = msg;
        // Idle turtles re-send the same status every few seconds as a heartbeat.
        const json = JSON.stringify(status);
        if (json === turtle.statusJson) break;
        turtle.statusJson = json;
        turtle.status = status;
        turtle.label = typeof status.label === "string" ? status.label : null;
        broadcast({ type: "turtle", turtle: turtleView(turtle) });
        break;
      }
      case "log":
        addLog(turtle, ["warn", "error"].includes(msg.level) ? msg.level : "info", msg.msg);
        break;
      case "result":
        if (!msg.ok || msg.msg) {
          addLog(turtle, msg.ok ? "info" : "error", `${msg.action}: ${msg.msg ?? "failed"}`);
        }
        break;
      case "lease":
        handleLease(turtle, msg);
        break;
      case "dug":
        recordDug(turtle, msg);
        break;
    }
  }));

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (!turtle || turtle.socket !== ws) return;
    turtle.socket = null;
    turtle.online = false;
    // It leaves the queue, but keeps the dock if it holds it: it's physically
    // there. The dashboard can release the dock by hand.
    depot.queue = depot.queue.filter((q) => q !== turtle.id);
    pumpDepot();
    addLog(turtle, "warn", "Disconnected");
    broadcast({ type: "turtle", turtle: turtleView(turtle) });
  });
}

// ---------------------------------------------------------------------------
// Dashboard connections

function dispatch(turtle, action, args) {
  send(turtle.socket, { type: "cmd", action, args });
}

function handleCommand(ws, { id, ids, action, args }) {
  if (typeof action !== "string" || action.length > 32) return;
  args = args && typeof args === "object" ? args : {};

  if (id === "all") {
    if (!BROADCAST_ACTIONS.has(action)) return;
    for (const t of turtles.values()) if (t.socket) dispatch(t, action, args);
    return;
  }
  // An explicit selection of turtles from the fleet page.
  if (Array.isArray(ids)) {
    for (const tid of ids.slice(0, 256)) {
      const t = turtles.get(Number(tid));
      if (t?.socket) dispatch(t, action, args);
    }
    return;
  }

  const turtle = turtles.get(Number(id));
  if (!turtle?.socket) {
    send(ws, { type: "error", msg: `Turtle ${id} is offline` });
    return;
  }
  dispatch(turtle, action, args);
}

function handleDashboard(ws) {
  let authed = false;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  const authTimer = setTimeout(() => authed || ws.close(4000, "auth timeout"), AUTH_TIMEOUT_MS);

  ws.on("message", safely("dashboard message", (raw) => {
    const msg = parse(raw);
    if (!msg) return;

    if (!authed) {
      if (msg.type !== "auth") return;
      const ok =
        verifySession(msg.session) ||
        (typeof msg.password === "string" && safeEqual(msg.password, DASHBOARD_PASSWORD));
      if (!ok) {
        // Slow down password guessing.
        setTimeout(() => {
          send(ws, { type: "authFail" });
          ws.close(4001, "unauthorized");
        }, 1000);
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      dashboards.add(ws);
      send(ws, { type: "authOk", session: issueSession() });
      send(ws, {
        type: "snapshot",
        turtles: [...turtles.values()].map((t) => turtleView(t, true)),
        fleet,
        depot: depotView(),
        server: { instance: INSTANCE, build: BUILD, startedAt },
      });
      return;
    }

    if (msg.type === "cmd") {
      handleCommand(ws, msg);
    } else if (msg.type === "forget") {
      const turtle = turtles.get(Number(msg.id));
      if (turtle && !turtle.socket) {
        turtles.delete(turtle.id);
        broadcast({ type: "removed", id: turtle.id });
      }
    } else if (msg.type === "saveFleet") {
      const next = sanitizeFleet(msg.fleet);
      const problem = validateFleet(next);
      if (problem) {
        send(ws, { type: "fleetSaved", ok: false, msg: problem });
        return;
      }
      next.updatedAt = Math.max(Date.now(), fleet.updatedAt + 1);
      setFleet(next);
      send(ws, { type: "fleetSaved", ok: true });
    } else if (msg.type === "fleetJob") {
      startFleetJob(ws, msg);
    } else if (msg.type === "releaseDepot") {
      if (depot.holder !== null) releaseDepot(depot.holder);
    } else if (msg.type === "mined") {
      ws.wantsMap = true;
      send(ws, minedSnapshot());
    } else if (msg.type === "clearMined") {
      mined.clear();
      pendingMined = [];
      broadcast({ type: "minedCleared" });
    }
  }));

  ws.on("close", () => {
    clearTimeout(authTimer);
    dashboards.delete(ws);
  });
}

// ---------------------------------------------------------------------------
// HTTP

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => res.send("ok"));
// Which copy answered: polling this shows whether more than one copy is running.
app.get("/status", (_req, res) => res.json({ instance: INSTANCE, build: BUILD, startedAt }));

function publicBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0];
  return PUBLIC_URL ?? `${proto}://${req.get("host")}`;
}

// Lua files are served with this server's address filled in.
function serveLua(file) {
  return async (req, res, next) => {
    try {
      const base = publicBase(req);
      const script = await fs.readFile(path.join(ROOT, "turtle", file), "utf8");
      res
        .type("text/plain")
        .set("Cache-Control", "no-store")
        .send(script.replaceAll("__WS_URL__", `${base.replace(/^http/, "ws")}/ws/turtle`).replaceAll("__HTTP_URL__", base));
    } catch (err) {
      next(err);
    }
  };
}

// In game: wget https://<your-app>/turtle.lua startup.lua
app.get("/turtle.lua", serveLua("minerdash.lua"));
// Installer disk: wget https://<your-app>/install.lua disk/startup.lua
app.get("/install.lua", serveLua("install.lua"));

// The build stamps every file with the same 1980 date, so date/size-based cache
// validation can serve stale files after an update. Always send fresh copies.
app.use(
  express.static(path.join(ROOT, "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-cache"),
  }),
);

const server = http.createServer(app);
const turtleWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
// Status JSON compresses well, which matters with dozens of turtles streaming.
const dashboardWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: true });

server.on("upgrade", (req, socket, head) => {
  // Tolerate a trailing slash, a common typo when entering the URL on a turtle.
  const pathname = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "");
  if (pathname === "/ws/turtle") {
    turtleWss.handleUpgrade(req, socket, head, handleTurtle);
  } else if (pathname === "/ws/dashboard") {
    dashboardWss.handleUpgrade(req, socket, head, handleDashboard);
  } else {
    // Answer instead of dropping the socket, which the App Platform proxy turns into a slow 504.
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nTurtles connect to /ws/turtle\n");
  }
});

setInterval(() => {
  const now = Date.now();
  for (const t of turtles.values()) {
    if (t.socket && now - t.lastSeen > TURTLE_TIMEOUT_MS) t.socket.terminate();
  }
  for (const ws of dashboards) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000);

// Tell each moving turtle where nearby turtles are, so its routes can avoid
// them. Moving turtles give way to lower IDs. Turtles standing still (or
// offline, which are still physically there) are sent as "parked", since they
// won't move out of the way.
const TRAFFIC_RANGE = 24;
const near = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= TRAFFIC_RANGE;
setInterval(() => {
  const located = [...turtles.values()].filter((t) => t.status?.world && t.status.gpsTrusted);
  for (const r of located) {
    if (!r.socket || !r.status.moving) continue;
    const here = r.status.world;
    const cells = [];
    const parked = [];
    for (const o of located) {
      if (o === r || !near(o.status.world, here)) continue;
      if (!o.socket || !o.status.moving) {
        parked.push(o.status.world);
      } else if (o.id < r.id) {
        cells.push(o.status.world);
        if (o.status.next) cells.push(o.status.next);
      }
    }
    // Other turtles' homes, so nobody waits in one (homes are often in a row).
    const homes = [...turtles.values()]
      .filter((o) => o !== r && o.status?.homeWorld && near(o.status.homeWorld, here))
      .map((o) => o.status.homeWorld);
    if (cells.length || parked.length || homes.length) send(r.socket, { type: "traffic", cells, parked, homes });
  }
}, 1_000);

// Stream newly dug blocks to open 3D maps a couple of times a second.
setInterval(() => {
  if (!pendingMined.length) return;
  broadcastMap({ type: "dug", names: minedNames, blocks: pendingMined });
  pendingMined = [];
}, 500);

// Hands out dock turns that were held back during the post-restart grace period.
setInterval(() => {
  if (depot.holder === null && depot.queue.length) pumpDepot();
}, 2_000);

process.on("uncaughtException", (err) => console.error("[error] uncaught:", err));
process.on("unhandledRejection", (err) => console.error("[error] unhandled rejection:", err));

server.listen(PORT, () => console.log(`Turtle dashboard listening on :${PORT} (copy ${INSTANCE}, build ${BUILD})`));
