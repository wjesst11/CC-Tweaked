import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

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
const BROADCAST_ACTIONS = new Set(["stop", "goHome", "update"]);

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

function send(ws, msg) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// State. Kept in memory: turtles re-report everything within seconds of a
// reconnect, so a redeploy only loses the log history.

/** id -> { id, label, online, lastSeen, version, status, logs, socket } */
const turtles = new Map();
const dashboards = new Set();

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

// ---------------------------------------------------------------------------
// Turtle connections

function handleTurtle(ws) {
  let turtle = null;
  const authTimer = setTimeout(() => turtle || ws.close(4000, "auth timeout"), AUTH_TIMEOUT_MS);

  ws.on("message", (raw) => {
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
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (!turtle || turtle.socket !== ws) return;
    turtle.socket = null;
    turtle.online = false;
    addLog(turtle, "warn", "Disconnected");
    broadcast({ type: "turtle", turtle: turtleView(turtle) });
  });
}

// ---------------------------------------------------------------------------
// Dashboard connections

function dispatch(turtle, action, args) {
  send(turtle.socket, { type: "cmd", action, args });
}

function handleCommand(ws, { id, action, args }) {
  if (typeof action !== "string" || action.length > 32) return;
  args = args && typeof args === "object" ? args : {};

  if (id === "all") {
    if (!BROADCAST_ACTIONS.has(action)) return;
    for (const t of turtles.values()) if (t.socket) dispatch(t, action, args);
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

  ws.on("message", (raw) => {
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
      send(ws, { type: "snapshot", turtles: [...turtles.values()].map((t) => turtleView(t, true)) });
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
    }
  });

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

// In game: wget https://<your-app>/turtle.lua startup.lua
app.get("/turtle.lua", async (req, res, next) => {
  try {
    const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0];
    const base = PUBLIC_URL ?? `${proto}://${req.get("host")}`;
    const wsUrl = `${base.replace(/^http/, "ws")}/ws/turtle`;
    const script = await fs.readFile(path.join(ROOT, "turtle", "minerdash.lua"), "utf8");
    res
      .type("text/plain")
      .set("Cache-Control", "no-store")
      .send(script.replaceAll("__WS_URL__", wsUrl));
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(ROOT, "public")));

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

server.listen(PORT, () => console.log(`Turtle dashboard listening on :${PORT}`));
