// Fleet settings and fleet-job planning. Pure functions, shared by the server
// and its tests. Coordinates are Minecraft world coordinates (north = -Z).

export const COMPASS = ["north", "east", "south", "west"];
const CX = [0, 1, 0, -1];
const CZ = [-1, 0, 1, 0];
const SIDES = ["north", "east", "south", "west", "up", "down"];
// What a level job can be told to collect (the turtle script has the same list).
export const GOAL_ITEMS = ["diamond", "redstone", "gold", "lapis", "iron", "copper", "coal", "emerald", "debris", "valuables"];

export const DEFAULT_FLEET = {
  updatedAt: 0,
  depot: null, // { x, y, z, junk, valuables, fuel } with each chest's side of the dock
  refuelTo: 10000,
  protect: {
    blocks: ["*chest*", "*barrel*", "*shulker_box*", "*hopper*", "create:*"],
    areas: [], // { name, x1, y1, z1, x2, y2, z2 }
  },
  items: {
    valuables: [
      "*diamond*", "*emerald*", "*raw_*", "*_ore", "*redstone*", "*lapis*",
      "*ancient_debris*", "*netherite*", "*quartz*", "*amethyst_shard*", "*gold_nugget*",
    ],
    fuel: ["minecraft:coal", "minecraft:charcoal", "minecraft:coal_block"],
  },
  veinBlocks: ["*_ore", "*ancient_debris*"],
};

