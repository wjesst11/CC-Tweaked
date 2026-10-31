// The 3D map: every turtle, the blocks the fleet has mined, the depot,
// protected areas and job areas, in Minecraft's own coordinates (x east,
// y up, z south). Loaded only when the 3D map is opened.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const BLOCK_COLORS = [
  [/diamond/, 0x4ee2e0],
  [/emerald/, 0x17dd62],
  [/ancient_debris|netherite/, 0x7a5545],
  [/gold/, 0xf5c542],
  [/iron/, 0xd8af93],
  [/copper/, 0xe07a4f],
  [/redstone/, 0xe02a2a],
  [/lapis/, 0x2f5bd3],
  [/quartz/, 0xe9e3db],
  [/amethyst/, 0x9a5cc6],
  [/coal/, 0x2b2b2b],
  [/deepslate|tuff|basalt|blackstone/, 0x55555d],
  [/dirt|grass|mud|clay|podzol|mycelium|farmland/, 0x7a5534],
  [/gravel/, 0x9a9089],
  [/sand/, 0xdccf9a],
  [/granite/, 0x9a6a57],
  [/diorite|calcite/, 0xcfcfcf],
  [/andesite/, 0x8f928f],
  [/netherrack/, 0x6e2e2e],
  [/leaves/, 0x4f8a32],
  [/log|wood|planks/, 0x8a6a3a],
  [/snow|ice/, 0xdfefff],
  [/obsidian/, 0x2a1a3a],
];
const STONE = 0x8a8a8a;
const ORE = /_ore$|ancient_debris/;
const STATE_COLORS = { working: "--accent", paused: "--ink-2", attention: "--warning", idle: "--good", offline: "--muted" };
const SIDE_OFFSETS = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
};
const COMPASS = ["north", "east", "south", "west"];

export function blockColor(name) {
  return BLOCK_COLORS.find(([pattern]) => pattern.test(name))?.[1] ?? STONE;
}

// Per block name, worked out once: there are few names and many blocks.
const looks = new Map();
function look(name = "") {
  let l = looks.get(name);
  if (!l) looks.set(name, (l = { color: blockColor(name), ore: ORE.test(name) }));
  return l;
}

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(n, 1024)));

// Centre of the block at integer coordinates.
const centre = (p) => new THREE.Vector3(p.x + 0.5, p.y + 0.5, p.z + 0.5);
const validPoint = (p) => p && [p.x, p.y, p.z].every(Number.isFinite);

function boxBetween(a, b) {
  const min = new THREE.Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
  const max = new THREE.Vector3(Math.max(a.x, b.x) + 1, Math.max(a.y, b.y) + 1, Math.max(a.z, b.z) + 1);
  return new THREE.Box3(min, max);
}

function label(text, className = "map3d-label") {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return new CSS2DObject(div);
}

