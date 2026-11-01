const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// localStorage can be unavailable (private windows, blocked storage).
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch {}
  },
};

const MAX_LOGS = 200;
const MAX_TRAIL = 500;
const RENDER_INTERVAL_MS = 150;
const SCRIPT_VERSION = "2.3.9"; // the turtle script this dashboard expects

// "2.2.9" is older than "2.2.10": versions compare part by part, as numbers.
function olderVersion(version, than) {
  const [a, b] = [String(version).split("."), String(than).split(".")];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (Number(a[i]) || 0) - (Number(b[i]) || 0);
    if (d) return d < 0;
  }
  return false;
}
const FACING = ["+Z", "+X", "−Z", "−X"]; // local headings
const COMPASS = ["north", "east", "south", "west"];
const SIDES = { north: "North", east: "East", south: "South", west: "West", up: "Above", down: "Below" };
const KEYS = { w: "forward", s: "back", a: "turnLeft", d: "turnRight", e: "up", q: "down" };
const DIGGABLE = new Set(["forward", "up", "down"]);
const JOB_NAMES = { quarry: "Quarry", tunnel: "Tunnel", goHome: "Going home", forceHome: "Forcing home" };
const KIND_NAMES = { branchMine: "Mining a level", areaQuarry: "Quarrying an area" };
const STATE_LABELS = { working: "Working", paused: "Paused", attention: "Needs attention", idle: "Idle", offline: "Offline" };
const QUEUE_LABELS = { queued: "Queued", running: "Running", blocked: "Blocked", completed: "Completed", cancelled: "Cancelled" };

// Swatches that make valuables easy to spot in the inventory grid.
const ITEM_COLORS = [
  [/diamond/, "#4ee2e0"],
  [/emerald/, "#17dd62"],
  [/ancient_debris|netherite/, "#6b4a3a"],
  [/gold/, "#f5c542"],
  [/iron/, "#d8af93"],
  [/copper/, "#e07a4f"],
  [/redstone/, "#e02a2a"],
  [/lapis/, "#2f5bd3"],
  [/quartz/, "#e9e3db"],
  [/amethyst/, "#9a5cc6"],
  [/coal/, "#3a3a3a"],
];

const ICONS = {
  offline: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  idle: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>',
  working: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg>',
  paused: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1h2.5v8H1.5zM6 1h2.5v8H6z" fill="currentColor"/></svg>',
  attention: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .5l4.7 8.8H.3z" fill="currentColor"/></svg>',
};

const savedSelection = store.get("selected");
const state = {
  turtles: new Map(), // id -> turtle as sent by the server, plus logs
  trails: new Map(), // id -> { frame, points: [{x, z}] } for the map
  selected: savedSelection === null ? null : Number(savedSelection),
  view: ["fleet", "map"].includes(store.get("view")) ? store.get("view") : "turtles",
  filter: store.get("filter") ?? "all",
  search: "",
  mapMode: store.get("mapMode") === "fleet" ? "fleet" : "turtle",
  fleet: null, // shared fleet settings from the server
  fleetDirty: false, // the settings form has unsaved edits
  depot: { holder: null, queue: [] },
  jobQueue: { paused: false, jobs: [] },
  queueReady: false,
  connected: false,
  picked: new Set(), // turtles picked for a fleet job
  ready: false, // received the first snapshot
  ws: null,
  loggedIn: false,
  loginPending: false,
  reconnectDelay: 1000,
};

// Formatting -----------------------------------------------------------------

const nameOf = (t) => t.label || `Turtle #${t.id}`;
const fmt = (n) => Math.round(n).toLocaleString();
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeXml = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

function itemsOf(status) {
  const inv = status?.inventory;
  return Array.isArray(inv) ? inv : Object.values(inv ?? {});
}

function prettyName(id) {
  if (!id) return "";
  return capital(String(id).replace(/^[^:]+:/, "").replaceAll("_", " "));
}

function itemColor(id) {
  return ITEM_COLORS.find(([pattern]) => pattern.test(id))?.[1];
}

function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fuelInfo(status) {
  if (status?.fuel == null) return null;
  if (status.fuel === "unlimited") return { unlimited: true };
  const limit = status.fuelLimit > 0 ? status.fuelLimit : 20000;
  const frac = Math.min(1, status.fuel / limit);
  // Severity is absolute: 1,000 fuel is 1,000 blocks whatever the turtle's limit.
  const sev = status.fuel < 200 ? "crit" : status.fuel < 1000 ? "warn" : "ok";
  return { fuel: status.fuel, limit, frac, sev };
}

function jobName(status) {
  const job = status?.job;
  if (!job) return null;
  if (job.name === "fleetJob" || job.name === "resume") return KIND_NAMES[status.fleetJob?.kind] ?? "Fleet job";
  return JOB_NAMES[job.name] ?? prettyName(job.name);
}

function jobPercent(job) {
  return ["goHome", "forceHome", "recoverRoute"].includes(job.name) ? "" : `${Math.round((job.progress ?? 0) * 100)}%`;
}

function turtleState(t) {
  if (!t.online) return { key: "offline", label: "Offline" };
  const s = t.status ?? {};
  const job = s.job;
  if (job?.paused) return { key: "paused", label: "Paused" };
  if (job && /waiting|full|low on fuel/i.test(job.detail ?? "")) return { key: "attention", label: "Needs attention" };
  if (job) return { key: "working", label: `${jobName(s)} ${jobPercent(job)}`.trim() };
  if (s.fleetJob?.failed) return { key: "attention", label: "Job failed" };
  if (s.fleetJob?.paused) return { key: "paused", label: "Paused" };
  if (s.miningRoute?.intent) return { key: "attention", label: "Return pending" };
  if (fuelInfo(s)?.sev === "crit") return { key: "attention", label: "Low fuel" };
  return { key: "idle", label: "Idle" };
}

// Can this turtle take a fleet job? Returns null if so, else the reason.
function notReady(t) {
  const s = t.status ?? {};
  const reason = notQueueReady(t);
  if (reason) return reason;
  if (s.job || s.fleetJob || s.miningRoute?.intent || s.queued > 0) return "busy";
  const home = fleetTab() === "branchMine" && southRowHome(t);
  if (home && (!worldPoint(s.world) || ["x", "y", "z"].some((axis) => s.world[axis] !== home[axis]))) return "return to the saved home first";
  return null;
}

// Busy turtles can join a future job while finishing their current one.
function notQueueReady(t) {
  if (!t.online) return "offline";
  const s = t.status ?? {};
  if (fleetTab() === "branchMine") {
    if (!s.radiusSupported || !s.staggeredSupported) return "update script for staggered tunnels";
    if (!s.southRowSupported) return "update script for home-row mining";
    if (!southRowHome(t)) return "place at Y 67, Z −55, facing south";
    if (!s.gpsTrusted && (s.miningRoute || !onSouthRow(s.world))) return "no confirmed GPS position yet";
  } else if (!s.gpsTrusted) return "no GPS facing yet";
  return null;
}

function worldPoint(p) {
  return p && [p.x, p.y, p.z].every(Number.isFinite);
}

function onSouthRow(p) {
  return worldPoint(p) && Number.isInteger(p.x) && p.y === 67 && p.z === -55;
}

function southRowHome(t) {
  const saved = t.status?.miningRoute?.home;
  if (onSouthRow(saved)) return { x: saved.x, y: saved.y, z: saved.z, facing: "south" };
  const fix = t.status?.world;
  return onSouthRow(fix) ? { x: fix.x, y: fix.y, z: fix.z, facing: "south" } : null;
}

