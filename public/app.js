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
const FACING = ["+Z", "+X", "−Z", "−X"]; // local headings
const COMPASS = ["north", "east", "south", "west"];
const KEYS = { w: "forward", s: "back", a: "turnLeft", d: "turnRight", e: "up", q: "down" };
const DIGGABLE = new Set(["forward", "up", "down"]);
const JOB_NAMES = { quarry: "Quarry", tunnel: "Tunnel", goHome: "Going home" };
const STATE_LABELS = { working: "Working", attention: "Needs attention", idle: "Idle", offline: "Offline" };

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
  attention: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .5l4.7 8.8H.3z" fill="currentColor"/></svg>',
};

const savedSelection = store.get("selected");
const state = {
  turtles: new Map(), // id -> turtle as sent by the server, plus logs
  trails: new Map(), // id -> { frame, points: [{x, z}] } for the map
  selected: savedSelection === null ? null : Number(savedSelection),
  filter: store.get("filter") ?? "all",
  search: "",
  mapMode: store.get("mapMode") === "fleet" ? "fleet" : "turtle",
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

function jobPercent(job) {
  return job.name === "goHome" ? "" : `${Math.round((job.progress ?? 0) * 100)}%`;
}

function turtleState(t) {
  if (!t.online) return { key: "offline", label: "Offline" };
  const job = t.status?.job;
  if (job && /waiting|full|low on fuel/i.test(job.detail ?? "")) return { key: "attention", label: "Needs attention" };
  if (job) return { key: "working", label: `${JOB_NAMES[job.name] ?? prettyName(job.name)} ${jobPercent(job)}`.trim() };
  if (fuelInfo(t.status)?.sev === "crit") return { key: "attention", label: "Low fuel" };
  return { key: "idle", label: "Idle" };
}

// Where to draw a turtle: world coordinates once GPS knows its facing,
// otherwise its own frame relative to where it started.
function mapPos(t) {
  const s = t.status;
  const num = (p) => p && { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
  if (s?.world && s.facing) {
    return { frame: "world", ...num(s.world), dir: COMPASS.indexOf(s.facing), home: num(s.homeWorld) };
  }
  if (s?.pos) return { frame: "local", ...num(s.pos), dir: Number(s.heading), home: num(s.home) };
  return null;
}

// Connection -----------------------------------------------------------------

function connect(auth) {
  const old = state.ws;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard`);
  state.ws = ws;
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
    handle(msg);
  });
  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    state.ws = null;
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
      state.turtles = new Map(msg.turtles.map((t) => [t.id, t]));
      for (const t of state.turtles.values()) recordTrail(t);
      state.ready = true;
      state.revealSelected = true;
      ensureSelection();
      invalidate("list", "detail", "log");
      break;

    case "turtle": {
      const t = { ...msg.turtle, logs: state.turtles.get(msg.turtle.id)?.logs ?? [] };
      state.turtles.set(t.id, t);
      recordTrail(t);
      if (!state.turtles.has(state.selected)) {
        ensureSelection();
        invalidate("log");
      }
      // Other turtles appear on the map, so the detail view can change too.
      invalidate("list", "detail");
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
      ensureSelection();
      invalidate("list", "detail", "log");
      break;

    case "error":
      toast(msg.msg, "error");
      break;
  }
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
const dirty = { list: false, detail: false, log: false };
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
  const { list, detail, log } = dirty;
  dirty.list = dirty.detail = dirty.log = false;
  if (list) renderList();
  if (detail || log) renderDetail(log);
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
  state.selected = id;
  state.revealSelected = true;
  store.set("selected", id);
  invalidate("list", "detail", "log");
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
  const el = $("#conn");
  el.dataset.state = status;
  el.textContent = { online: "Live", connecting: "Connecting…", offline: "Reconnecting…" }[status];
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

  const counts = { all: turtles.length, working: 0, attention: 0, idle: 0, offline: 0 };
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

  // Selecting from the map or search can pick a turtle that's scrolled out of view.
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
  if (!t.online) sub = `Last seen ${ago(t.lastSeen)}`;
  else if (t.status?.job) sub = t.status.job.detail ?? "";
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

  // Job
  $("#job-value").textContent = job ? (JOB_NAMES[job.name] ?? prettyName(job.name)) : t.online ? "Idle" : "–";
  $("#btn-stop").hidden = !job && !s.queued;
  $("#job-meter").hidden = !job || job.name === "goHome";
  if (job) renderMeter($("#job-meter"), job.progress ?? 0);
  $("#job-sub").textContent = job
    ? [job.detail, jobPercent(job)].filter(Boolean).join(" · ")
    : s.queued
      ? `${s.queued} command${s.queued === 1 ? "" : "s"} queued`
      : "";

  const direction = $("#job-direction");
  direction.hidden = !s.facing;
  if (s.facing) {
    const right = COMPASS[(COMPASS.indexOf(s.facing) + 1) % 4];
    direction.innerHTML = `Facing <b></b>: a quarry extends ${s.facing} and ${right}, a tunnel heads ${s.facing}.`;
    direction.firstElementChild.textContent = capital(s.facing);
  }

  // Blocks around the turtle (only refreshed while idle)
  for (const side of ["up", "front", "down"]) {
    const el = $(`#around-${side}`);
    const block = s.around?.[side];
    el.textContent = busy ? "…" : block ? prettyName(block) : s.around ? "Air" : "–";
    el.title = block ?? "";
    el.classList.toggle("air", !block);
  }

  renderInventory(s, t.online && !busy);
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
    parts.push(s.facing ? `Facing ${capital(s.facing)}` : "Move one block so it can find north");
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

const escapeXml = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

function arrow(cls, x, y, dir, size) {
  const k = size / 10;
  return `<path class="${cls}" transform="translate(${x} ${y}) rotate(${(Number(dir) || 0) * 90}) scale(${k})" d="M0 -10 L8 8 L0 4 L-8 8 Z"/>`;
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
  const fit = fleet ? [...others.map((o) => o.p), mine] : [...trail, mine, mine.home];
  const pts = fit.filter(Boolean);
  const xs = pts.map((p) => Number(p.x));
  const zs = pts.map((p) => Number(p.z));
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const span = Math.max(maxX - minX, maxZ - minZ, 10) * 1.15 + 4;
  const scale = size / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const sx = (x) => +(size / 2 + (x - cx) * scale).toFixed(1);
  // World maps put north (−Z) up; local maps put the start direction (+Z) up.
  const sy = (z) => +(size / 2 + (world ? 1 : -1) * (z - cz) * scale).toFixed(1);
  const inView = (p) => Math.abs(p.x - cx) <= span / 2 && Math.abs(p.z - cz) <= span / 2;

  const step = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000].find((n) => n * scale >= 18) ?? 10000;
  let out = "";
  for (let x = Math.ceil((cx - span / 2) / step) * step; x <= cx + span / 2; x += step) {
    out += `<line class="grid-line" x1="${sx(x)}" x2="${sx(x)}" y1="0" y2="${size}"/>`;
  }
  for (let z = Math.ceil((cz - span / 2) / step) * step; z <= cz + span / 2; z += step) {
    out += `<line class="grid-line" y1="${sy(z)}" y2="${sy(z)}" x1="0" x2="${size}"/>`;
  }

  if (trail.length > 1) {
    out += `<polyline class="trail" points="${trail.map((p) => `${sx(p.x)},${sy(p.z)}`).join(" ")}"/>`;
  }

  if (mine?.home && !fleet) {
    const h = mine.home;
    const r = Math.max(5, Math.min(9, scale * 0.45));
    out += `<rect class="home" x="${sx(h.x) - r}" y="${sy(h.z) - r}" width="${2 * r}" height="${2 * r}" rx="2">
      <title>Home: ${[h.x, h.y, h.z].map(Number).join(", ")}</title></rect>`;
  }

  // Other turtles: status-colored and clickable in fleet view, faint context otherwise.
  for (const { t: o, p } of others) {
    if (!inView(p)) continue;
    const st = turtleState(o);
    const title = `<title>${escapeXml(nameOf(o))} · ${st.label} · ${p.x}, ${p.y}, ${p.z}</title>`;
    out += fleet
      ? `<g class="pick" data-id="${o.id}">${arrow(`mark mark-${st.key}`, sx(p.x), sy(p.z), p.dir, 7)}${title}</g>`
      : `<g class="pick" data-id="${o.id}"><circle class="other" cx="${sx(p.x)}" cy="${sy(p.z)}" r="3.5"/>${title}</g>`;
  }

  if (mine) {
    const st = turtleState(t);
    const [x, y] = [sx(mine.x), sy(mine.z)];
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
  out += `<text class="scale" x="8" y="${size - 8}">Grid: ${fmt(step)} block${step === 1 ? "" : "s"}</text>`;
  svg.innerHTML = out;
}

function renderLegend(fleet, world) {
  const key = fleet ? `fleet` : world ? "world" : "local";
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

// Setup --------------------------------------------------------------------------

function setTab(name) {
  for (const tab of $$(".tab[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const form of $$(".job-form")) form.hidden = form.dataset.job !== name;
  store.set("jobTab", name);
}

function setMapMode(mode) {
  state.mapMode = mode;
  store.set("mapMode", mode);
  for (const tab of $$(".tab[data-map]")) tab.setAttribute("aria-selected", String(tab.dataset.map === mode));
  invalidate("detail");
}

function setupInstallSteps() {
  const cmd = `wget ${location.origin}/turtle.lua startup.lua`;
  for (const list of $$(".install-steps")) {
    list.append($("#install-steps").content.cloneNode(true));
    $(".install-cmd", list).textContent = cmd;
    $(".copy", list).addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        toast("Copied to clipboard");
      } catch {
        toast("Couldn't copy. Select the text instead.", "warn");
      }
    });
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function currentTurtle() {
  return state.turtles.get(state.selected);
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

  $("#btn-install").addEventListener("click", () => $("#install-dialog").showModal());
  $("#btn-stop-all").addEventListener("click", () => sendRaw({ type: "cmd", id: "all", action: "stop" }));
  $("#btn-recall-all").addEventListener("click", () => {
    if (confirm("Stop every turtle's job and send it home?")) sendRaw({ type: "cmd", id: "all", action: "goHome" });
  });
  $("#btn-update-all").addEventListener("click", () => {
    if (confirm("Download the latest script to every idle turtle and reboot them? Busy turtles skip it.")) {
      sendRaw({ type: "cmd", id: "all", action: "update" });
    }
  });

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

  $("#btn-stop").addEventListener("click", () => command("stop"));
  $("#btn-rename").addEventListener("click", () => {
    const label = prompt("Name this turtle", currentTurtle()?.label ?? "");
    if (label !== null) command("setLabel", { label: label.trim() });
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

  for (const btn of $$("[data-cmd]")) btn.addEventListener("click", () => command(btn.dataset.cmd));
  for (const tab of $$(".tab[data-tab]")) tab.addEventListener("click", () => setTab(tab.dataset.tab));
  for (const tab of $$(".tab[data-map]")) tab.addEventListener("click", () => setMapMode(tab.dataset.map));
  $("#map").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-id]");
    if (pick) select(Number(pick.dataset.id));
  });

  for (const form of $$(".job-form")) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const args = {};
      for (const [key, value] of new FormData(form)) args[key] = Number(value);
      command(form.dataset.job, args);
    });
  }

  $("#auto-dig").checked = store.get("autoDig") === "1";
  $("#auto-dig").addEventListener("change", (event) => store.set("autoDig", event.target.checked ? "1" : null));

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
      if (currentTurtle()?.online) command("stop");
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

  // Keep "last seen" times fresh.
  setInterval(() => invalidate("list", "detail"), 15000);
}

applyTheme(store.get("theme"));
buildInventory();
setupInstallSteps();
setTab(store.get("jobTab") === "tunnel" ? "tunnel" : "quarry");
setMapMode(state.mapMode);
bindEvents();

const session = store.get("session");
if (session) {
  state.loggedIn = true;
  showApp();
  connect({ session });
} else {
  showLogin();
}
