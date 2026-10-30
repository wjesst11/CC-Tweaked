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

const contains = (b, p) => intersects(b, box(p.x, p.y, p.z, p.x, p.y, p.z));

// The dock, its chests and the space around it where turtles wait their turn
// (5 blocks out sideways, 2 up and down, as the turtle script uses): no job
// digs there, and no shaft comes up where a turtle might be waiting.
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
// anywhere it shouldn't. `ready` is [{ id, name }]; `homes` is [{ name, home }]
// for every known turtle (home in world coordinates). Returns
// { assignments: [{ id, args, volume }] } or { error }.
export function planFleetJob(fleet, kind, params, ready, homes) {
  if (!fleet.depot) return { error: "Set up the depot first (Fleet settings)." };
  if (!ready.length) return { error: "No turtles are ready." };
  let jobs;

  if (kind === "branchMine") {
    const dir = COMPASS.indexOf(params.dir);
    const [x, z, y] = [coord(params.x), coord(params.z), height(params.y)];
    const length = int(params.length, 1, 1024);
    const spacing = int(params.spacing ?? 3, 2, 16);
    const band = int(params.band ?? 0, 0, 16);
    const goal = int(params.goal ?? 0, 0, 100_000);
    const goalItem = params.goalItem ?? "valuables";
    if (dir < 0 || [x, z, y, length, spacing, band, goal].includes(null) || !GOAL_ITEMS.includes(goalItem)) {
      return { error: "Check the tunnel settings." };
    }
    const right = (dir + 1) % 4;
    // Each turtle owns a slice of rock: its tunnel line, half the spacing to
    // either side (for veins) and the height band above and below.
    const [left, rightSide] = [Math.floor((spacing - 1) / 2), Math.ceil((spacing - 1) / 2)];
    const [y1, y2] = [Math.max(-64, y - band), Math.min(319, y + 1 + band)];
    jobs = ready.map((_, k) => {
      const sx = x + k * spacing * CX[right];
      const sz = z + k * spacing * CZ[right];
      const ex = sx + (length - 1) * CX[dir];
      const ez = sz + (length - 1) * CZ[dir];
      return {
        args: { kind, x: sx, z: sz, y, dir: COMPASS[dir], length, scan: params.scan !== false, spacing, band, goal, goalItem },
        volume: box(
          sx - left * CX[right], y1, sz - left * CZ[right],
          ex + rightSide * CX[right], y2, ez + rightSide * CZ[right],
        ),
        // The 1x1 shaft down from wherever the column is open above.
        shaft: box(sx, y + 2, sz, sx, 319, sz),
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

  // Where a shaft starts depends on where its column is open (it may be a
  // cave or room under a base), so only the job itself is checked against
  // protected areas. Turtles never dig inside one anyway.
  const depot = depotBox(fleet.depot);
  for (const job of jobs) {
    for (const area of fleet.protect.areas) {
      if (intersects(job.volume, area)) return { error: `The job would dig into the protected area "${area.name || "unnamed"}".` };
    }
    for (const part of [job.volume, job.shaft].filter(Boolean)) {
      if (intersects(part, depot)) return { error: "The job would dig at the depot, or where turtles wait for it (within 5 blocks)." };
      for (const { name, home } of homes) {
        if (home && contains(part, home)) return { error: `The job would dig out ${name}'s home.` };
      }
    }
  }
  return { assignments: jobs.map((job, k) => ({ id: ready[k].id, args: job.args, volume: job.volume })) };
}