// Where to draw a turtle: world coordinates once GPS knows its facing,
// otherwise its own frame relative to where it started.
function mapPos(t) {
  const s = t.status;
  const num = (p) => p && { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
  if (s?.world && (s.facing || (s.southRowSupported && onSouthRow(s.world)))) {
    return { frame: "world", ...num(s.world), dir: COMPASS.indexOf(s.facing ?? "south"), home: num(s.miningRoute?.home ?? s.homeWorld) };
  }
  if (s?.pos) return { frame: "local", ...num(s.pos), dir: Number(s.heading), home: num(s.home) };
  return null;
}

// Connection -----------------------------------------------------------------

function connect(auth) {
  const old = state.ws;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard`);
  state.ws = ws;
  state.queueReady = false;
  old?.close();
  setConn("connecting");

  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", ...auth })));
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (state.server) state.server.lastSeen = Date.now();
    try {
      handle(msg);
    } catch (err) {
      reportError(err);
    }
  });
  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    state.ws = null;
    rememberServer();
    if (state.loginPending) {
      state.loginPending = false;
      showLogin("Can't reach the server. Try again.");
      return;
    }
    if (!state.loggedIn) return;
    setConn("offline");
    setTimeout(() => {
      if (state.loggedIn && !state.ws) connect({ session: store.get("session") });
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });
}

function handle(msg) {
  switch (msg.type) {
    case "authOk":
      store.set("session", msg.session);
      state.loggedIn = true;
      state.loginPending = false;
      state.reconnectDelay = 1000;
      showApp();
      setConn("online");
      break;

    case "authFail": {
      const wasPassword = state.loginPending;
      state.loggedIn = false;
      state.loginPending = false;
      store.set("session", null);
      showLogin(wasPassword ? "Wrong password." : "Your session expired. Sign in again.");
      break;
    }

    case "snapshot":
      noteServer(msg.server);
      state.turtles = new Map(msg.turtles.map((t) => [t.id, t]));
      for (const t of state.turtles.values()) recordTrail(t);
      state.depot = msg.depot ?? state.depot;
      state.jobQueue = msg.jobQueue ?? { paused: false, jobs: [] };
      state.queueReady = true;
      state.ready = true;
      state.revealSelected = true;
      ensureSelection();
      invalidate("list", "detail", "log", "fleet", "map");
      setFleet(msg.fleet);
      if (world) sendRaw({ type: "mined" }); // reconnected: fetch the history again
      break;

    case "turtle": {
      const t = { ...msg.turtle, logs: state.turtles.get(msg.turtle.id)?.logs ?? [] };
      state.turtles.set(t.id, t);
      recordTrail(t);
      if (!state.turtles.has(state.selected)) {
        ensureSelection();
        invalidate("log");
      }
      // Other turtles appear on the maps, so the detail view can change too.
      invalidate("list", "detail", "fleet");
      break;
    }

    case "log": {
      const t = state.turtles.get(msg.id);
      if (!t) break;
      t.logs.push(msg.entry);
      if (t.logs.length > MAX_LOGS) t.logs.shift();
      if (msg.id === state.selected && !dirty.log) appendLog(msg.entry);
      if (msg.entry.level !== "info") toast(`${nameOf(t)}: ${msg.entry.msg}`, msg.entry.level);
      break;
    }

    case "removed":
      state.turtles.delete(msg.id);
      state.trails.delete(msg.id);
      state.picked.delete(msg.id);
      ensureSelection();
      invalidate("list", "detail", "log", "fleet");
      break;

    case "fleet":
      setFleet(msg.fleet);
      invalidate("fleet", "map");
      break;

    case "mined":
      world?.clearMined();
      world?.addMined(msg.names, msg.blocks);
      invalidate("map");
      break;

    case "dug":
      world?.addMined(msg.names, msg.blocks);
      // The server keeps the latest 250,000; past that, start again from its copy.
      if (world?.stats().mined > 275_000) {
        world.clearMined();
        sendRaw({ type: "mined" });
      }
      invalidate("map");
      break;

    case "minedCleared":
      world?.clearMined();
      invalidate("map");
      break;

    case "depot":
      state.depot = msg.depot;
      invalidate("fleet");
      break;

    case "jobQueue":
      state.jobQueue = msg.queue;
      state.queueReady = true;
      invalidate("fleet");
      break;

    case "queueResult": {
      const el = $("#job-queue-result");
      el.hidden = false;
      el.className = `form-msg ${msg.ok ? "ok" : "error"}`;
      el.textContent = msg.msg;
      break;
    }

    case "fleetSaved":
      if (msg.ok) {
        state.fleetDirty = false;
        fillFleetForm();
      }
      setSaveMsg(msg.ok ? "Saved. Every turtle has the new settings." : msg.msg, !msg.ok);
      break;

    case "fleetJobResult": {
      const el = $("#fleet-job-result");
      el.hidden = false;
      el.className = `form-msg ${msg.ok ? "ok" : "error"}`;
      el.textContent = msg.msg;
      if (state.joining) toast(msg.msg, msg.ok ? "info" : "warn");
      state.joining = false;
      break;
    }

    case "error":
      toast(msg.msg, "error");
      break;
  }
}

// Something went wrong in the dashboard itself: say so once instead of
// silently showing stale or missing turtles.
function reportError(err) {
  console.error(err);
  if (state.reportedError) return;
  state.reportedError = true;
  toast(`Dashboard error: ${err?.message ?? err}. Reload the page, and report it if it keeps happening.`, "error");
}

// Which copy of the server we talk to is remembered across page loads. A
// different copy running the same code that was already up while we were
// talking to the previous one means two copies are running side by side,
// which splits turtles and dashboards between them.
function noteServer(server) {
  if (!server) return;
  let prev = null;
  try {
    prev = JSON.parse(store.get("server") ?? "null");
  } catch {}
  const twoCopies =
    prev && prev.instance !== server.instance && prev.build === server.build && server.startedAt < prev.lastSeen - 5000;
  if (twoCopies) $("#server-warning").hidden = false;
  state.server = { ...server, lastSeen: Date.now() };
  rememberServer();
}

function rememberServer() {
  if (state.server) store.set("server", JSON.stringify(state.server));
}

function sendRaw(msg) {
  if (state.ws?.readyState !== WebSocket.OPEN) {
    toast("Not connected to the server", "error");
    return;
  }
  state.ws.send(JSON.stringify(msg));
}

function command(action, args = {}, id = state.selected) {
  if (id == null) return;
  if (DIGGABLE.has(action) && $("#auto-dig").checked) args = { ...args, dig: true };
  sendRaw({ type: "cmd", id, action, args });
}

// Rendering is batched: with dozens of turtles streaming updates, draw at most
// every RENDER_INTERVAL_MS rather than once per message.
const dirty = { list: false, detail: false, log: false, fleet: false, map: false };
let renderTimer = 0;
let lastRender = 0;

function invalidate(...parts) {
  for (const part of parts) dirty[part] = true;
  if (renderTimer) return;
  const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - lastRender));
  renderTimer = setTimeout(() => requestAnimationFrame(flush), wait);
}

function flush() {
  renderTimer = 0;
  lastRender = performance.now();
  const { list, detail, log, fleet, map } = dirty;
  dirty.list = dirty.detail = dirty.log = dirty.fleet = dirty.map = false;
  try {
    if (list) renderList();
    $("#fleet-view").hidden = state.view !== "fleet";
    $("#map-view").hidden = state.view !== "map";
    if (state.view === "fleet") {
      $("#turtle").hidden = $("#empty").hidden = true;
      if (fleet || list) renderFleet();
    } else if (state.view === "map") {
      $("#turtle").hidden = $("#empty").hidden = true;
      ensureWorld();
      if (map || list || fleet || detail) renderWorld();
    } else if (detail || log) {
      renderDetail(log);
    }
  } catch (err) {
    reportError(err);
  }
}

// Renaming ------------------------------------------------------------------------
// A turtle's name is its computer label, stored on the turtle. Names are never
// cleared: an unlabeled turtle loses its files when it's picked up.

function renameTurtle(t, label) {
  const taken = [...state.turtles.values()].find((o) => o.id !== t.id && nameOf(o).toLowerCase() === label.toLowerCase());
  if (taken) toast(`Turtle #${taken.id} is also called ${label}.`, "warn");
  sendRaw({ type: "cmd", id: t.id, action: "setLabel", args: { label } });
  t.label = label; // shown right away; the turtle's next status confirms it
  invalidate("list", "detail", "fleet");
}

function startRename() {
  const t = currentTurtle();
  if (!t?.online) return;
  $("#rename-input").value = t.label ?? "";
  $(".name-row").hidden = true;
  $("#rename-form").hidden = false;
  $("#rename-input").focus();
  $("#rename-input").select();
}

function endRename() {
  $("#rename-form").hidden = true;
  $(".name-row").hidden = false;
}

// Picked turtles in ID order, each with its new name.
function bulkRenamePlan() {
  const form = $("#bulk-rename");
  const prefix = form.elements.prefix.value.trim();
  const start = Math.max(0, Math.floor(Number(form.elements.start.value) || 0));
  return pickedTurtles()
    .sort((a, b) => a.id - b.id)
    .map((t, i) => ({ t, label: `${prefix}${start + i}` }));
}

function renderBulkRenamePreview() {
  const plan = bulkRenamePlan();
  const offline = plan.filter((p) => !p.t.online).length;
  const sample = plan.slice(0, 3).map((p) => `${nameOf(p.t)} → ${p.label}`).join(", ");
  $("#bulk-rename-preview").textContent = plan.length
    ? `${plan.length} turtle${plan.length === 1 ? "" : "s"} in ID order: ${sample}${plan.length > 3 ? ", …" : ""}.` +
      (offline ? ` ${offline} offline turtle${offline === 1 ? "" : "s"} will be skipped.` : "")
    : "Pick turtles above first.";
}

// Selection & views ------------------------------------------------------------

function sortedTurtles() {
  return [...state.turtles.values()].sort(
    (a, b) => b.online - a.online || nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }),
  );
}

function ensureSelection() {
  if (state.turtles.has(state.selected)) return;
  state.selected = sortedTurtles()[0]?.id ?? null;
  store.set("selected", state.selected);
}

function select(id) {
  endRename();
  state.selected = id;
  state.revealSelected = true;
  store.set("selected", id);
  invalidate("list", "detail", "log", "fleet");
}

function setView(view) {
  state.view = view;
  store.set("view", view);
  for (const tab of $$(".tab[data-view]")) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  invalidate("list", "detail", "log", "fleet");
}

function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
}

function showLogin(error) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-error").hidden = !error;
  $("#login-error").textContent = error ?? "";
  $("#login-form button[type=submit]").disabled = false;
  $("#password").focus();
}

function setConn(status) {
  state.connected = status === "online";
  const el = $("#conn");
  el.dataset.state = status;
  el.textContent = { online: "Live", connecting: "Connecting…", offline: "Reconnecting…" }[status];
  updateQueueControls();
}

function toast(text, level = "info") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${level}`;
  el.textContent = text;
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => el.remove(), level === "info" ? 3000 : 6000);
}

function currentTurtle() {
  return state.turtles.get(state.selected);
}

// Turtle list --------------------------------------------------------------------

function renderStatus(el, st) {
  el.className = `status status-${st.key}`;
  el.innerHTML = ICONS[st.key];
  el.append(st.label);
}

function renderMeter(el, frac, sev = "ok") {
  el.classList.toggle("sev-warn", sev === "warn");
  el.classList.toggle("sev-crit", sev === "crit");
  el.firstElementChild.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
}

function matchesSearch(t, query) {
  if (!query) return true;
  const q = query.toLowerCase().replace(/^#/, "");
  return nameOf(t).toLowerCase().includes(q) || String(t.id) === q;
}

function renderList() {
  const turtles = sortedTurtles();
  const states = new Map(turtles.map((t) => [t.id, turtleState(t)]));

  const counts = { all: turtles.length, working: 0, paused: 0, attention: 0, idle: 0, offline: 0 };
  for (const st of states.values()) counts[st.key]++;
  for (const chip of $$(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === state.filter));
    chip.lastElementChild.textContent = counts[chip.dataset.filter];
  }

  const visible = turtles.filter(
    (t) => (state.filter === "all" || states.get(t.id).key === state.filter) && matchesSearch(t, state.search),
  );

  const list = $("#turtle-list");
  const existing = new Map([...list.children].map((li) => [Number(li.dataset.id), li]));
  visible.forEach((t, i) => {
    let li = existing.get(t.id);
    existing.delete(t.id);
    if (!li) li = createListItem(t.id);
    updateListItem(li, t, states.get(t.id));
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  for (const li of existing.values()) li.remove();

  const selectedLi = state.revealSelected && list.querySelector(`li[data-id="${state.selected}"]`);
  state.revealSelected = false;
  if (selectedLi) {
    // Scroll the list only (scrollIntoView would also jump the page on phones).
    const l = list.getBoundingClientRect();
    const r = selectedLi.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - (l.height - r.height) / 2;
    if (r.left < l.left || r.right > l.right) list.scrollLeft += r.left - l.left;
  }

  const empty = $("#list-empty");
  empty.hidden = visible.length > 0 || !state.ready;
  empty.textContent = turtles.length ? "No turtles match." : "No turtles have connected yet.";
  $("#turtle-count").textContent = turtles.length ? `${turtles.length - counts.offline} of ${turtles.length} online` : "";
}

function createListItem(id) {
  const li = document.createElement("li");
  li.dataset.id = id;
  li.innerHTML = `
    <button class="turtle-item" type="button">
      <span class="ti-top"><span class="ti-name"></span><span class="status"></span></span>
      <span class="meter"><span class="meter-fill"></span></span>
      <span class="ti-sub"></span>
    </button>`;
  li.firstElementChild.addEventListener("click", () => select(id));
  return li;
}

function updateListItem(li, t, st) {
  const btn = li.firstElementChild;
  const fuel = fuelInfo(t.status);
  btn.setAttribute("aria-current", String(t.id === state.selected));
  $(".ti-name", btn).textContent = nameOf(t);
  renderStatus($(".status", btn), st);

  const meter = $(".meter", btn);
  meter.hidden = !fuel || fuel.unlimited;
  if (!meter.hidden) renderMeter(meter, fuel.frac, fuel.sev);

  let sub = "";
  if (!t.online) {
    // Usually its chunk unloaded: this is where to find it.
    const w = t.status?.world;
    sub = `Last seen ${ago(t.lastSeen)}` + (w ? ` at ${w.x}, ${w.y}, ${w.z}` : "");
  }
  else if (t.status?.job) sub = t.status.job.detail ?? "";
  else if (t.status?.fleetJob?.failed) sub = t.status.fleetJob.failed;
  else if (fuel) sub = fuel.unlimited ? "Unlimited fuel" : `${fmt(fuel.fuel)} fuel`;
  $(".ti-sub", btn).textContent = sub;
}

// Turtle detail --------------------------------------------------------------------

function renderDetail(rebuildLog = false) {
  const t = state.turtles.get(state.selected);
  $("#empty").hidden = Boolean(t) || !state.ready;
  $("#turtle").hidden = !t;
  if (!t) return;

  const s = t.status ?? {};
  const job = s.job;
  const busy = Boolean(job);

  // Header
  $("#t-name").textContent = nameOf(t);
  renderStatus($("#t-status"), turtleState(t));
  $("#t-meta").textContent = [
    `ID ${t.id}`,
    t.version && `script v${t.version}`,
    !t.online && t.lastSeen && `last seen ${ago(t.lastSeen)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  $("#btn-forget").hidden = t.online;

  renderFuel(s);
  renderPosition(s);
  renderJob(s);

  renderLocalPlan(t);

  // Blocks around the turtle (only refreshed while idle)
  for (const side of ["up", "front", "down"]) {
    const el = $(`#around-${side}`);
    const block = s.around?.[side];
    el.textContent = busy ? "…" : block ? prettyName(block) : s.around ? "Air" : "–";
    el.title = block ?? "";
    el.classList.toggle("air", !block);
  }

  renderInventory(s, t.online && !busy);
  renderHome(s);
  renderMap(t);

  for (const el of $$(".needs-online")) el.disabled = !t.online;
  for (const el of $$(".needs-idle")) el.disabled = !t.online || busy;

  if (rebuildLog) renderLog(t);
}