function int(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

const coord = (v) => int(v, -30_000_000, 30_000_000);
const height = (v) => int(v, -64, 320);

function patterns(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  return list
    .filter((s) => typeof s === "string")
    .map((s) => s.trim().toLowerCase().slice(0, 64))
    .filter(Boolean)
    .slice(0, 60);
}

export function sanitizeFleet(input = {}) {
  const d = input.depot;
  const depotCoords = d && [coord(d.x), height(d.y), coord(d.z)];
  const depot =
    depotCoords && depotCoords.every((n) => n !== null)
      ? {
          x: depotCoords[0],
          y: depotCoords[1],
          z: depotCoords[2],
          junk: SIDES.includes(d.junk) ? d.junk : "down",
          valuables: SIDES.includes(d.valuables) ? d.valuables : "north",
          fuel: SIDES.includes(d.fuel) ? d.fuel : "west",
        }
      : null;
  const areas = (Array.isArray(input.protect?.areas) ? input.protect.areas : [])
    .slice(0, 50)
    .map((a) => ({
      name: String(a?.name ?? "").slice(0, 40),
      x1: coord(a?.x1), y1: height(a?.y1), z1: coord(a?.z1),
      x2: coord(a?.x2), y2: height(a?.y2), z2: coord(a?.z2),
    }))
    .filter((a) => [a.x1, a.y1, a.z1, a.x2, a.y2, a.z2].every((n) => n !== null));
  return {
    updatedAt: Number(input.updatedAt) || 0,
    depot,
    refuelTo: int(input.refuelTo, 100, 1_000_000) ?? DEFAULT_FLEET.refuelTo,
    protect: { blocks: patterns(input.protect?.blocks, DEFAULT_FLEET.protect.blocks), areas },
    items: {
      valuables: patterns(input.items?.valuables, DEFAULT_FLEET.items.valuables),
      fuel: patterns(input.items?.fuel, DEFAULT_FLEET.items.fuel),
    },
    veinBlocks: patterns(input.veinBlocks, DEFAULT_FLEET.veinBlocks),
  };
}

const box = (x1, y1, z1, x2, y2, z2) => ({
  x1: Math.min(x1, x2), x2: Math.max(x1, x2),
  y1: Math.min(y1, y2), y2: Math.max(y1, y2),
  z1: Math.min(z1, z2), z2: Math.max(z1, z2),
});

const normal = (a) => box(a.x1, a.y1, a.z1, a.x2, a.y2, a.z2);

function intersects(a, b) {
  a = normal(a);
  b = normal(b);
  return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1 && a.z1 <= b.z2 && a.z2 >= b.z1;
}

// A home cylinder extends through every Y. Its radius measures only world XZ.
const insideCylinder = (cylinder, point) =>
  (point.x - cylinder.x) ** 2 + (point.z - cylinder.z) ** 2 <= cylinder.radius ** 2;

// Work bounds are conservative boxes around a lane. Only integer block cells
// inside that turtle's original-home cylinder can actually be mined.
function intersectsWork(a, b, circle) {
  if (!intersects(a, b)) return false;
  if (!circle) return true;
  a = normal(a);
  b = normal(b);
  const x = Math.max(a.x1, b.x1, Math.min(circle.x, a.x2, b.x2));
  const z = Math.max(a.z1, b.z1, Math.min(circle.z, a.z2, b.z2));
  return insideCylinder(circle, { x, z });
}

// The dock, its chests and the space around it where turtles wait their turn
// (5 blocks out sideways, 2 up and down, as the turtle script uses): no job
// digs there, and no access stair reaches where a turtle might be waiting.
function depotBox(D) {
  return box(D.x - 5, D.y - 2, D.z - 5, D.x + 5, D.y + 2, D.z + 5);
}

// Returns an error message, or null if the settings are usable.
export function validateFleet(fleet) {
  if (!fleet.depot) return null;
  const { junk, valuables, fuel } = fleet.depot;
  if (new Set([junk, valuables, fuel]).size < 3) return "Each depot chest needs its own side of the dock.";
  return null;
}

// Splits a fleet job between the ready turtles and checks it can't dig
// anywhere it shouldn't. For level jobs `ready` is [{ id, name, home }], with
// a confirmed, south-facing home in the surface row; `homes` is [{ name, home }]
// for every known turtle (home in world coordinates). Returns
// { assignments: [{ id, args, volume }] } or { error }.
export function planFleetJob(fleet, kind, params, ready, homes) {
  if (!fleet.depot) return { error: "Set up the depot first (Fleet settings)." };
  if (!ready.length) return { error: "No turtles are ready." };
  let jobs;
  let selected = ready;

  if (kind === "branchMine") {
    if (params.routeMode !== "southRow") {
      return { error: "This level job uses an old route layout. Create a new south-row level job." };
    }
    if (fleet.depot.y !== 67) return { error: "The shared depot must be at Y=67 for south-row mining." };
    const y = Number(params.y);
    if (params.y === null || !Number.isInteger(y) || y < -64 || y > 67) {
      return { error: "Check the tunnel settings." };
    }
    const radius = params.radius;
    if (!Number.isInteger(radius) || radius < 1 || radius > 1024) {
      return { error: "Choose a mining radius from 1 to 1024 whole blocks, measured horizontally from each turtle's original home." };
    }
    for (const turtle of ready) {
      const home = turtle.home;
      if (!home || !Number.isInteger(home.x) || coord(home.x) === null ||
          home.y !== 67 || home.z !== -55 || home.facing !== "south") {
        return { error: `${turtle.name || `Turtle ${turtle.id}`} needs a confirmed south-facing home at Y=67, Z=-55.` };
      }
    }
    if (new Set(ready.map(({ home }) => home.x)).size !== ready.length) {
      return { error: "Each turtle needs its own X position in the home row." };
    }
    selected = [...ready].sort((a, b) => b.home.x - a.home.x);
    const x = selected[0].home.x, z = -55 + 67 - y;
    const spacing = 2, band = 0, goal = 0, goalItem = "valuables", scan = true;
    for (const [k, turtle] of selected.entries()) {
      const home = turtle.home, cylinder = { x: home.x, z: home.z, radius };
      const bottom = { x: home.x, z }, lane = { x: x - k * spacing, z };
      if (!insideCylinder(cylinder, bottom)) {
        const needed = Math.ceil(Math.hypot(bottom.x - home.x, bottom.z - home.z));
        return { error: `${turtle.name || `Turtle ${turtle.id}`}'s staircase leaves the home cylinder; it needs at least ${needed} blocks horizontally.` };
      }
      if (!insideCylinder(cylinder, lane)) {
        const needed = Math.ceil(Math.hypot(lane.x - home.x, lane.z - home.z));
        return { error: `${turtle.name || `Turtle ${turtle.id}`}'s assigned lane starts outside its home cylinder. It needs at least ${needed} blocks horizontally; increase the radius or select fewer turtles.` };
      }
    }
    const dir = COMPASS.indexOf("south"), entryY = 67;
    const right = (dir + 1) % 4;
    // Automatic lanes have one shared wall. Their ore-check bounds include
    // every exposed side, and the circle clips the final reachable blocks.
    const [left, rightSide] = [Math.floor((spacing - 1) / 2), Math.ceil((spacing - 1) / 2)];
    const [y1, y2] = [Math.max(-64, y - band), Math.min(319, y + 1 + band)];
    jobs = selected.map((turtle, k) => {
      const sx = x + k * spacing * CX[right];
      const sz = z + k * spacing * CZ[right];
      const maxSouth = Math.floor(Math.sqrt(radius ** 2 - (sx - turtle.home.x) ** 2));
      const length = turtle.home.z + maxSouth - sz + 1;
      const ex = sx + (length - 1) * CX[dir];
      const ez = sz + (length - 1) * CZ[dir];
      // Shared walls have a single owner. The outer lanes also own their
      // exposed outside wall, even with the one-block gap of spacing 2.
      const sliceLeft = scan && k === 0 ? Math.max(1, left) : left;
      const sliceRight = scan && k === ready.length - 1 ? Math.max(1, rightSide) : rightSide;
      const halo = scan ? 1 : 0;
      const volume = box(
        sx - halo * CX[dir] - sliceLeft * CX[right], Math.max(-64, y1 - halo), sz - halo * CZ[dir] - sliceLeft * CZ[right],
        ex + halo * CX[dir] + sliceRight * CX[right], Math.min(319, y2 + halo), ez + halo * CZ[dir] + sliceRight * CZ[right],
      );
      return {
        args: {
          kind, x: sx, z: sz, y, dir: COMPASS[dir], radius, length, scan, spacing, band, goal, goalItem,
          routeMode: "southRow", routeHome: { ...turtle.home },
          stairBottom: { x: turtle.home.x, y, z }, access: "southStairs", entryY,
          ...(scan ? { coverage: "allSides", veinBounds: volume } : {}),
        },
        volume,
        circle: { x: turtle.home.x, z: turtle.home.z, radius },
        // Assembly and later returns run across the bottom level. Only the
        // initial descent may cross protected areas; these corridors may not.
        assembly: box(turtle.home.x, y, z, sx, y + 1, z),
        // Forward, then down, from this turtle's own saved surface home.
        // The surface home itself is never an access block to be dug out.
        access: Array.from({ length: entryY - y }, (_, index) => {
          const step = index + 1, py = entryY - step, pz = -55 + step;
          return box(turtle.home.x, py, pz, turtle.home.x, py + 1, pz);
        }),
      };
    });
  } else if (kind === "areaQuarry") {
    const v = [coord(params.x1), coord(params.z1), coord(params.x2), coord(params.z2), height(params.yTop), height(params.yBottom)];
    if (v.includes(null)) return { error: "Check the quarry corners and levels." };
    const b = box(v[0], v[5], v[1], v[2], v[4], v[3]);
    // Split into strips along the longer side, one per turtle.
    const alongX = b.x2 - b.x1 >= b.z2 - b.z1;
    const lo = alongX ? b.x1 : b.z1;
    const span = (alongX ? b.x2 : b.z2) - lo + 1;
    const count = Math.min(ready.length, span);
    jobs = [];
    let start = lo;
    for (let k = 0; k < count; k++) {
      const size = Math.floor(span / count) + (k < span % count ? 1 : 0);
      const [a1, a2] = [start, start + size - 1];
      start += size;
      const s = alongX ? box(a1, b.y1, b.z1, a2, b.y2, b.z2) : box(b.x1, b.y1, a1, b.x2, b.y2, a2);
      jobs.push({ args: { kind, x1: s.x1, x2: s.x2, z1: s.z1, z2: s.z2, yTop: s.y2, yBottom: s.y1 }, volume: s });
    }
  } else {
    return { error: `Unknown job type ${kind}.` };
  }

  // Access geometry is known before dispatch, including every headroom block.
  // Validate each stair column rather than its much larger enclosing box.
  const depot = depotBox(fleet.depot);
  for (const job of jobs) {
    const work = [job.volume, ...(job.assembly ? [job.assembly] : [])];
    for (const part of [...work, ...(job.access ?? [])]) {
      if ([part.x1, part.x2, part.z1, part.z2].some((value) => coord(value) === null)) {
        return { error: "The job or its access stairs extend beyond the world coordinate limits." };
      }
      // Protected block types remain enforced by the turtle everywhere. This
      // exemption concerns protected coordinates on the initial stairs only.
      if (work.includes(part)) {
        for (const area of fleet.protect.areas) {
          if (intersectsWork(part, area, job.circle)) return { error: `The job would dig into the protected area "${area.name || "unnamed"}".` };
        }
      }
      if (intersectsWork(part, depot, job.circle)) return { error: "The job would dig at the depot, or where turtles wait for it (within 5 blocks)." };
      for (const { name, home } of homes) {
        if (home && intersectsWork(part, box(home.x, home.y, home.z, home.x, home.y, home.z), job.circle)) {
          return { error: `The job would dig out ${name}'s home.` };
        }
      }
    }
  }
  return { assignments: jobs.map((job, k) => ({ id: selected[k].id, args: job.args, volume: job.volume })) };
}