export function createWorld(container, { onSelect, onOpen, nameOf }) {
  const css = () => getComputedStyle(document.documentElement);
  const cssColor = (name) => new THREE.Color(css().getPropertyValue(name).trim() || "#888888");

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.prepend(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = "map3d-labels";
  container.append(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 6000);
  camera.position.set(40, 50, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomSpeed = 3; // each wheel notch or pinch moves three times the default
  controls.maxDistance = 3000;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);

  const groups = {};
  for (const name of ["turtles", "depot", "homes", "areas", "jobs", "grid"]) {
    groups[name] = new THREE.Group();
    scene.add(groups[name]);
  }

  // Mined blocks: one instanced mesh. New blocks are appended as they stream
  // in (throttled); it's only rebuilt from scratch when the filter changes or
  // the history is cleared.
  const mined = new Map(); // "x,y,z" -> index
  const mx = [], my = [], mz = [], mcode = [], mid = [];
  let names = [];
  let oreCount = 0;
  let minedBounds = null;
  let minedMesh = null;
  let shown = []; // instance -> block index
  const instanceOf = []; // block index -> instance, or -1 when filtered out
  let built = 0; // blocks already considered for the mesh
  let minedDirty = false;
  let needFull = true;
  let oresOnly = false;
  const cube = new THREE.BoxGeometry(0.92, 0.92, 0.92);
  const cubeMaterial = new THREE.MeshLambertMaterial();
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  function addMined(newNames, flat) {
    names = newNames;
    for (let i = 0; i + 4 < flat.length; i += 5) {
      const key = `${flat[i]},${flat[i + 1]},${flat[i + 2]}`;
      let j = mined.get(key);
      if (j === undefined) {
        j = mx.length;
        mined.set(key, j);
        mx.push(flat[i]);
        my.push(flat[i + 1]);
        mz.push(flat[i + 2]);
        mcode.push(flat[i + 3]);
        mid.push(flat[i + 4]);
        if (look(names[flat[i + 3]]).ore) oreCount++;
        const p = new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]);
        if (!minedBounds) minedBounds = new THREE.Box3(p.clone(), p.clone());
        minedBounds.expandByPoint(p);
      } else if (mcode[j] !== flat[i + 3] || mid[j] !== flat[i + 4]) {
        // Mined again (say, gravel that fell in): recolour it where it is.
        const was = look(names[mcode[j]]), now = look(names[flat[i + 3]]);
        oreCount += (now.ore ? 1 : 0) - (was.ore ? 1 : 0);
        mcode[j] = flat[i + 3];
        mid[j] = flat[i + 4];
        if (oresOnly && was.ore !== now.ore) needFull = true;
        else if (j < built && instanceOf[j] >= 0 && minedMesh) {
          minedMesh.setColorAt(instanceOf[j], tint.setHex(now.color));
          minedMesh.instanceColor.addUpdateRange?.(instanceOf[j] * 3, 3);
          minedMesh.instanceColor.needsUpdate = true;
        }
      }
    }
    minedDirty = true;
  }

  function clearMined() {
    mined.clear();
    for (const list of [mx, my, mz, mcode, mid, instanceOf]) list.length = 0;
    oreCount = 0;
    minedBounds = null;
    needFull = minedDirty = true;
  }

  function rebuildMined() {
    minedDirty = false;
    if (needFull) {
      shown = [];
      built = 0;
      needFull = false;
    }
    let from = shown.length;
    for (let j = built; j < mx.length; j++) {
      instanceOf[j] = !oresOnly || look(names[mcode[j]]).ore ? shown.push(j) - 1 : -1;
    }
    built = mx.length;
    const capacity = nextPow2(shown.length);
    if (!minedMesh || minedMesh.instanceMatrix.count < capacity) {
      if (minedMesh) {
        scene.remove(minedMesh);
        minedMesh.dispose();
      }
      minedMesh = new THREE.InstancedMesh(cube, cubeMaterial, capacity);
      minedMesh.frustumCulled = false;
      scene.add(minedMesh);
      from = 0;
    }
    for (let i = from; i < shown.length; i++) {
      const j = shown[i];
      dummy.position.set(mx[j] + 0.5, my[j] + 0.5, mz[j] + 0.5);
      dummy.updateMatrix();
      minedMesh.setMatrixAt(i, dummy.matrix);
      minedMesh.setColorAt(i, tint.setHex(look(names[mcode[j]]).color));
    }
    minedMesh.count = shown.length;
    // Upload only the new instances when the renderer supports it (it
    // clears the ranges once they're uploaded).
    if (shown.length === from) return;
    for (const [attr, size] of [[minedMesh.instanceMatrix, 16], [minedMesh.instanceColor, 3]]) {
      if (!attr) continue;
      if (from > 0) attr.addUpdateRange?.(from * size, (shown.length - from) * size);
      attr.needsUpdate = true;
    }
  }

  // Mined blocks are whole blocks on the block grid, so the pointer's ray is
  // walked block by block through the mined area and looked up, rather than
  // tested against every cube: quick even with hundreds of thousands of them.
  const entry = new THREE.Vector3();
  const area = new THREE.Box3();
  function minedAlong(ray, maxDistance) {
    if (!minedBounds) return null;
    area.copy(minedBounds);
    area.max.addScalar(1);
    if (!ray.intersectBox(area, entry)) return null;
    const skipped = ray.origin.distanceTo(entry);
    const d = ray.direction;
    const o = entry.addScaledVector(d, 1e-6);
    const pos = [Math.floor(o.x), Math.floor(o.y), Math.floor(o.z)];
    const step = [Math.sign(d.x), Math.sign(d.y), Math.sign(d.z)];
    const delta = [d.x, d.y, d.z].map((v) => Math.abs(1 / v));
    const next = [o.x, o.y, o.z].map((v, a) =>
      step[a] > 0 ? (Math.floor(v) + 1 - v) * delta[a] : step[a] < 0 ? (v - Math.floor(v)) * delta[a] : Infinity);
    const lo = [area.min.x, area.min.y, area.min.z], hi = [area.max.x, area.max.y, area.max.z];
    let t = 0;
    while (skipped + t <= maxDistance) {
      const j = mined.get(`${pos[0]},${pos[1]},${pos[2]}`);
      if (j !== undefined && (!oresOnly || look(names[mcode[j]]).ore)) return { j, distance: skipped + t };
      const a = next[0] < next[1] ? (next[0] < next[2] ? 0 : 2) : next[1] < next[2] ? 1 : 2;
      t = next[a];
      next[a] += delta[a];
      pos[a] += step[a];
      if (pos[a] < lo[a] - 1 || pos[a] > hi[a]) return null; // out of the mined area
    }
    return null;
  }

  // Turtles: a body coloured by status and a darker nose showing its facing.
  // Far away they're drawn bigger so they never shrink to a dot, and their name
  // tags can be clicked like the turtles themselves.
  const turtles = new Map(); // id -> { group, body, label, target }
  const bodyGeometry = new THREE.BoxGeometry(0.86, 0.86, 0.86);
  const noseGeometry = new THREE.BoxGeometry(0.34, 0.34, 0.2);
  const noseMaterial = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const ringGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.25, 1.25, 1.25));
  let selectedId = null;

  function updateTurtles(list) {
    const seen = new Set();
    for (const t of list) {
      if (!t.world) continue;
      seen.add(t.id);
      let e = turtles.get(t.id);
      if (!e) {
        const group = new THREE.Group();
        const body = new THREE.Mesh(bodyGeometry, new THREE.MeshLambertMaterial());
        body.userData.turtleId = t.id;
        const nose = new THREE.Mesh(noseGeometry, noseMaterial);
        nose.position.set(0, 0.05, -0.52);
        const ring = new THREE.LineSegments(ringGeometry, new THREE.LineBasicMaterial());
        ring.visible = false;
        const tag = label("", "map3d-label turtle");
        tag.position.set(0, 1.05, 0);
        const id = t.id;
        // Select on press: a moving turtle's tag may slide away before the release.
        tag.element.addEventListener("pointerdown", () => pick(id));
        tag.element.addEventListener("dblclick", () => onOpen(id));
        tag.element.addEventListener("pointerenter", (ev) => showInfo(turtleInfo(turtles.get(id)?.data), ev));
        tag.element.addEventListener("pointerleave", () => (info.hidden = true));
        group.add(body, nose, ring, tag);
        groups.turtles.add(group);
        e = { group, body, ring, tag, target: centre(t.world) };
        group.position.copy(e.target);
        turtles.set(t.id, e);
      }
      e.data = t;
      e.target = centre(t.world);
      e.body.material.color = cssColor(STATE_COLORS[t.state] ?? "--muted");
      e.group.rotation.y = -Math.max(0, COMPASS.indexOf(t.facing)) * (Math.PI / 2);
      e.tag.element.textContent = t.name;
      e.tag.element.classList.toggle("selected", t.id === selectedId);
      e.ring.visible = t.id === selectedId;
      e.ring.material.color = cssColor("--ink");
    }
    for (const [id, e] of turtles) {
      if (seen.has(id)) continue;
      groups.turtles.remove(e.group);
      e.tag.element.remove();
      turtles.delete(id);
    }
  }

  // Show the selection at once, then tell the dashboard.
  function markSelected(id) {
    selectedId = id;
    for (const [tid, e] of turtles) {
      e.tag.element.classList.toggle("selected", tid === id);
      e.ring.visible = tid === id;
    }
  }
  function pick(id) {
    markSelected(id);
    onSelect(id);
  }

  function clearGroup(group) {
    for (const child of [...group.children]) {
      child.traverse((o) => o.element?.remove());
      group.remove(child);
    }
  }

  function outline(box, color, opacity = 1) {
    const size = box.getSize(new THREE.Vector3());
    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
      new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
    );
    lines.position.copy(box.getCenter(new THREE.Vector3()));
    return lines;
  }

  // The depot, protected areas, job areas and homes: rebuilt only when they change.
  let staticKey = "";
  function updateStatic(fleet, list) {
    const jobs = list.filter((t) => t.job).map((t) => [t.id, t.job]);
    const homes = list.filter((t) => t.home).map((t) => t.home);
    const routes = list.filter((t) => validPoint(t.route?.home) && validPoint(t.route?.bottom) && (t.route.bottomSaved || t.route.stair?.complete))
      .map((t) => ({ id: t.id, home: t.route.home, bottom: t.route.bottom, job: t.job }));
    const key = JSON.stringify([fleet?.depot, fleet?.protect?.areas, jobs, homes, routes, css().getPropertyValue("--page")]);
    if (key === staticKey) return;
    staticKey = key;
    for (const g of ["depot", "areas", "jobs", "homes"]) clearGroup(groups[g]);

    const D = fleet?.depot;
    if (D) {
      const dock = boxBetween(D, D);
      groups.depot.add(outline(dock, cssColor("--ink")));
      const chestMaterial = new THREE.MeshLambertMaterial({ color: 0x9a6a32 });
      for (const kind of ["junk", "valuables", "fuel"]) {
        const [dx, dy, dz] = SIDE_OFFSETS[D[kind]] ?? [0, 0, 0];
        const chest = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), chestMaterial);
        chest.position.set(D.x + dx + 0.5, D.y + dy + 0.5, D.z + dz + 0.5);
        const tag = label(kind, "map3d-label small");
        tag.position.set(0, 0.8, 0);
        chest.add(tag);
        groups.depot.add(chest);
      }
      const tag = label("Depot", "map3d-label strong");
      const above = ["junk", "valuables", "fuel"].some((kind) => D[kind] === "up"); // clear of that chest's label
      tag.position.copy(centre(D)).add(new THREE.Vector3(0, above ? 2.8 : 1.6, 0));
      groups.depot.add(tag);
    }

    const red = cssColor("--critical");
    for (const a of fleet?.protect?.areas ?? []) {
      const box = boxBetween({ x: a.x1, y: a.y1, z: a.z1 }, { x: a.x2, y: a.y2, z: a.z2 });
      const size = box.getSize(new THREE.Vector3());
      const fill = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, size.y, size.z),
        new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.1, depthWrite: false }),
      );
      fill.position.copy(box.getCenter(new THREE.Vector3()));
      groups.areas.add(fill, outline(box, red, 0.8));
      if (a.name) {
        const tag = label(a.name, "map3d-label danger");
        tag.position.set(fill.position.x, box.max.y + 1, fill.position.z);
        groups.areas.add(tag);
      }
    }

    const accent = cssColor("--accent");
    for (const [, job] of jobs) {
      let box;
      if (job.kind === "areaQuarry") {
        box = boxBetween({ x: job.x1, y: job.yBottom, z: job.z1 }, { x: job.x2, y: job.yTop, z: job.z2 });
      } else if (job.kind === "branchMine") {
        if (Number.isInteger(job.radius) && job.radius >= 1 && validPoint(job.routeHome)) {
          const h = job.routeHome;
          for (const y of [-64, 320]) {
            const points = Array.from({ length: 97 }, (_, i) => {
              const angle = i / 96 * Math.PI * 2;
              return new THREE.Vector3(h.x + 0.5 + job.radius * Math.cos(angle), y, h.z + 0.5 + job.radius * Math.sin(angle));
            });
            groups.jobs.add(new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(points),
              new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.45 }),
            ));
          }
          const verticals = Array.from({ length: 4 }, (_, i) => {
            const angle = i / 4 * Math.PI * 2;
            const x = h.x + 0.5 + job.radius * Math.cos(angle);
            const z = h.z + 0.5 + job.radius * Math.sin(angle);
            return [new THREE.Vector3(x, -64, z), new THREE.Vector3(x, 320, z)];
          }).flat();
          groups.jobs.add(new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(verticals),
            new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.18 }),
          ));
          box = boxBetween({ x: job.x, y: job.y, z: job.z }, { x: job.x, y: job.y + 1, z: job.z + job.length - 1 });
        } else if (job.veinBounds) {
          const b = job.veinBounds;
          box = boxBetween({ x: b.x1, y: b.y1, z: b.z1 }, { x: b.x2, y: b.y2, z: b.z2 });
        } else {
          const d = typeof job.dir === "number" ? job.dir : Math.max(0, COMPASS.indexOf(job.dir));
          const step = [[0, -1], [1, 0], [0, 1], [-1, 0]][d];
          const band = job.band ?? 0;
          const end = { x: job.x + (job.length - 1) * step[0], y: job.y + 1 + band, z: job.z + (job.length - 1) * step[1] };
          box = boxBetween({ x: job.x, y: job.y - band, z: job.z }, end);
        }
      }
      if (box) groups.jobs.add(outline(box, accent, 0.7));
    }

    const homeMaterial = new THREE.MeshBasicMaterial({ color: cssColor("--ink-2"), transparent: true, opacity: 0.5 });
    for (const h of homes) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.9), homeMaterial);
      pad.position.set(h.x + 0.5, h.y + 0.03, h.z + 0.5);
      groups.homes.add(pad);
    }
    for (const { id, home, bottom, job } of routes) {
      const depth = home.y - bottom.y;
      if (!Number.isInteger(depth) || depth < 0 || depth > 131 || home.x !== bottom.x || bottom.z - home.z !== depth) continue;
      const points = [centre(home)];
      for (let step = 1; step <= depth; step++) {
        points.push(centre({ x: home.x, y: home.y - step + 1, z: home.z + step }));
        points.push(centre({ x: home.x, y: home.y - step, z: home.z + step }));
      }
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: cssColor("--ink-2"), transparent: true, opacity: 0.65 }));
      groups.homes.add(path);
      if (job?.routeMode === "southRow" && [job.x, job.z].every(Number.isFinite)) {
        groups.homes.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([centre(bottom), centre({ x: job.x, y: bottom.y, z: job.z })]),
          new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.65 }),
        ));
      }
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: accent }));
      marker.position.copy(centre(bottom));
      const tag = label(`${nameOf(id)} stair bottom`, "map3d-label small");
      tag.position.set(0, 0.8, 0);
      marker.add(tag);
      groups.homes.add(marker);
    }
  }

  // A grid at ground level, with compass letters: chunks (16 blocks), or for
  // a big area 4, 16, ... chunks a square so it stays at most 64 squares across.
  let gridKey = "";
  function updateGrid(bounds, groundY) {
    const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
    let cell = 16;
    while (span / cell > 62) cell *= 4;
    const size = Math.max(4 * cell, Math.ceil(span / (2 * cell) + 1) * 2 * cell);
    const cx = Math.round((bounds.min.x + bounds.max.x) / 2 / cell) * cell;
    const cz = Math.round((bounds.min.z + bounds.max.z) / 2 / cell) * cell;
    const key = [size, cell, cx, cz, groundY, css().getPropertyValue("--line")].join();
    if (key === gridKey) return;
    gridKey = key;
    clearGroup(groups.grid);
    const grid = new THREE.GridHelper(size, size / cell, cssColor("--axis"), cssColor("--line"));
    grid.position.set(cx, groundY, cz);
    groups.grid.add(grid);
    for (const [text, x, z] of [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]]) {
      const tag = label(text, "map3d-compass");
      tag.position.set(cx + (x * size) / 2, groundY, cz + (z * size) / 2);
      groups.grid.add(tag);
    }
  }

  function contentBounds(fleet) {
    const box = new THREE.Box3();
    for (const e of turtles.values()) box.expandByPoint(e.target);
    if (fleet?.depot) box.expandByPoint(centre(fleet.depot));
    if (minedBounds) box.union(minedBounds);
    for (const child of groups.jobs.children) box.expandByObject(child);
    for (const child of groups.homes.children) box.expandByObject(child);
    return box;
  }

  let lastFleet = null;
  function fit() {
    const box = contentBounds(lastFleet);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const middle = box.getCenter(new THREE.Vector3());
    const radius = Math.max(12, size.length() / 2);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    controls.target.copy(middle);
    camera.position.copy(middle).add(new THREE.Vector3(0.55, 0.65, 0.75).normalize().multiplyScalar(distance));
    camera.near = Math.max(0.1, distance / 500);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
  }

  // Picking: click selects a turtle, double-click opens it; hovering shows details.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const info = container.querySelector(".map3d-info");
  function turtleInfo(t) {
    return t && `${t.name} · ${t.stateLabel}\n${t.world.x}, ${t.world.y}, ${t.world.z}${t.facing ? ` facing ${t.facing}` : ""}\nClick to select, double-click to open`;
  }
  function showInfo(text, e) {
    info.hidden = !text;
    if (!text) return;
    const r = container.getBoundingClientRect();
    info.textContent = text;
    info.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 220)}px`;
    info.style.top = `${e.clientY - r.top + 14}px`;
  }
  // What's under the pointer: { turtleId } or { block } (an index into the
  // mined lists), whichever is nearer, or null.
  function hit(event) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const turtle = raycaster.intersectObjects([...turtles.values()].map((e) => e.body), false)[0];
    // A turtle stands in a block it mined, so a block only wins if it's clearly in front.
    const block = mx.length ? minedAlong(raycaster.ray, turtle ? turtle.distance - 1 : camera.far) : null;
    if (block) return { block: block.j };
    return turtle ? { turtleId: turtle.object.userData.turtleId } : null;
  }
  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) {
      const id = hit(e)?.turtleId;
      if (id != null) pick(id);
    }
    downAt = null;
  });
  renderer.domElement.addEventListener("dblclick", (e) => {
    const id = hit(e)?.turtleId;
    if (id != null) onOpen(id);
  });
  let hoverQueued = false;
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (hoverQueued || e.buttons) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const h = hit(e);
      let text = null;
      if (h?.turtleId != null) {
        text = turtleInfo(turtles.get(h.turtleId)?.data);
      } else if (h?.block != null) {
        const j = h.block;
        const name = (names[mcode[j]] ?? "?").replace(/^[^:]+:/, "").replaceAll("_", " ");
        text = `${name}\n${mx[j]}, ${my[j]}, ${mz[j]}\nMined by ${nameOf(mid[j])}`;
      }
      showInfo(text, e);
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => (info.hidden = true));

  // Follow mode keeps the selected turtle at the centre.
  let follow = false;
  const shift = new THREE.Vector3();

  // Name tags that would overlap one already shown are hidden: the selected
  // turtle's first, then the depot's and protected areas' (always shown), then
  // ones needing attention, then working ones, and so on.
  const PRIORITY = { attention: 1, working: 2, paused: 3, idle: 4, offline: 5 };
  const projected = new THREE.Vector3();
  function declutter() {
    if (labels.domElement.hidden) return;
    const { clientWidth: w, clientHeight: h } = container;
    const order = [...turtles.values()].sort((a, b) =>
      (a.data.id === selectedId ? 0 : PRIORITY[a.data.state] ?? 6) - (b.data.id === selectedId ? 0 : PRIORITY[b.data.state] ?? 6));
    const placed = [];
    const box = labels.domElement.getBoundingClientRect();
    const fixed = [];
    for (const g of [groups.depot, groups.areas]) {
      if (g.visible) g.traverse((o) => o.isCSS2DObject && o.element.style.display !== "none" && fixed.push(o.element));
    }
    let fixedPlaced = false;
    for (const e of order) {
      if (!fixedPlaced && e.data.id !== selectedId) {
        fixedPlaced = true;
        for (const el of fixed) {
          const r = el.getBoundingClientRect();
          placed.push([r.left - box.left, r.top - box.top, r.right - box.left, r.bottom - box.top]);
        }
      }
      projected.setFromMatrixPosition(e.tag.matrixWorld).project(camera);
      const x = ((projected.x + 1) / 2) * w;
      const y = ((1 - projected.y) / 2) * h;
      const half = (e.data.name.length * 7 + 14) / 2;
      const rect = [x - half, y - 10, x + half, y + 10];
      const clash = placed.some((p) => rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1]);
      if (!clash && Math.abs(projected.z) <= 1) placed.push(rect);
      const visibility = clash ? "hidden" : "";
      if (e.tag.element.style.visibility !== visibility) e.tag.element.style.visibility = visibility;
    }
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  let lastBuild = 0;
  let fitted = false;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!container.offsetParent && !document.fullscreenElement) return; // hidden
    if (minedDirty && now - lastBuild > 700) {
      rebuildMined();
      lastBuild = now;
    }
    for (const e of turtles.values()) {
      e.group.position.lerp(e.target, 0.25);
      e.group.scale.setScalar(THREE.MathUtils.clamp(camera.position.distanceTo(e.group.position) / 90, 1, 8));
    }
    const followed = follow && turtles.get(selectedId);
    if (followed) {
      shift.copy(followed.group.position).sub(controls.target).multiplyScalar(0.15);
      controls.target.add(shift);
      camera.position.add(shift);
    }
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    declutter();
  }
  requestAnimationFrame(frame);

  return {
    // list: [{ id, name, state, stateLabel, world, facing, home, job }]
    update(list, fleet, selected) {
      selectedId = selected;
      lastFleet = fleet;
      scene.background = cssColor("--page");
      updateTurtles(list);
      updateStatic(fleet, list);
      const bounds = contentBounds(fleet);
      if (!bounds.isEmpty()) {
        const groundY = fleet?.depot?.y ?? Math.round(bounds.max.y);
        updateGrid(bounds, groundY);
        if (!fitted) {
          fitted = true;
          fit();
        }
      }
    },
    addMined,
    clearMined,
    fit,
    setFollow(on) {
      follow = on;
    },
    setOptions({ oresOnly: ores, areas, jobs, names: showNames }) {
      info.hidden = true; // what it described may be gone
      if (ores !== undefined && ores !== oresOnly) {
        oresOnly = ores;
        needFull = minedDirty = true;
      }
      if (areas !== undefined) groups.areas.visible = areas;
      if (jobs !== undefined) groups.jobs.visible = jobs;
      if (showNames !== undefined) labels.domElement.hidden = !showNames;
    },
    stats() {
      return { mined: mx.length, ores: oreCount };
    },
  };
}