function renderFuel(s) {
  const fuel = fuelInfo(s);
  const meter = $("#fuel-meter");
  meter.hidden = !fuel || fuel.unlimited;
  if (!fuel) {
    $("#fuel-value").textContent = "–";
    $("#fuel-sub").textContent = "";
  } else if (fuel.unlimited) {
    $("#fuel-value").textContent = "Unlimited";
    $("#fuel-sub").textContent = "Fuel is turned off on this server";
  } else {
    $("#fuel-value").textContent = fmt(fuel.fuel);
    renderMeter(meter, fuel.frac, fuel.sev);
    $("#fuel-sub").textContent =
      `${Math.round(fuel.frac * 100)}% of ${fmt(fuel.limit)}` + (fuel.sev === "crit" ? " · refuel soon" : "");
  }
}

function coordsHtml(p) {
  const [x, y, z] = [p.x, p.y, p.z].map((n) => Math.round(Number(n)));
  return `<b>X</b>${x}<b>Y</b>${y}<b>Z</b>${z}`;
}

function renderPosition(s) {
  const world = s.world ?? s.gps; // script v1.0 sent `gps`
  const parts = [];
  if (world) {
    $("#pos-label").textContent = "Position · GPS";
    $("#pos-value").innerHTML = coordsHtml(world);
    parts.push(s.facing ? `Facing ${capital(s.facing)}` : s.southRowSupported && onSouthRow(world)
      ? "Facing south from home-row setup" : "Move one block so it can find north");
  } else if (s.pos) {
    $("#pos-label").textContent = "Position · relative to start";
    $("#pos-value").innerHTML = coordsHtml(s.pos);
    parts.push(`Facing ${FACING[s.heading] ?? "?"}`);
    if (s.gpsState === "none") parts.push("no wireless modem");
    if (s.gpsState === "nofix") parts.push("no GPS signal");
  } else {
    $("#pos-label").textContent = "Position";
    $("#pos-value").textContent = "–";
  }
  if (s.pos && s.home) {
    const dist = Math.abs(s.pos.x - s.home.x) + Math.abs(s.pos.y - s.home.y) + Math.abs(s.pos.z - s.home.z);
    parts.push(dist === 0 ? "At home" : `${fmt(dist)} blocks from home`);
  }
  $("#pos-sub").textContent = parts.join(" · ");
}

function renderJob(s) {
  const job = s.job;
  const fj = s.fleetJob;
  const waiting = !job && fj && (fj.paused || fj.failed); // a fleet job that stopped
  $("#btn-pause").hidden = !(job && !job.paused);
  $("#btn-resume").hidden = !(job?.paused || waiting);
  $("#btn-cancel").hidden = !(job || fj);

  let value = "Idle";
  let sub = s.queued ? `${s.queued} command${s.queued === 1 ? "" : "s"} queued` : "";
  if (job) {
    value = job.paused ? `${jobName(s)} (paused)` : jobName(s);
    sub = [job.detail, jobPercent(job)].filter(Boolean).join(" · ");
  } else if (waiting) {
    value = fj.failed ? "Fleet job stopped" : "Fleet job paused";
    const done = fj.args?.goal > 0 ? `found ${fj.found ?? 0} of ${fj.args.goal}` : `step ${fj.step} of ${fj.total}`;
    sub = fj.failed ?? `${KIND_NAMES[fj.kind] ?? "Fleet job"}, ${done}`;
  }
  $("#job-value").textContent = value;
  $("#job-meter").hidden = !job || ["goHome", "forceHome"].includes(job.name);
  if (job) renderMeter($("#job-meter"), job.progress ?? 0);
  $("#job-sub").textContent = sub;
}

function renderHome(s) {
  const el = $("#home-line");
  const w = s.miningRoute?.home ?? s.homeWorld;
  if (w) {
    el.textContent = `Home ${[w.x, w.y, w.z].map(Number).join(", ")}` +
      (s.miningRoute?.home ? " facing south" : s.homeFacing ? ` facing ${s.homeFacing}` : "");
  } else if (s.home) {
    el.innerHTML = `Home <b>${[s.home.x, s.home.y, s.home.z].map(Number).join(", ")}</b> (relative to start)`;
  } else {
    el.textContent = "";
  }
  const route = s.miningRoute;
  const bottom = route && (route.bottomSaved || route.stair?.complete) ? route.bottom : null;
  const saved = $("#stair-line");
  saved.hidden = !worldPoint(bottom);
  saved.textContent = worldPoint(bottom)
    ? `Saved stair bottom ${bottom.x}, ${bottom.y}, ${bottom.z}` +
      (route.phase ? ` · ${route.phase}` : "") : "";
}

// Inventory ----------------------------------------------------------------------

function buildInventory() {
  const grid = $("#inv-grid");
  for (let slot = 1; slot <= 16; slot++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot empty";
    btn.dataset.slot = slot;
    btn.innerHTML = `<span class="slot-dot"></span><span class="slot-name"></span><span class="slot-num">${slot}</span><span class="slot-count"></span>`;
    btn.addEventListener("click", () => selectSlot(slot));
    grid.append(btn);
  }
}

function renderInventory(status, enabled) {
  const items = new Map(itemsOf(status).map((item) => [item.slot, item]));
  let used = 0;
  let total = 0;
  for (const btn of $("#inv-grid").children) {
    const slot = Number(btn.dataset.slot);
    const item = items.get(slot);
    const color = item && itemColor(item.name);
    if (item) {
      used++;
      total += item.count;
    }
    btn.classList.toggle("empty", !item);
    btn.classList.toggle("selected", status.selected === slot);
    btn.classList.toggle("has-dot", Boolean(color));
    if (color) btn.style.setProperty("--item", color);
    btn.setAttribute("aria-pressed", String(status.selected === slot));
    btn.title = item ? `${item.name} × ${item.count}` : `Slot ${slot} (empty)`;
    btn.disabled = !enabled;
    $(".slot-name", btn).textContent = item ? prettyName(item.name) : "";
    $(".slot-count", btn).textContent = item ? item.count : "";
  }
  $("#inv-summary").textContent = `${used}/16 slots · ${fmt(total)} items`;
}

function selectSlot(slot) {
  const t = state.turtles.get(state.selected);
  if (!t?.status) return;
  t.status.selected = slot; // optimistic; the next status update confirms it
  renderInventory(t.status, true);
  command("select", { slot });
}

// Planned jobs -----------------------------------------------------------------------
// What a job would dig, worked out before it starts, so it can be shown in
// words and outlined on the maps.

const WORLD_STEP = { x: [0, 1, 0, -1], z: [-1, 0, 1, 0] }; // by compass direction
const LOCAL_STEP = { x: [0, 1, 0, -1], z: [1, 0, -1, 0] }; // by local heading

function localJobTab() {
  return $(".tab[data-tab][aria-selected=true]")?.dataset.tab ?? "quarry";
}

// The box a local job started now would dig, in the map's frame (world when
// GPS knows the facing, otherwise relative to where the turtle started).
function plannedLocalJob(t) {
  const me = mapPos(t);
  if (!me) return null;
  const tab = localJobTab();
  const form = $(`.job-form[data-job="${tab}"]`);
  // namedItem: a field called "length" would otherwise read the form's field count.
  const value = (name) => Number(form.elements.namedItem(name)?.value);
  const step = me.frame === "world" ? WORLD_STEP : LOCAL_STEP;
  const f = { x: step.x[me.dir], z: step.z[me.dir] };
  const r = { x: step.x[(me.dir + 1) % 4], z: step.z[(me.dir + 1) % 4] };
  if (tab === "quarry") {
    const [length, width, depth] = [value("length"), value("width"), value("depth")];
    if (!(length > 0 && width > 0 && depth > 0)) return null;
    return {
      frame: me.frame, tab, length, width, depth,
      x1: me.x, z1: me.z,
      x2: me.x + (length - 1) * f.x + (width - 1) * r.x,
      z2: me.z + (length - 1) * f.z + (width - 1) * r.z,
      yTop: me.y - 1, yBottom: me.y - depth,
    };
  }
  const length = value("length");
  if (!(length > 0)) return null;
  const height = value("height") || 2;
  return {
    frame: me.frame, tab, length, height,
    x1: me.x + f.x, z1: me.z + f.z, x2: me.x + length * f.x, z2: me.z + length * f.z,
    yTop: me.y + height - 1, yBottom: me.y,
  };
}

const span = (a, b) => (a === b ? `${a}` : `${Math.min(a, b)} to ${Math.max(a, b)}`);

function renderLocalPlan(t) {
  const s = t.status ?? {};
  const facing = s.facing;
  const right = facing && COMPASS[(COMPASS.indexOf(facing) + 1) % 4];
  for (const el of $$("[data-dir-label]")) {
    const dir = el.dataset.dirLabel === "forward" ? facing : right;
    el.textContent = capital(el.dataset.dirLabel) + (dir ? ` (${dir})` : "");
  }
  const plan = plannedLocalJob(t);
  const line = $(`.job-form[data-job="${localJobTab()}"] [data-plan]`);
  if (!plan) {
    line.textContent = "";
    return;
  }
  const where = plan.frame === "world"
    ? `X <b>${span(plan.x1, plan.x2)}</b>, Z <b>${span(plan.z1, plan.z2)}</b>, ` +
      (plan.yTop === plan.yBottom ? `Y <b>${plan.yTop}</b>` : `from Y <b>${plan.yTop}</b> down to <b>${plan.yBottom}</b>`)
    : null;
  line.innerHTML = plan.tab === "quarry"
    ? (where
      ? `Digs ${where}: ${plan.length} ${facing}, ${plan.width} ${right} and ${plan.depth} down, starting under the turtle. Stops early at bedrock.`
      : `Digs ${plan.length} forward, ${plan.width} to the right and ${plan.depth} down, starting under the turtle. Stops early at bedrock.`)
    : (where
      ? `Digs ${where}: ${plan.length} blocks ${facing}, ${plan.height} high.`
      : `Digs ${plan.length} blocks straight ahead, ${plan.height} high.`);
}

function stairEntrance(params) {
  if (params.routeMode === "southRow" || params.access === "southStairs" || params.homeRouteMode === "southStairs") {
    const home = params.routeHome ?? params.home;
    return worldPoint(home) ? { ...home, depth: home.y - params.y } : null;
  }
  const dir = typeof params.dir === "number" ? params.dir : COMPASS.indexOf(params.dir);
  if (![params.x, params.y, params.z, params.entryY].every(Number.isFinite) || dir < 0 || dir > 3 || params.entryY < params.y) return null;
  const depth = params.entryY - params.y;
  return {
    x: params.x - depth * WORLD_STEP.x[dir],
    y: params.entryY,
    z: params.z - depth * WORLD_STEP.z[dir],
    depth,
  };
}

function southRowPlan(turtles = pickedTurtles()) {
  return turtles.map((t) => ({ t, home: southRowHome(t) }));
}

// Matches fleet.js: the levels staggered tunnels can fully check.
const STAGGERED_LEVELS = { lowest: -58, highest: 64 };

function validLevels(p) {
  return Number.isInteger(p.yTop) && Number.isInteger(p.yBottom) && p.yBottom <= p.yTop &&
    p.yBottom >= STAGGERED_LEVELS.lowest && p.yTop <= STAGGERED_LEVELS.highest;
}

// About how many blocks the tunnels dig: a fifth of every block inside the
// turtles' circles, over the levels plus the one above and the one below.
function staggeredBlocks(p, homes) {
  const xs = homes.map((home) => home.x);
  let area = 0;
  for (let x = Math.min(...xs) - p.radius; x <= Math.max(...xs) + p.radius; x++) {
    const near = Math.min(...xs.map((hx) => Math.abs(x - hx)));
    if (near <= p.radius) area += 2 * Math.floor(Math.sqrt(p.radius ** 2 - near ** 2)) + 1;
  }
  return (area * (p.yTop - p.yBottom + 3)) / 5;
}

function plannedFleetJob() {
  const { kind, params: p } = fleetParams();
  if (kind === "areaQuarry") {
    if ([p.x1, p.z1, p.x2, p.z2].some((v) => v == null)) return [];
    return [{ x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2, label: `Planned quarry, Y ${span(p.yTop ?? "?", p.yBottom ?? "?")}` }];
  }
  if (!Number.isInteger(p.radius) || p.radius < 1 || p.radius > 1024) return [];
  // Staggered tunnels run through each turtle's whole circle.
  const levels = validLevels(p) ? `, staggered tunnels checking Y ${span(p.yTop, p.yBottom)}` : "";
  return southRowPlan().flatMap(({ t, home }) => home ? [{
    x1: home.x - p.radius, z1: home.z - p.radius, x2: home.x + p.radius, z2: home.z + p.radius,
    circle: { x: home.x, z: home.z, radius: p.radius }, label: `${nameOf(t)}: mining radius ${p.radius} blocks from saved home${levels}`,
  }] : []);
}

// 3D map ---------------------------------------------------------------------------
// three.js is only loaded the first time the 3D map is opened.

let world = null;
let worldLoading = null;

function ensureWorld() {
  if (worldLoading) return;
  worldLoading = import("./world.js")
    .then(({ createWorld }) => {
      world = createWorld($("#map3d"), {
        onSelect: (id) => select(id),
        onFollowChange: (on) => $("#map3d-follow").setAttribute("aria-pressed", String(on)),
        onOpen: (id) => {
          select(id);
          setView("turtles");
        },
        nameOf: (id) => {
          const t = state.turtles.get(id);
          return t ? nameOf(t) : `turtle #${id}`;
        },
      });
      $("#map3d-note").hidden = true;
      applyMapOptions();
      sendRaw({ type: "mined" });
      invalidate("map");
    })
    .catch((err) => {
      console.error(err);
      $("#map3d-note").textContent =
        "The 3D map couldn't load. It needs WebGL, and access to cdn.jsdelivr.net for its 3D library.";
    });
}

function applyMapOptions() {
  world?.setOptions({
    oresOnly: $("#map3d-ores").checked,
    areas: $("#map3d-areas").checked,
    jobs: $("#map3d-jobs").checked,
    names: $("#map3d-names").checked,
  });
}

function renderWorld() {
  if (!world) return;
  const list = sortedTurtles().map((t) => {
    const st = turtleState(t);
    const s = t.status ?? {};
    return {
      id: t.id, name: nameOf(t), state: st.key, stateLabel: st.label,
      world: s.world ?? null, facing: s.facing ?? (s.southRowSupported && onSouthRow(s.world) ? "south" : undefined),
      home: s.miningRoute?.home ?? s.homeWorld, route: s.miningRoute, job: s.fleetJob?.args,
    };
  });
  world.update(list, state.fleet, state.selected);
  const { mined, ores } = world.stats();
  const unplaced = list.filter((t) => !t.world).length;
  $("#map3d-stats").textContent =
    `${fmt(mined)} blocks mined, ${fmt(ores)} of them ores.` +
    (unplaced ? ` ${unplaced} turtle${unplaced === 1 ? " isn't" : "s aren't"} shown: GPS doesn't know where yet.` : "") +
    " ";
}

// Map ----------------------------------------------------------------------------

function recordTrail(t) {
  const p = mapPos(t);
  if (!p) return;
  let trail = state.trails.get(t.id);
  if (!trail || trail.frame !== p.frame) state.trails.set(t.id, (trail = { frame: p.frame, points: [] }));
  const points = trail.points;
  const last = points.at(-1);
  if (last && last.x === p.x && last.z === p.z) return;
  // A big jump means the position was reset or recalibrated; don't draw a line across it.
  if (last && Math.abs(last.x - p.x) + Math.abs(last.z - p.z) > 6) points.length = 0;
  points.push({ x: p.x, z: p.z });
  if (points.length > MAX_TRAIL) points.shift();
}

function arrow(cls, x, y, dir, size) {
  const k = size / 10;
  return `<path class="${cls}" transform="translate(${x} ${y}) rotate(${(Number(dir) || 0) * 90}) scale(${k})" d="M0 -10 L8 8 L0 4 L-8 8 Z"/>`;
}

// A square view fitted around the given points, with world (north-up) or
// local (start-direction-up) orientation.
function viewport(points, size, world, minSpan = 10) {
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const span = Math.max(maxX - minX, maxZ - minZ, minSpan) * 1.15 + 4;
  const scale = size / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const v = {
    size, span, scale, cx, cz,
    sx: (x) => +(size / 2 + (x - cx) * scale).toFixed(1),
    sy: (z) => +(size / 2 + (world ? 1 : -1) * (z - cz) * scale).toFixed(1),
    inView: (p) => Math.abs(p.x - cx) <= span / 2 && Math.abs(p.z - cz) <= span / 2,
  };
  v.step = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000].find((n) => n * scale >= 18) ?? 10000;
  return v;
}

function gridLines(v) {
  let out = "";
  const { size, span, cx, cz, step } = v;
  for (let x = Math.ceil((cx - span / 2) / step) * step; x <= cx + span / 2; x += step) {
    out += `<line class="grid-line" x1="${v.sx(x)}" x2="${v.sx(x)}" y1="0" y2="${size}"/>`;
  }
  for (let z = Math.ceil((cz - span / 2) / step) * step; z <= cz + span / 2; z += step) {
    out += `<line class="grid-line" y1="${v.sy(z)}" y2="${v.sy(z)}" x1="0" x2="${size}"/>`;
  }
  return out;
}

// World-space rectangle (inclusive block coordinates) as an SVG rect.
function rect(v, x1, z1, x2, z2, cls, title) {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2) + 1];
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2) + 1];
  const left = v.sx(ax - 0.5);
  const top = v.sy(az - 0.5);
  const w = Math.max(2, v.sx(bx - 0.5) - left);
  const h = Math.max(2, v.sy(bz - 0.5) - top);
  return `<rect class="${cls}" x="${left}" y="${top}" width="${w}" height="${h}"><title>${escapeXml(title)}</title></rect>`;
}

function miningRadius(args) {
  return args?.kind === "branchMine" && Number.isInteger(args.radius) && args.radius >= 1 && worldPoint(args.routeHome)
    ? { x: args.routeHome.x, z: args.routeHome.z, radius: args.radius } : null;
}

function drawMiningRadius(v, circle, title) {
  return `<circle class="radius-area" cx="${v.sx(circle.x)}" cy="${v.sy(circle.z)}" r="${circle.radius * v.scale}"><title>${escapeXml(title)}</title></circle>`;
}

function renderMap(t) {
  const svg = $("#map");
  const size = 240;
  const fleet = state.mapMode === "fleet";
  const me = mapPos(t);
  const mine = me && (!fleet || me.frame === "world") ? me : null;
  const world = fleet || me?.frame === "world";
  const others = world
    ? sortedTurtles()
        .filter((o) => o.id !== t.id)
        .map((o) => ({ t: o, p: mapPos(o) }))
        .filter((o) => o.p?.frame === "world")
    : [];
  renderLegend(fleet, world);

  if (!mine && !(fleet && others.length)) {
    const note = fleet ? "No GPS positions yet" : "No position yet";
    svg.innerHTML = `<text class="map-note" x="120" y="124" text-anchor="middle">${note}</text>`;
    return;
  }

  const trail = mine ? (state.trails.get(t.id)?.points ?? []) : [];
  const plan = !fleet && t.online && !t.status?.job ? plannedLocalJob(t) : null;
  const fit = fleet ? [...others.map((o) => o.p), mine] : [...trail, mine, mine.home];
  const radius = world ? miningRadius(t.status?.fleetJob?.args) : null;
  if (radius) fit.push({ x: radius.x - radius.radius, z: radius.z - radius.radius }, { x: radius.x + radius.radius, z: radius.z + radius.radius });
  if (plan) fit.push({ x: plan.x1, z: plan.z1 }, { x: plan.x2, z: plan.z2 });
  const v = viewport(fit.filter(Boolean), size, world);
  let out = gridLines(v);
  if (radius) {
    out += drawMiningRadius(v, radius, `Mining radius ${radius.radius} blocks from saved home`);
    const a = t.status.fleetJob.args;
    out += rect(v, a.x, a.z, a.x, a.z + a.length - 1, "job-area", `Mining lane at Y ${a.y}`);
  }
  if (plan) out += rect(v, plan.x1, plan.z1, plan.x2, plan.z2, "plan", `Planned ${plan.tab}`);

  if (trail.length > 1) {
    out += `<polyline class="trail" points="${trail.map((p) => `${v.sx(p.x)},${v.sy(p.z)}`).join(" ")}"/>`;
  }

  if (mine?.home && !fleet) {
    const h = mine.home;
    const r = Math.max(5, Math.min(9, v.scale * 0.45));
    out += `<rect class="home" x="${v.sx(h.x) - r}" y="${v.sy(h.z) - r}" width="${2 * r}" height="${2 * r}" rx="2">
      <title>Home: ${[h.x, h.y, h.z].join(", ")}</title></rect>`;
  }

  // Other turtles: status-colored and clickable in fleet view, faint context otherwise.
  for (const { t: o, p } of others) {
    if (!v.inView(p)) continue;
    const st = turtleState(o);
    const title = `<title>${escapeXml(nameOf(o))} · ${st.label} · ${p.x}, ${p.y}, ${p.z}</title>`;
    out += fleet
      ? `<g class="pick-mark" data-id="${o.id}">${arrow(`mark mark-${st.key}`, v.sx(p.x), v.sy(p.z), p.dir, 7)}${title}</g>`
      : `<g class="pick-mark" data-id="${o.id}"><circle class="other" cx="${v.sx(p.x)}" cy="${v.sy(p.z)}" r="3.5"/>${title}</g>`;
  }

  if (mine) {
    const st = turtleState(t);
    const [x, y] = [v.sx(mine.x), v.sy(mine.z)];
    const facing = mine.frame === "world" ? capital(COMPASS[mine.dir] ?? "?") : FACING[mine.dir];
    if (fleet) out += `<circle class="selected-ring" cx="${x}" cy="${y}" r="13"/>`;
    out += `<g>${arrow(fleet ? `mark mark-${st.key}` : "turtle-mark", x, y, mine.dir, 10)}
      <title>${escapeXml(nameOf(t))}: ${mine.x}, ${mine.y}, ${mine.z} facing ${facing}</title></g>`;
    if (fleet) {
      const anchor = x > size - 70 ? "end" : "start";
      out += `<text class="map-label" x="${x + (anchor === "end" ? -16 : 16)}" y="${y + 4}" text-anchor="${anchor}">${escapeXml(nameOf(t))}</text>`;
    }
  }

  out += `<text class="compass" x="${size - 8}" y="16" text-anchor="end">${world ? "N ↑" : "↑ start direction"}</text>`;
  out += `<text class="scale" x="8" y="${size - 8}">Grid: ${fmt(v.step)} block${v.step === 1 ? "" : "s"}</text>`;
  svg.innerHTML = out;
}

function renderLegend(fleet, world) {
  const key = fleet ? "fleet" : world ? "world" : "local";
  const legend = $("#map-legend");
  if (legend.dataset.key === key) return;
  legend.dataset.key = key;
  legend.innerHTML = fleet
    ? Object.entries(STATE_LABELS)
        .map(([k, label]) => `<li><span class="key key-mark mark-${k}"></span>${label}</li>`)
        .join("") + `<li><span class="key key-ring"></span>Selected</li>`
    : `<li><span class="key key-turtle"></span>Turtle</li>
       <li><span class="key key-home"></span>Home</li>
       <li><span class="key key-trail"></span>Path</li>` +
      (world ? `<li><span class="key key-other"></span>Other turtles</li>` : "");
}

// Log ----------------------------------------------------------------------------

function logItem(entry) {
  const li = document.createElement("li");
  li.className = `log-${entry.level}`;
  const time = document.createElement("time");
  time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const msg = document.createElement("span");
  msg.textContent = entry.msg;
  li.append(time, msg);
  return li;
}

function renderLog(t) {
  const log = $("#log");
  log.replaceChildren(...t.logs.map(logItem));
  if (!t.logs.length) {
    const li = document.createElement("li");
    li.className = "log-empty";
    li.textContent = "Nothing logged yet.";
    log.append(li);
  }
  log.scrollTop = log.scrollHeight;
}

function appendLog(entry) {
  const log = $("#log");
  $(".log-empty", log)?.remove();
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 12;
  log.append(logItem(entry));
  while (log.children.length > MAX_LOGS) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// Fleet page --------------------------------------------------------------------

function jobBox(args) {
  if (args?.kind === "areaQuarry") return { x1: args.x1, z1: args.z1, x2: args.x2, z2: args.z2 };
  if (args?.kind === "branchMine") {
    const entrance = ["stairs", "southStairs"].includes(args.access) || args.routeMode === "southRow" ? stairEntrance(args) : null;
    if (args.veinBounds) {
      const bounds = args.veinBounds;
      return entrance ? {
        ...bounds,
        x1: Math.min(bounds.x1, entrance.x), z1: Math.min(bounds.z1, entrance.z),
        x2: Math.max(bounds.x2, entrance.x), z2: Math.max(bounds.z2, entrance.z),
      } : bounds;
    }
    const d = COMPASS.indexOf(args.dir);
    const dir = d >= 0 ? d : Number(args.dir) || 0;
    const ex = args.x + (args.length - 1) * [0, 1, 0, -1][dir];
    const ez = args.z + (args.length - 1) * [-1, 0, 1, 0][dir];
    return { x1: entrance?.x ?? args.x, z1: entrance?.z ?? args.z, x2: ex, z2: ez };
  }
  return null;
}

function renderFleet() {
  const turtles = sortedTurtles();
  const f = state.fleet ?? {};
  const states = turtles.map(turtleState);
  const count = (key) => states.filter((s) => s.key === key).length;
  $("#fleet-summary").textContent = turtles.length
    ? [
        `${turtles.length} turtles`,
        `${turtles.length - count("offline")} online`,
        `${count("working")} working`,
        count("paused") && `${count("paused")} paused`,
        count("attention") && `${count("attention")} need attention`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No turtles yet";

  renderFleetWarnings(turtles, f);
  renderPicker(turtles);
  renderFleetPreview();
  renderJobQueue();
  renderDepotStatus();
  renderJobOres(turtles);
  renderFleetMap(turtles, f);

  const sel = currentTurtle();
  const selName = sel ? nameOf(sel) : null;
  for (const btn of $$("[data-use-pos]")) {
    btn.disabled = !sel?.status?.world;
    btn.title = sel ? `Use ${selName}'s position` : "Select a turtle in the list first";
  }
  $("#btn-dock-here").disabled = !sel?.status?.world;
  $("#btn-dock-here").textContent = selName ? `Dock at ${selName}'s position` : "Dock at selected turtle";
  $("#btn-release-dock").disabled = state.depot.holder == null;
}

// "minecraft:deepslate_diamond_ore" and "minecraft:diamond_ore" are both diamond.
function mineralName(block) {
  const name = String(block).replace(/^.*:/, "").replace(/^deepslate_/, "").replace(/_ore$/, "").replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Ore blocks mined by each fleet job, added up across its turtles. A running
// job counts as it goes; a finished one keeps its total in the receipt.
function renderJobOres(turtles) {
  const jobs = new Map();
  for (const t of turtles) {
    const s = t.status ?? {};
    const run = s.fleetJob;
    const done = !run && s.lastFleetResult?.ores ? s.lastFleetResult : null;
    if (!run && !done) continue;
    // Jobs started before job IDs: queued ones share their queue entry.
    const key = run ? run.args?.jobId ?? run.queueId?.split(":")[0] ?? "current" : done.jobId ?? done.id?.split(":")[0] ?? "last";
    const job = jobs.get(key) ?? { id: run?.args?.jobId, args: run?.args, turtles: [], running: 0, ores: new Map() };
    jobs.set(key, job);
    job.args ??= run?.args;
    job.turtles.push(nameOf(t));
    if (run) job.running++;
    for (const [block, n] of Object.entries((run ?? done).ores ?? {})) {
      const mineral = mineralName(block);
      job.ores.set(mineral, (job.ores.get(mineral) ?? 0) + (Number(n) || 0));
    }
  }
  const box = $("#job-ores");
  if (!jobs.size) {
    box.innerHTML = `<p class="hint flush">Ore the turtles mine on a fleet job is added up here as they go.</p>`;
    return;
  }
  box.innerHTML = [...jobs.values()].map((job) => {
    const a = job.args;
    const where = a?.pattern === "staggered" ? `Y ${a.yTop} to ${a.yBottom}` : a?.kind === "areaQuarry" ? `Y ${a.yTop} to ${a.yBottom}` : a ? `Y ${a.y}` : "Finished job";
    const n = job.turtles.length;
    const head = `${KIND_NAMES[a?.kind] ?? "Fleet job"} · ${where} · ${n} turtle${n === 1 ? "" : "s"}${job.running ? "" : " · finished"}`;
    const rows = [...job.ores].sort((p, q) => q[1] - p[1]);
    const total = rows.reduce((sum, [, n]) => sum + n, 0);
    // A running staggered job can take more turtles: the ones picked above.
    const join = job.running && job.id && a?.pattern === "staggered"
      ? `<button type="button" class="btn sm" data-join-job="${escapeXml(job.id)}" title="Add the turtles picked in the fleet list to this job. Each takes some columns of a busy turtle on it.">Add picked turtles</button>`
      : "";
    return `<div class="ore-job"><div class="ore-head"><h3 title="${escapeXml(job.turtles.join(", "))}">${escapeXml(head)}</h3>${join}</div>` + (rows.length
      ? `<ul class="ore-list">${rows.map(([name, n]) => `<li><span>${escapeXml(name)}</span><b>${fmt(n)}</b></li>`).join("")}</ul>` +
        `<p class="hint flush">${fmt(total)} ore block${total === 1 ? "" : "s"} in all. Counting starts once turtles run script 2.2.8.</p>`
      : `<p class="hint flush">No ore yet. Counting starts once turtles run script 2.2.8.</p>`) + "</div>";
  }).join("");
}

function renderFleetWarnings(turtles, f) {
  const notes = [];
  if (!f.depot) notes.push("Set up the depot below before starting fleet jobs.");
  else if (f.depot.y !== 67) notes.push("Home-row mining needs the shared depot at Y 67. Change Dock Y in Fleet settings.");
  const old = turtles.filter((t) => t.online && t.version && olderVersion(t.version, SCRIPT_VERSION));
  if (old.length) notes.push(`${old.length} turtle${old.length === 1 ? " runs" : "s run"} an older script. Use Update all scripts.`);
  const byHome = new Map();
  for (const t of turtles) {
    const h = t.status?.homeWorld;
    if (!h) continue;
    const key = `${h.x},${h.y},${h.z}`;
    byHome.set(key, [...(byHome.get(key) ?? []), nameOf(t)]);
  }
  for (const [key, names] of byHome) {
    if (names.length > 1) notes.push(`${names.join(", ")} share a home at ${key.replaceAll(",", ", ")}. Give each its own with Set home.`);
  }
  const el = $("#fleet-warnings");
  el.hidden = !notes.length;
  el.replaceChildren(...notes.map((n) => Object.assign(document.createElement("div"), { textContent: n })));
}

function renderPicker(turtles) {
  const box = $("#picker");
  const existing = new Map([...box.children].map((el) => [Number(el.dataset.id), el]));
  turtles.forEach((t, i) => {
    let el = existing.get(t.id);
    existing.delete(t.id);
    if (!el) {
      el = document.createElement("label");
      el.className = "pick";
      el.dataset.id = t.id;
      el.innerHTML = `<input type="checkbox"><span class="status-dot"></span><span class="pick-name"></span>`;
      $("input", el).addEventListener("change", (e) => {
        if (e.target.checked) state.picked.add(t.id);
        else state.picked.delete(t.id);
        renderFleetPreview();
        invalidate("fleet");
      });
    }
    const st = turtleState(t);
    const reason = notQueueReady(t);
    const busy = !reason && Boolean(notReady(t));
    el.classList.toggle("unready", Boolean(reason));
    el.style.setProperty("--tone", `var(--${{ working: "accent", paused: "ink-2", attention: "warning", idle: "good", offline: "muted" }[st.key]})`);
    $(".status-dot", el).innerHTML = ICONS[st.key];
    $(".pick-name", el).textContent = nameOf(t);
    el.title = `${nameOf(t)}: ${st.label}${reason ? ` (${reason})` : busy ? " (can join the mining queue)" : " (ready now)"}`;
    $("input", el).checked = state.picked.has(t.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
  });
  for (const el of existing.values()) el.remove();
}

function pickedTurtles() {
  return [...state.picked].map((id) => state.turtles.get(id)).filter(Boolean);
}

function fleetTab() {
  return $(".tab[data-fleet-tab][aria-selected=true]")?.dataset.fleetTab ?? "branchMine";
}

function fleetParams() {
  const kind = fleetTab();
  const form = $("#fleet-job-form");
  if (kind === "branchMine") {
    const number = (name) => {
      const value = form.elements.namedItem(name).value;
      return value === "" ? null : Number(value);
    };
    return {
      kind,
      params: {
        routeMode: "southRow", pattern: "staggered", radius: number("radius"),
        yTop: number("levelTop"), yBottom: number("levelBottom"), peak: number("levelPeak"),
      },
    };
  }
  const params = {};
  for (const el of $$(`[data-kind="${kind}"] [name]`, form)) {
    if (el.name === "preset" || el.name === "bottomPreset") continue;
    params[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value;
  }
  return { kind, params };
}

function renderFleetPreview() {
  const picked = pickedTurtles();
  const ready = picked.filter((t) => !notReady(t));
  const queueable = picked;
  $("#picker-count").textContent = `${picked.length} picked · ${ready.length} ready now`;
  const { kind, params: p } = fleetParams();
  const routes = kind === "branchMine" ? southRowPlan() : [];
  let text = "";
  if (!queueable.length) {
    text = "Pick turtles for the job. The mining queue waits for their GPS connection and current work.";
  } else if (kind === "branchMine") {
    const missing = routes.filter((row) => !row.home);
    if (missing.length) {
      text = `Waiting for saved homes for ${missing.map((row) => nameOf(row.t)).join(", ")}.`;
    } else if (validLevels(p) && Number.isInteger(p.radius) && p.radius >= 1 && p.radius <= 1024) {
      const n = queueable.length;
      const levels = p.yTop === p.yBottom ? `Y ${p.yTop}` : `Y ${p.yTop} to ${p.yBottom}`;
      const start = Number.isInteger(p.peak) ? `, starting at Y ${Math.max(p.yBottom - 1, Math.min(p.yTop + 1, p.peak))}` : "";
      const blocks = staggeredBlocks(p, routes.map((row) => row.home));
      text = `${n} turtle${n === 1 ? "" : "s"} · ${levels} · ${p.radius}-block radius. ` +
        `Staggered tunnels run through every turtle's whole circle${start}, checking every block in these levels: ` +
        `about ${fmt(blocks)} blocks to dig (${fmt(blocks / n)} per turtle). Stairs switch back if the radius is smaller than the depth.`;
    } else {
      text = `Choose top and bottom levels from Y ${STAGGERED_LEVELS.lowest} to ${STAGGERED_LEVELS.highest} and a radius from 1 to 1024 blocks.`;
    }
  } else if ([p.x1, p.z1, p.x2, p.z2, p.yTop, p.yBottom].every((v) => v != null)) {
    const w = Math.abs(p.x2 - p.x1) + 1;
    const l = Math.abs(p.z2 - p.z1) + 1;
    const h = Math.abs(p.yTop - p.yBottom) + 1;
    const strips = Math.min(queueable.length, Math.max(w, l));
    text = `Digs X ${span(p.x1, p.x2)}, Z ${span(p.z1, p.z2)}, from Y ${Math.max(p.yTop, p.yBottom)} down to Y ${Math.min(p.yTop, p.yBottom)}: ` +
      `${w} × ${l} × ${h} (${fmt(w * l * h)} blocks), split into ${strips} strip${strips === 1 ? "" : "s"}. Outlined on the map.`;
  } else {
    text = "Set both corners (stand a turtle on each and click At turtle) and the top and bottom Y.";
  }
  const busy = picked.filter((t) => !notQueueReady(t) && notReady(t)).length;
  if (busy) text += ` ${busy} picked turtle${busy === 1 ? " is" : "s are"} busy; queue the job to wait for them.`;
  const unavailable = picked.filter(notQueueReady).length;
  if (unavailable) text += ` ${unavailable} picked turtle${unavailable === 1 ? " needs" : "s need"} a current script and a known home-row GPS position.`;
  $("#fleet-job-preview").textContent = text;
  if (!$("#bulk-rename").hidden) renderBulkRenamePreview();
}

function updateQueueControls() {
  for (const button of $$("[data-queue-mutation]")) {
    button.disabled = !state.connected || !state.queueReady;
  }
}

function queuedJobLocation(job) {
  const p = job.params ?? {};
  if (job.kind === "branchMine") {
    if (p.pattern === "staggered") return `Staggered tunnels · Y ${span(p.yTop, p.yBottom)} · Radius ${p.radius} blocks`;
    if (Number.isInteger(p.radius)) return `Y ${p.y} · Radius ${p.radius} blocks`;
    if (p.routeMode === "southRow") return `Y ${p.y} · Previous mining settings`;
    const entrance = stairEntrance(p);
    return `Bottom X ${p.x}, Y ${p.y}, Z ${p.z} · ${p.dir} · ${p.length} blocks` +
      (entrance ? ` · Stair entrance ${entrance.x}, ${entrance.y}, ${entrance.z}` : "") +
      (["queued", "blocked"].includes(job.state) ? " · Legacy route: cancel and recreate for home-row mining" : "");
  }
  if (job.kind === "areaQuarry") {
    return `X ${span(p.x1, p.x2)}, Z ${span(p.z1, p.z2)} · Y ${span(p.yTop, p.yBottom)}`;
  }
  return "";
}

function renderJobQueue() {
  const { paused, jobs = [], error } = state.jobQueue ?? {};
  const counts = Object.fromEntries(Object.keys(QUEUE_LABELS).map((key) => [key, jobs.filter((job) => job.state === key).length]));
  const summary = [paused ? "Queue paused" : "Automatic dispatch on"];
  if (counts.queued) summary.push(`${counts.queued} waiting`);
  if (counts.running) summary.push(`${counts.running} running`);
  if (counts.blocked) summary.push(`${counts.blocked} blocked`);
  if (counts.completed) summary.push(`${counts.completed} completed`);
  if (counts.cancelled) summary.push(`${counts.cancelled} cancelled`);
  $("#job-queue-summary").textContent = state.queueReady ? summary.join(" · ") : "Waiting for server…";
  $("#job-queue-error").textContent = error ?? "";
  $("#job-queue-error").hidden = !error;
  $("#btn-pause-queue").textContent = paused ? "Resume queue" : "Pause queue";
  $("#btn-pause-queue").setAttribute("aria-pressed", String(Boolean(paused)));
  $("#job-queue-empty").hidden = jobs.length > 0;

  const list = $("#job-queue-list");
  const existing = new Map([...list.children].map((el) => [el.dataset.id, el]));
  jobs.forEach((job, index) => {
    const key = String(job.id);
    let el = existing.get(key);
    existing.delete(key);
    if (!el) {
      el = document.createElement("li");
      el.className = "queued-job";
      el.dataset.id = key;
      el.innerHTML = '<div class="queued-job-head"><h3></h3><span class="queue-state"></span></div><p class="queued-job-location"></p><p class="queued-job-progress"></p><p class="queued-job-message"></p><button type="button" class="btn ghost sm" data-queue-mutation data-cancel-job>Cancel</button>';
    }
    const knownState = Object.hasOwn(QUEUE_LABELS, job.state) ? job.state : "queued";
    const assignments = job.assignments ?? [];
    const turtleCount = job.ids?.length ?? assignments.length;
    const done = assignments.filter((assignment) => assignment.done).length;
    const active = ["queued", "running", "blocked"].includes(job.state);
    $("h3", el).textContent = KIND_NAMES[job.kind] ?? "Fleet job";
    const badge = $(".queue-state", el);
    badge.dataset.state = knownState;
    badge.textContent = QUEUE_LABELS[knownState];
    $(".queued-job-location", el).textContent = queuedJobLocation(job);
    $(".queued-job-progress", el).textContent = `${turtleCount} turtle${turtleCount === 1 ? "" : "s"}` +
      (assignments.length ? ` · ${done} of ${assignments.length} assignments finished` : active ? " · Waiting for assignment" : "");
    const fallback = job.state === "queued"
      ? paused ? "Waiting for the queue to resume." : "Waiting for earlier jobs and all selected turtles to be idle."
      : job.state === "running" ? "Waiting for every assigned turtle to finish."
      : job.state === "blocked" ? "Needs attention. Check the assigned turtles or cancel this job."
      : "";
    const message = $(".queued-job-message", el);
    message.textContent = job.message || fallback;
    message.hidden = !message.textContent;
    const cancel = $("[data-cancel-job]", el);
    cancel.dataset.cancelJob = key;
    cancel.hidden = !active;
    cancel.setAttribute("aria-label", `Cancel ${KIND_NAMES[job.kind] ?? "fleet job"} at position ${index + 1}`);
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null);
  });
  for (const el of existing.values()) el.remove();
  updateQueueControls();
}

// How turtles get into the dock, from the sides picked in the form.
function renderDockApproach() {
  const side = (field) => $(`[data-field="depot.${field}"]`).value;
  const used = new Set([side("junk"), side("valuables"), side("fuel")]);
  const open = Object.keys(SIDES).filter((s) => !used.has(s)).map((s) => SIDES[s].toLowerCase());
  $("#dock-approach").textContent = used.size < 3
    ? "Each chest needs its own side of the dock."
    : `Turtles come into the dock from any open side (${open.join(", ")}) and wait their turn 3 to 5 blocks away, so leave some open space around it. A room 3 or 4 blocks high is plenty; no open sky needed.`;
}

function renderDepotStatus() {
  const { holder, queue = [] } = state.depot;
  const name = (id) => {
    const t = state.turtles.get(id);
    return t ? nameOf(t) + (t.online ? "" : " (offline)") : `#${id}`;
  };
  $("#depot-status").textContent = !state.fleet?.depot
    ? "Not set up"
    : holder == null
      ? queue.length ? `${queue.length} waiting` : "Dock free"
      : `In use by ${name(holder)}` + (queue.length ? ` · ${queue.length} waiting` : "");
}

function renderFleetMap(turtles, f) {
  const svg = $("#fleet-map");
  const size = 400;
  const items = turtles.map((t) => ({ t, p: mapPos(t) })).filter((o) => o.p?.frame === "world");
  const jobs = turtles.map((t) => ({ t, box: jobBox(t.status?.fleetJob?.args) })).filter((j) => j.box);
  const radii = jobs.map(({ t }) => ({ t, circle: miningRadius(t.status.fleetJob.args) })).filter((r) => r.circle);
  const savedRoutes = turtles.map((t) => {
    const r = t.status?.miningRoute;
    const a = t.status?.fleetJob?.args;
    return {
      t, home: worldPoint(r?.home) ? r.home : null,
      bottom: (r?.bottomSaved || r?.stair?.complete) && worldPoint(r?.bottom) ? r.bottom : null,
      lane: (a?.routeMode === "southRow" || a?.access === "southStairs") && [a.x, a.y, a.z].every(Number.isFinite) ? { x: a.x, y: a.y, z: a.z } : null,
    };
  }).filter((route) => route.home);
  const areas = f.protect?.areas ?? [];
  const pts = [
    ...items.map((o) => o.p),
    ...jobs.flatMap(({ box }) => [{ x: box.x1, z: box.z1 }, { x: box.x2, z: box.z2 }]),
    ...savedRoutes.flatMap((route) => [route.home, route.bottom, route.lane].filter(Boolean)),
    ...radii.flatMap(({ circle: c }) => [{ x: c.x - c.radius, z: c.z - c.radius }, { x: c.x + c.radius, z: c.z + c.radius }]),
  ];
  if (f.depot) pts.push(f.depot);
  const plans = state.view === "fleet" ? plannedFleetJob() : [];
  for (const p of plans) pts.push({ x: p.x1, z: p.z1 }, { x: p.x2, z: p.z2 });
  // The map frames the fleet. A protected area far away (say, around a base)
  // would shrink everything else to a corner, so only nearby ones join in.
  let offMap = 0;
  if (pts.length) {
    const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const margin = Math.max(32, Math.max(maxX - minX, maxZ - minZ) / 2);
    for (const a of areas) {
      const near = Math.max(a.x1, a.x2) >= minX - margin && Math.min(a.x1, a.x2) <= maxX + margin &&
        Math.max(a.z1, a.z2) >= minZ - margin && Math.min(a.z1, a.z2) <= maxZ + margin;
      if (near) pts.push({ x: a.x1, z: a.z1 }, { x: a.x2, z: a.z2 });
      else offMap++;
    }
  } else {
    for (const a of areas) pts.push({ x: a.x1, z: a.z1 }, { x: a.x2, z: a.z2 });
  }
  if (!pts.length) {
    svg.innerHTML = `<text class="map-note" x="200" y="204" text-anchor="middle">Turtles appear here once GPS knows where they are</text>`;
    return;
  }
  const v = viewport(pts, size, true, 16);
  let out = gridLines(v);
  for (const a of areas) {
    out += rect(v, a.x1, a.z1, a.x2, a.z2, "area", `Protected: ${a.name || "unnamed"} (Y ${a.y1} to ${a.y2})`);
    out += `<text class="area-label" x="${v.sx(Math.min(a.x1, a.x2) - 0.5)}" y="${v.sy(Math.min(a.z1, a.z2) - 0.5) - 4}">${escapeXml(a.name || "")}</text>`;
  }
  for (const p of plans) {
    out += p.circle ? drawMiningRadius(v, p.circle, p.label) : p.stairs || p.assembly
      ? `<line class="${p.assembly ? "route-assembly" : "plan-stairs"}" x1="${v.sx(p.x1)}" y1="${v.sy(p.z1)}" x2="${v.sx(p.x2)}" y2="${v.sy(p.z2)}"><title>${escapeXml(p.label)}</title></line>`
      : rect(v, p.x1, p.z1, p.x2, p.z2, "plan", p.label);
  }
  for (const { t, circle } of radii) out += drawMiningRadius(v, circle, `${nameOf(t)}: mining radius ${circle.radius} blocks from saved home`);
  for (const { t, box } of jobs) {
    const a = t.status.fleetJob.args;
    out += miningRadius(a) && a.pattern !== "staggered"
      ? rect(v, a.x, a.z, a.x, a.z + a.length - 1, "job-area", `${nameOf(t)}: mining lane at Y ${a.y}`)
      : rect(v, box.x1, box.z1, box.x2, box.z2, "job-area", `${nameOf(t)}: ${KIND_NAMES[a.kind]} (${a.kind === "branchMine" && a.pattern !== "staggered" ? `Y ${a.y}` : `Y ${a.yTop} to ${a.yBottom}`})`);
  }
  for (const { t, home, bottom, lane } of savedRoutes) {
    if (bottom) {
      out += `<line class="saved-stairs" x1="${v.sx(home.x)}" y1="${v.sy(home.z)}" x2="${v.sx(bottom.x)}" y2="${v.sy(bottom.z)}"><title>${escapeXml(nameOf(t))}: saved south staircase</title></line>`;
      if (lane) out += `<line class="route-assembly" x1="${v.sx(bottom.x)}" y1="${v.sy(bottom.z)}" x2="${v.sx(lane.x)}" y2="${v.sy(lane.z)}"><title>${escapeXml(nameOf(t))}: bottom to assigned lane</title></line>`;
      out += `<circle class="route-bottom" cx="${v.sx(bottom.x)}" cy="${v.sy(bottom.z)}" r="3.5"><title>${escapeXml(nameOf(t))}: saved stair bottom ${bottom.x}, ${bottom.y}, ${bottom.z}</title></circle>`;
    }
    out += `<rect class="route-home" x="${v.sx(home.x) - 3.5}" y="${v.sy(home.z) - 3.5}" width="7" height="7"><title>${escapeXml(nameOf(t))}: home ${home.x}, ${home.y}, ${home.z}, facing south</title></rect>`;
  }
  if (f.depot) {
    const [x, y] = [v.sx(f.depot.x), v.sy(f.depot.z)];
    out += `<g><rect class="depot-mark" x="${x - 7}" y="${y - 7}" width="14" height="14" rx="2"/><text class="depot-label" x="${x}" y="${y + 3}" text-anchor="middle">D</text>
      <title>Depot dock: ${f.depot.x}, ${f.depot.y}, ${f.depot.z}</title></g>`;
  }
  for (const { t, p } of items) {
    const st = turtleState(t);
    const selected = t.id === state.selected;
    if (selected) out += `<circle class="selected-ring" cx="${v.sx(p.x)}" cy="${v.sy(p.z)}" r="11"/>`;
    out += `<g class="pick-mark" data-id="${t.id}">${arrow(`mark mark-${st.key}`, v.sx(p.x), v.sy(p.z), p.dir, selected ? 9 : 7)}
      <title>${escapeXml(nameOf(t))} · ${st.label} · ${p.x}, ${p.y}, ${p.z}</title></g>`;
  }
  out += `<text class="compass" x="${size - 8}" y="16" text-anchor="end">N ↑</text>`;
  out += `<text class="scale" x="8" y="${size - 8}">Grid: ${fmt(v.step)} block${v.step === 1 ? "" : "s"}</text>`;
  if (offMap) out += `<text class="scale" x="8" y="16">${offMap} protected area${offMap === 1 ? "" : "s"} far away, off this map</text>`;
  svg.innerHTML = out;
}

// Fleet settings form ------------------------------------------------------------

function setFleet(fleet) {
  if (!fleet) return;
  state.fleet = fleet;
  if (!state.fleetDirty) fillFleetForm();
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k] ??= {};
  o[last] = value;
}

function fillFleetForm() {
  const f = state.fleet;
  if (!f) return;
  for (const el of $$("#fleet-settings [data-field]")) {
    const v = getPath(f, el.dataset.field);
    el.value = Array.isArray(v) ? v.join("\n") : v ?? (el.tagName === "SELECT" ? el.options[0].value : "");
  }
  if (!f.depot) {
    $('[data-field="depot.junk"]').value = "down";
    $('[data-field="depot.valuables"]').value = "north";
    $('[data-field="depot.fuel"]').value = "west";
  }
  $("#areas").replaceChildren(...(f.protect?.areas ?? []).map(areaRow));
  renderDockApproach();
  setSaveMsg("");
}

function areaRow(a = {}) {
  const row = $("#area-row").content.firstElementChild.cloneNode(true);
  $(".area-name", row).value = a.name ?? "";
  for (const input of $$("[data-k]", row)) input.value = a[input.dataset.k] ?? "";
  $(".area-remove", row).addEventListener("click", () => {
    row.remove();
    markFleetDirty();
  });
  return row;
}

function collectFleet() {
  const out = structuredClone(state.fleet ?? {});
  for (const el of $$("#fleet-settings [data-field]")) {
    let v = el.value;
    if (el.tagName === "TEXTAREA") v = v.split("\n").map((s) => s.trim()).filter(Boolean);
    else if (el.type === "number") v = v === "" ? null : Number(v);
    setPath(out, el.dataset.field, v);
  }
  const d = out.depot;
  const filled = [d.x, d.y, d.z].filter((n) => n !== null).length;
  if (filled === 0) out.depot = null;
  else if (filled < 3) return { error: "Fill in all three dock coordinates, or clear them." };
  out.protect.areas = $$("#areas .area").map((row) => {
    const a = { name: $(".area-name", row).value.trim() };
    for (const input of $$("[data-k]", row)) a[input.dataset.k] = input.value === "" ? null : Number(input.value);
    return a;
  });
  if (out.protect.areas.some((a) => ["x1", "y1", "z1", "x2", "y2", "z2"].some((k) => a[k] === null))) {
    return { error: "Every protected area needs both corners filled in." };
  }
  return { fleet: out };
}

function markFleetDirty() {
  state.fleetDirty = true;
  setSaveMsg("Unsaved changes");
}

function setSaveMsg(text, error = false) {
  const el = $("#fleet-save-msg");
  el.textContent = text;
  el.style.color = error ? "var(--critical)" : "";
}

// Setup --------------------------------------------------------------------------

function setTab(name) {
  for (const tab of $$(".tab[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const form of $$(".job-form")) form.hidden = form.dataset.job !== name;
  store.set("jobTab", name);
}

function setFleetTab(name) {
  for (const tab of $$(".tab[data-fleet-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.fleetTab === name));
  for (const el of $$("#fleet-job-form [data-kind]")) {
    el.hidden = el.dataset.kind !== name;
    // Disabled fields skip validation, so the hidden tab can't block submitting.
    for (const input of $$("input, select", el)) input.disabled = el.hidden;
  }
  store.set("fleetTab", name);
  renderFleetPreview();
}

function setMapMode(mode) {
  state.mapMode = mode;
  store.set("mapMode", mode);
  for (const tab of $$(".tab[data-map]")) tab.setAttribute("aria-selected", String(tab.dataset.map === mode));
  invalidate("detail");
}

function setupInstallSteps() {
  const commands = {
    ".install-cmd": `wget ${location.origin}/turtle.lua startup.lua`,
    ".install-disk": `wget ${location.origin}/install.lua disk/startup.lua`,
  };
  for (const list of $$(".install-steps")) {
    list.append($("#install-steps").content.cloneNode(true));
    for (const [sel, cmd] of Object.entries(commands)) $(sel, list).textContent = cmd;
    for (const btn of $$(".copy", list)) {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(commands[btn.dataset.copy]);
          toast("Copied to clipboard");
        } catch {
          toast("Couldn't copy. Select the text instead.", "warn");
        }
      });
    }
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function bindEvents() {
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    $("#login-form button[type=submit]").disabled = true;
    $("#login-error").hidden = true;
    state.loginPending = true;
    connect({ password: $("#password").value });
  });

  $("#btn-logout").addEventListener("click", () => {
    state.loggedIn = false;
    store.set("session", null);
    const ws = state.ws;
    state.ws = null;
    ws?.close();
    showLogin();
  });

  $("#btn-theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next);
    store.set("theme", next);
  });

  // Fleet-wide controls
  $("#btn-install").addEventListener("click", () => $("#install-dialog").showModal());
  $("#btn-pause-all").addEventListener("click", () => sendRaw({ type: "cmd", id: "all", action: "pause" }));
  $("#btn-resume-all").addEventListener("click", () => sendRaw({ type: "cmd", id: "all", action: "resume" }));
  $("#btn-recall-all").addEventListener("click", () => {
    if (confirm("Cancel every turtle's job and send them all home?")) sendRaw({ type: "cmd", id: "all", action: "goHome" });
  });
  $("#btn-update-all").addEventListener("click", () => {
    if (confirm("Download the latest script to every turtle and reboot them? Turtles on a fleet job update between two steps and carry on with it.")) {
      sendRaw({ type: "cmd", id: "all", action: "update" });
    }
  });
  for (const tab of $$(".tab[data-view]")) tab.addEventListener("click", () => setView(tab.dataset.view));

  $("#turtle-search").addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    invalidate("list");
  });
  for (const chip of $$(".chip")) {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      store.set("filter", state.filter);
      invalidate("list");
    });
  }

  // One turtle
  $("#btn-pause").addEventListener("click", () => command("pause"));
  $("#btn-resume").addEventListener("click", () => command("resume"));
  $("#btn-cancel").addEventListener("click", () => {
    if (confirm("Cancel this job and send the turtle home?")) command("goHome");
  });
  $("#btn-rename").addEventListener("click", startRename);
  $("#t-name").addEventListener("click", startRename);
  $("#rename-cancel").addEventListener("click", endRename);
  $("#rename-input").addEventListener("keydown", (event) => {
    if (event.key === "Escape") endRename();
  });
  $("#rename-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const t = currentTurtle();
    const label = $("#rename-input").value.trim();
    if (t && label) renameTurtle(t, label);
    endRename();
  });
  $("#btn-update").addEventListener("click", () => {
    if (confirm("Download the latest script from this server and reboot the turtle?")) command("update");
  });
  $("#btn-forget").addEventListener("click", () => {
    const t = currentTurtle();
    if (t && confirm(`Remove ${nameOf(t)} from the list? It reappears if it reconnects.`)) {
      sendRaw({ type: "forget", id: t.id });
    }
  });
  $("#btn-reset-pos").addEventListener("click", () => {
    if (confirm("Reset coordinates to 0, 0, 0 facing +Z and make this spot home? Do this after moving the turtle by hand.")) {
      command("resetPosition");
    }
  });
  $("#btn-home-coords").addEventListener("click", () => {
    const form = $("#home-form");
    const s = currentTurtle()?.status ?? {};
    const w = s.homeWorld ?? s.world;
    if (!s.world) {
      toast("Setting home by coordinates needs GPS. Move the turtle a block first.", "warn");
      return;
    }
    for (const k of ["x", "y", "z"]) form.elements[k].value = w?.[k] ?? "";
    form.elements.facing.value = s.homeFacing ?? s.facing ?? "north";
    form.hidden = false;
  });
  $("#btn-home-cancel").addEventListener("click", () => ($("#home-form").hidden = true));
  $("#home-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    command("setHome", {
      x: Number(form.elements.x.value), y: Number(form.elements.y.value), z: Number(form.elements.z.value),
      facing: form.elements.facing.value,
    });
    form.hidden = true;
  });

  for (const btn of $$("[data-cmd]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.cmd === "forceHome" && !confirm("Cancel this job and return home? Mine back to the saved stair bottom at the target safe Y, then climb the exact stairs north. Protections stay active.")) return;
      command(btn.dataset.cmd);
    });
  }
  for (const tab of $$(".tab[data-tab]")) {
    tab.addEventListener("click", () => {
      setTab(tab.dataset.tab);
      invalidate("detail");
    });
  }
  for (const tab of $$(".tab[data-map]")) tab.addEventListener("click", () => setMapMode(tab.dataset.map));
  $("#map").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-id]");
    if (pick) select(Number(pick.dataset.id));
  });

  for (const form of $$(".job-form")) {
    form.addEventListener("input", () => invalidate("detail"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const args = {};
      for (const [key, value] of new FormData(form)) args[key] = Number(value);
      command(form.dataset.job, args);
    });
  }

  $("#auto-dig").checked = store.get("autoDig") === "1";
  $("#auto-dig").addEventListener("change", (event) => store.set("autoDig", event.target.checked ? "1" : null));

  // Fleet page
  for (const tab of $$(".tab[data-fleet-tab]")) tab.addEventListener("click", () => setFleetTab(tab.dataset.fleetTab));
  const jobForm = $("#fleet-job-form");
  jobForm.addEventListener("input", (event) => {
    const { name, value } = event.target;
    // A preset's value holds its fields' values, joined by ":". Editing a
    // field keeps the preset shown only while all its fields still match.
    const presets = { preset: ["levelTop", "levelBottom", "levelPeak"], bottomPreset: ["yBottom"] };
    if (presets[name] && value !== "") value.split(":").forEach((v, i) => { jobForm.elements[presets[name][i]].value = v; });
    for (const [preset, fields] of Object.entries(presets)) {
      if (fields.includes(name)) {
        const select = jobForm.elements[preset];
        const joined = fields.map((field) => jobForm.elements[field].value).join(":");
        select.value = [...select.options].some((o) => o.value === joined) ? joined : "";
      }
    }
    renderFleetPreview();
    invalidate("fleet");
  });
  jobForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const { kind, params } = fleetParams();
    const ids = pickedTurtles().map((t) => t.id);
    if (!ids.length) {
      toast("Pick at least one turtle first.", "warn");
      return;
    }
    $("#fleet-job-result").hidden = true;
    const queued = event.submitter?.value === "queue";
    if (!queued && pickedTurtles().some(notReady)) {
      toast("Some picked turtles are not ready. Add the job to the queue, or use All ready.", "warn");
      return;
    }
    if (queued) $("#job-queue-result").hidden = true;
    sendRaw({ type: queued ? "queueFleetJob" : "fleetJob", kind, ids, params });
  });
  $("#btn-pause-queue").addEventListener("click", () => {
    $("#job-queue-result").hidden = true;
    sendRaw({ type: "pauseJobQueue", paused: !state.jobQueue.paused });
  });
  $("#job-queue-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-cancel-job]");
    if (!button || button.disabled) return;
    const job = state.jobQueue.jobs.find((candidate) => String(candidate.id) === button.dataset.cancelJob);
    if (!job || !["queued", "running", "blocked"].includes(job.state)) return;
    const assigned = job.state === "running" || (job.state === "blocked" && job.assignments?.length);
    if (assigned && !confirm("Cancel this mining job? Assigned turtles will be recalled and the queue will pause.")) return;
    $("#job-queue-result").hidden = true;
    sendRaw({ type: "cancelQueuedJob", id: job.id });
  });
  for (const btn of $$("[data-use-pos]")) {
    btn.addEventListener("click", () => {
      const w = currentTurtle()?.status?.world;
      if (!w) return;
      const [kx, kz] = btn.dataset.usePos.split(",");
      jobForm.elements[kx].value = w.x;
      jobForm.elements[kz].value = w.z;
      if (kx === "x1" && jobForm.elements.yTop.value === "") jobForm.elements.yTop.value = w.y - 1;
      renderFleetPreview();
      invalidate("fleet");
    });
  }
  $("#pick-ready").addEventListener("click", () => {
    state.picked = new Set(sortedTurtles().filter((t) => !notReady(t)).map((t) => t.id));
    invalidate("fleet");
  });
  $("#pick-none").addEventListener("click", () => {
    state.picked.clear();
    invalidate("fleet");
  });
  for (const btn of $$("[data-bulk]")) {
    btn.addEventListener("click", () => {
      const ids = pickedTurtles().map((t) => t.id);
      if (!ids.length) {
        toast("Pick some turtles first.", "warn");
        return;
      }
      const action = btn.dataset.bulk;
      const n = `${ids.length} turtle${ids.length === 1 ? "" : "s"}`;
      if (action === "goHome" && !confirm(`Cancel the jobs of ${n} and send them home?`)) return;
      if (action === "forceHome" && !confirm(`Cancel the jobs of ${n} and return home? Mine back to their own saved stair bottoms at the target safe Y, then climb the exact stairs north. Protections stay active.`)) return;
      if (action === "setHome" && !confirm(`Make the current spot of each of ${n} its new home?`)) return;
      sendRaw({ type: "cmd", ids, action, args: {} });
    });
  }
  $("#job-ores").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-join-job]");
    if (!btn) return;
    const ids = pickedTurtles().map((t) => t.id);
    if (!ids.length) {
      toast("Pick the turtles to add in the fleet list first.", "warn");
      return;
    }
    state.joining = true;
    sendRaw({ type: "joinFleetJob", jobId: btn.dataset.joinJob, ids });
  });
  $("#btn-bulk-rename").addEventListener("click", () => {
    $("#bulk-rename").hidden = false;
    renderBulkRenamePreview();
    $("#bulk-rename").elements.prefix.focus();
  });
  $("#bulk-rename-cancel").addEventListener("click", () => ($("#bulk-rename").hidden = true));
  $("#bulk-rename").addEventListener("input", renderBulkRenamePreview);
  $("#bulk-rename").addEventListener("submit", (event) => {
    event.preventDefault();
    const plan = bulkRenamePlan().filter((p) => p.t.online);
    if (!plan.length || !$("#bulk-rename").elements.prefix.value.trim()) {
      toast("Pick some online turtles and enter a name first.", "warn");
      return;
    }
    for (const { t, label } of plan) {
      sendRaw({ type: "cmd", id: t.id, action: "setLabel", args: { label } });
      t.label = label;
    }
    toast(`Renamed ${plan.length} turtle${plan.length === 1 ? "" : "s"}.`);
    $("#bulk-rename").hidden = true;
    invalidate("list", "detail", "fleet");
  });
  $("#map3d-fit").addEventListener("click", () => world?.fit());
  $("#map3d-follow").addEventListener("click", (event) => {
    const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
    event.currentTarget.setAttribute("aria-pressed", String(on));
    world?.setFollow(on);
  });
  $("#map3d-full").addEventListener("click", () => $("#map3d").requestFullscreen?.());
  for (const id of ["#map3d-ores", "#map3d-areas", "#map3d-jobs", "#map3d-names"]) {
    $(id).addEventListener("change", applyMapOptions);
  }
  $("#map3d-clear").addEventListener("click", () => {
    if (confirm("Clear the mined-block history for everyone? Turtles keep reporting new digs.")) sendRaw({ type: "clearMined" });
  });
  $("#fleet-map").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-id]");
    if (!pick) return;
    select(Number(pick.dataset.id));
    setView("turtles");
  });

  for (const sideSelect of $$("select.side")) {
    sideSelect.innerHTML = Object.entries(SIDES).map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  }
  $("#fleet-settings").addEventListener("input", () => {
    markFleetDirty();
    renderDockApproach();
  });
  $("#btn-add-area").addEventListener("click", () => {
    const w = currentTurtle()?.status?.world;
    // Start a new area as a 20x20 box around the selected turtle, if it has GPS.
    const row = areaRow(w ? { x1: w.x - 10, y1: w.y - 10, z1: w.z - 10, x2: w.x + 10, y2: w.y + 20, z2: w.z + 10 } : {});
    $("#areas").append(row);
    $(".area-name", row).focus();
    markFleetDirty();
  });
  $("#btn-dock-here").addEventListener("click", () => {
    const w = currentTurtle()?.status?.world;
    if (!w) return;
    for (const k of ["x", "y", "z"]) $(`[data-field="depot.${k}"]`).value = w[k];
    markFleetDirty();
  });
  $("#btn-save-fleet").addEventListener("click", () => {
    const { fleet, error } = collectFleet();
    if (error) {
      setSaveMsg(error, true);
      return;
    }
    setSaveMsg("Saving…");
    sendRaw({ type: "saveFleet", fleet });
  });
  $("#btn-revert-fleet").addEventListener("click", () => {
    state.fleetDirty = false;
    fillFleetForm();
  });
  $("#btn-release-dock").addEventListener("click", () => {
    if (confirm("Release the dock? Only do this if the turtle using it is stuck or gone, or two turtles may meet at the dock.")) {
      sendRaw({ type: "releaseDepot" });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.("input:not([type=checkbox]), select, textarea")) return;
    if ($("#app").hidden || $("#install-dialog").open) return;

    if (event.key === "/") {
      event.preventDefault();
      $("#turtle-search").focus();
      return;
    }
    if ($("#turtle").hidden) return;
    if (event.key === "Escape") {
      if (currentTurtle()?.status?.job) command("pause");
      return;
    }
    const key = event.key.toLowerCase();
    if (!KEYS[key]) return;
    event.preventDefault();
    const btn = $(`.pad[data-key="${key}"]`);
    if (btn.disabled) return;
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
    command(KEYS[key]);
  });

  // Keep "last seen" times fresh, and remember which server copy we're on.
  setInterval(() => {
    invalidate("list", "detail", "fleet");
    rememberServer();
  }, 15000);
  addEventListener("pagehide", rememberServer);
}

applyTheme(store.get("theme"));
buildInventory();
setupInstallSteps();
setTab(store.get("jobTab") === "tunnel" ? "tunnel" : "quarry");
setFleetTab(store.get("fleetTab") === "areaQuarry" ? "areaQuarry" : "branchMine");
setMapMode(state.mapMode);
bindEvents();
setView(state.view);

const session = store.get("session");
if (session) {
  state.loggedIn = true;
  showApp();
  connect({ session });
} else {
  showLogin();
}
