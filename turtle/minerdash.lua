-- MinerDash turtle client for CC:Tweaked.
--
-- Install (in game):  wget https://<your-app>/turtle.lua startup.lua
-- Then run "startup" (or reboot). Run "startup setup" to change the URL or token.
--
-- Movement is tracked in local coordinates: x/y/z start at 0,0,0 where the
-- turtle first ran, and heading 0 is the direction it was facing then. With a
-- wireless/ender modem and a GPS network, the turtle also works out its world
-- coordinates and compass facing.
--
-- Row miners capture their own home at Y=67, Z=-55 before their first job.
-- A saved south staircase and bottom waypoint are their only mining-home route.
--
-- Two kinds of jobs:
--  * Local jobs (quarry, tunnel) unload into a chest placed directly behind
--    the spot where the job started.
--  * Fleet jobs (branchMine, areaQuarry) work in world coordinates and share one
--    depot: a dock block with junk, valuables and fuel chests next to it. The
--    server gives turtles turns at the dock; the others wait a few blocks away.
--    Turtles share where they are, so they steer around each other.
-- Protected blocks are never dug. Only initial south-stair excavation may
-- cross protected areas; all later mining retains ordinary area protection.

local VERSION = "2.3.4"
local DEFAULT_URL = "__WS_URL__"
local STATE_FILE = ".minerdash_state"
local FLEET_FILE = ".minerdash_fleet"
local MAX_VISITED = 10000 -- optional obstacle cache, never authority for a home route
local STOP = setmetatable({}, { __tostring = function() return "Stopped" end })

if not turtle then error("MinerDash must run on a turtle", 0) end
if not (http and http.websocket) then
  error("The HTTP API (with websockets) is disabled in the CC:Tweaked config", 0)
end

-- Config --------------------------------------------------------------------

settings.define("minerdash.url", { description = "Dashboard websocket URL", type = "string" })
settings.define("minerdash.token", { description = "Turtle token (TURTLE_TOKEN on the server)", type = "string" })

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- Accept what people actually paste (https://my-app..., a bare host name, with
-- or without /ws/turtle) and turn it into the websocket URL. nil if it isn't
-- an address at all.
local function toSocketUrl(input)
  local s = trim(input)
    :gsub("^(%a+)://", function(scheme) return scheme:lower() .. "://" end)
    :gsub("^http", "ws")
  if not s:match("^wss?://") then s = "wss://" .. s end
  s = s:gsub("/+$", "")
  local host = s:match("^wss?://([^/]+)")
  if not host or not (host:find(".", 1, true) or host:match("^localhost")) then return nil end
  if not s:match("/ws/turtle$") then s = s .. "/ws/turtle" end
  return s
end

local url = settings.get("minerdash.url") or DEFAULT_URL
local token = settings.get("minerdash.token")
local hasUrl = url:match("^wss?://") ~= nil
local reconfigure = ({ ... })[1] == "setup"
if reconfigure or not hasUrl or not token then
  print("MinerDash setup")
  -- A copy downloaded from the dashboard already knows its address.
  if reconfigure or not hasUrl then
    if hasUrl then print("Server: " .. url .. "\nPress Enter to keep it.") end
    while true do
      write("Server address: ")
      local input = trim(read())
      if input == "" and hasUrl then break end
      local candidate = toSocketUrl(input)
      if candidate then
        url = candidate
        break
      end
      print("Type your app's address, like my-app.ondigitalocean.app")
    end
  end
  print("Server: " .. url)
  if token then print("Press Enter to keep the current token.") end
  repeat
    write("Turtle token: ")
    local input = trim(read("*"))
    if input ~= "" then token = input end
    if not token then print("Paste TURTLE_TOKEN from DigitalOcean.") end
  until token
  settings.set("minerdash.url", url)
  settings.set("minerdash.token", token)
  settings.save()
end

-- State ---------------------------------------------------------------------

local pos = { x = 0, y = 0, z = 0 }
local heading = 0 -- 0 = +z, 1 = +x, 2 = -z, 3 = -x
local home = { x = 0, y = 0, z = 0, heading = 0 }
local DX = { [0] = 0, [1] = 1, [2] = 0, [3] = -1 }
local DZ = { [0] = 1, [1] = 0, [2] = -1, [3] = 0 }

local ws          -- open websocket, nil while offline
local authFailed = false
local queue = {}  -- commands waiting for the worker
local job         -- { name, detail, progress, paused } while a job runs
local stopRequested = false
local pauseRequested = false
local updateRequested = false -- a running fleet job updates between steps
local pendingTrip -- way back out of a cancelled local job
local dirty = true
local around      -- block names next to the turtle (refreshed when idle)
local calib       -- GPS anchor { l = local pos, w = world pos, f0 = compass of heading 0 }
local gpsState = "none" -- "none" (no wireless modem), "nofix" or "ok"
local gpsChecked = false -- a GPS fix has been attempted since boot
local leases = {} -- resource -> "granted" | "waiting"
local fleetJob    -- { kind, args, step, phase, paused, failed } for the current fleet job
local lastFleetResult -- durable receipt for an automatically queued assignment
local miningRoute -- fixed row home and opened south staircase, independent of a job
local rowRoute = {}
-- Grouped so the main chunk stays well under CC:Tweaked's limit of 200
-- local variables; past it, the script no longer loads on a turtle.
local net = {}  -- dashboard connection, GPS and messages
local dock = {} -- the shared depot's dock and chests
local cfg = {}  -- fleet settings: loading and block patterns
local nav = {}  -- route finding internals
local vein = {} -- following ore veins
local blocked, blockedCount = {}, 0 -- blocks found in the way while travelling (local coords)
local traffic, trafficCount = {}, 0 -- blocks moving turtles are in or about to enter -> until when
local parked = {}                   -- blocks turtles are standing still in -> until when
local homesNear = {}                -- other turtles' homes nearby -> until when
local visited, visitedCount = {}, 0 -- bounded cache for fallen blocks during ordinary travel
local forgetVisited, remember
local travelNext                    -- the block this turtle is about to move into
local physicalMove = false          -- GPS must not change pos during a yielding move API
local odometer = 0                  -- blocks moved, ever (to measure real trip lengths)

-- Shared fleet settings from the dashboard. These defaults apply until the
-- server sends its copy; the latest copy is kept on disk so protection still
-- works while offline.
local fleet = {
  updatedAt = 0,
  refuelTo = 10000,
  protect = { blocks = { "*chest*", "*barrel*", "*shulker_box*", "*hopper*", "create:*", "!create:*_ore" }, areas = {} },
  items = {
    valuables = {
      "*diamond*", "*emerald*", "*raw_*", "*_ore", "*redstone*", "*lapis*",
      "*ancient_debris*", "*netherite*", "*quartz*", "*amethyst_shard*", "*gold_nugget*",
    },
    fuel = { "minecraft:coal", "minecraft:charcoal", "minecraft:coal_block" },
  },
  veinBlocks = { "*_ore", "*ancient_debris*" },
}

local function loadState()
  if not fs.exists(STATE_FILE) then return end
  local f = fs.open(STATE_FILE, "r")
  local data = textutils.unserialize(f.readAll())
  f.close()
  if type(data) == "table" and data.pos then
    pos, heading, home, calib = data.pos, data.heading, data.home, data.calib
    fleetJob = data.fleetJob
    lastFleetResult = data.lastFleetResult
    miningRoute = data.miningRoute
    odometer = tonumber(data.odometer) or 0
    if data.holding then leases.depot = "granted" end
  end
end

-- A copy with every repeated table written out separately. Only a table
-- inside itself is an error.
local function plainCopy(value, active)
  if type(value) ~= "table" then return value end
  active = active or {}
  if active[value] then error("Cannot serialize table with recursive entries", 0) end
  active[value] = true
  local copy = {}
  for k, v in pairs(value) do copy[plainCopy(k, active)] = plainCopy(v, active) end
  active[value] = nil
  return copy
end

local function saveState()
  -- Job and independent return paths share coordinate tables (the vein path
  -- is in both). CC:Tweaked versions without allow_repetitions reject a
  -- table seen twice, so save a plain copy instead of relying on that option.
  -- Serialize first so an error cannot truncate the last saved home/route.
  local encoded = textutils.serialize(plainCopy({
    pos = pos, heading = heading, home = home, calib = calib,
    fleetJob = fleetJob, lastFleetResult = lastFleetResult, miningRoute = miningRoute,
    holding = leases.depot == "granted", odometer = odometer,
  }))
  local f, err = fs.open(STATE_FILE, "w")
  if not f then error("Cannot save turtle state: " .. tostring(err), 0) end
  f.write(encoded)
  f.close()
end

local function changed() dirty = true end

local function send(msg)
  if not ws then return false end
  return (pcall(function() ws.send(textutils.serializeJSON(msg)) end))
end

local function say(level, text)
  if term.isColor() then
    term.setTextColor(level == "error" and colors.red or level == "warn" and colors.yellow or colors.white)
  end
  print(text)
  term.setTextColor(colors.white)
end

local function log(level, text)
  say(level, text)
  send({ type = "log", level = level, msg = text })
end

local function clampInt(value, lo, hi, default)
  value = math.floor(tonumber(value) or default)
  return math.max(lo, math.min(hi, value))
end

local function here()
  return { x = pos.x, y = pos.y, z = pos.z, heading = heading }
end

local function setHome()
  home = here()
  forgetVisited()
  remember(pos)
  saveState()
  changed()
end

local function setDetail(detail, progress)
  if not job then return end
  job.detail = detail
  if progress then job.progress = progress end
  changed()
end

-- Called at every safe point in a job: raises STOP to cancel, and holds still
-- while paused. Never pauses while holding the depot dock, so a paused turtle
-- can't block the rest of the fleet.
local function checkStop()
  if stopRequested then error(STOP, 0) end
  if not pauseRequested or leases.depot == "granted" then return end
  local function giveUpDockTurn()
    if leases.depot then
      leases.depot = "waiting" -- asked for again once resumed
      send({ type = "lease", resource = "depot", op = "release" })
    end
  end
  giveUpDockTurn()
  if job then job.paused = true end
  if fleetJob then
    fleetJob.paused = true
    saveState()
  end
  changed()
  while pauseRequested and not stopRequested do
    sleep(0.5)
    if leases.depot == "granted" then giveUpDockTurn() end -- a grant raced the release
  end
  if job then job.paused = nil end
  if fleetJob then
    fleetJob.paused = nil
    saveState()
  end
  changed()
  if stopRequested then error(STOP, 0) end
end

-- Sleep in short steps so cancel and pause are noticed quickly.
local function waitSeconds(seconds)
  local deadline = os.clock() + seconds
  repeat
    checkStop()
    sleep(0.5)
  until os.clock() >= deadline
end

-- GPS -------------------------------------------------------------------------
-- A GPS fix anchors the local frame to the world. The first fix after a
-- horizontal move reveals which compass direction local heading 0 points.

local COMPASS = { [0] = "north", [1] = "east", [2] = "south", [3] = "west" }
local COMPASS_INDEX = { north = 0, east = 1, south = 2, west = 3 }
local CX = { [0] = 0, [1] = 1, [2] = 0, [3] = -1 } -- world X/Z step per compass direction
local CZ = { [0] = -1, [1] = 0, [2] = 1, [3] = 0 }

local function samePos(a, b)
  return a.x == b.x and a.y == b.y and a.z == b.z
end

local function distance(a, b)
  return math.abs(a.x - b.x) + math.abs(a.y - b.y) + math.abs(a.z - b.z)
end

-- World coordinates are only trusted once the facing is known and not in doubt.
local function gpsTrusted()
  return calib ~= nil and calib.f0 ~= nil and calib.slip == nil
end

local function toWorld(p)
  if not (calib and calib.f0) then return nil end
  local dx, dz = p.x - calib.l.x, p.z - calib.l.z
  local a, b = calib.f0, (calib.f0 + 1) % 4
  return {
    x = calib.w.x + dz * CX[a] + dx * CX[b],
    y = calib.w.y + p.y - calib.l.y,
    z = calib.w.z + dz * CZ[a] + dx * CZ[b],
  }
end

local function fromWorld(w)
  local dX, dZ = w.x - calib.w.x, w.z - calib.w.z
  local a, b = calib.f0, (calib.f0 + 1) % 4
  return {
    x = calib.l.x + dX * CX[b] + dZ * CZ[b],
    y = calib.l.y + w.y - calib.w.y,
    z = calib.l.z + dX * CX[a] + dZ * CZ[a],
  }
end

local function worldPos()
  if calib and calib.f0 then return toWorld(pos) end
  if calib and samePos(pos, calib.l) then return calib.w end
end

-- l: local position when the fix was taken, w: rounded GPS position.
function net.onFix(l, w)
  local savedHome = calib and calib.home
  if calib and calib.f0 then
    local slip = calib.slip
    local pending = miningRoute and miningRoute.pendingMove
    -- A reboot can land between the physical move and its position save.
    -- Accept only that exact, durably intended adjacent destination.
    if pending and samePos(toWorld(l), pending.from) and samePos(w, pending.to) and distance(pending.from, pending.to) == 1 then
      pos = fromWorld(w)
      odometer = odometer + 1
      miningRoute.pendingMove, calib.slip = nil, nil
      remember(pos)
      saveState()
      rowRoute.reconcile()
      changed()
      return
    end
    if samePos(toWorld(l), w) then
      -- Exactly where it thinks it is: any half-finished move is settled.
      if pending then miningRoute.pendingMove = nil; saveState() end
      -- A matching fix after a sideways move confirms the heading as well.
      if slip and (l.x ~= slip.x or l.z ~= slip.z) then
        calib.slip = nil
        saveState()
        changed()
      end
      return
    end
    -- Don't keep digging on a position that might be wrong, and forget
    -- obstacles remembered relative to it.
    if job then stopRequested = true end
    blocked, blockedCount = {}, 0
    -- GPS now says where it is, so a half-finished move no longer matters.
    if miningRoute then miningRoute.pendingMove = nil end
    if not slip then
      -- First assume only the position slipped (e.g. the server stopped mid-move).
      pos = fromWorld(w)
      -- A corrected position keeps the same coordinate frame and saved home.
      remember(pos)
      calib.slip = { x = pos.x, z = pos.z }
      saveState()
      changed()
      log("warn", "GPS corrected the tracked position")
      return
    end
    -- Still wrong after correcting: the heading is off too, so it was moved by
    -- hand. Recalibrate, but keep home at its real location.
    log("warn", "Turtle was moved. Move it one block to recalibrate GPS.")
    savedHome = { w = toWorld(home), compass = (calib.f0 + home.heading) % 4 }
    forgetVisited()
  elseif calib and (l.x ~= calib.l.x or l.z ~= calib.l.z) then
    for f0 = 0, 3 do
      calib.f0 = f0
      if samePos(toWorld(l), w) then
        if savedHome then
          home = fromWorld(savedHome.w)
          home.heading = (savedHome.compass - f0) % 4
          calib.home = nil
          forgetVisited()
          remember(pos)
        end
        saveState()
        changed()
        log("info", "GPS calibrated, facing " .. COMPASS[(f0 + heading) % 4])
        return
      end
    end
    -- No direction fits (moved by hand while calibrating?): re-anchor below.
  elseif calib and l.y - calib.l.y == w.y - calib.w.y then
    return -- hasn't moved sideways yet
  end
  calib = { l = { x = l.x, y = l.y, z = l.z }, w = w, home = savedHome }
  saveState()
  changed()
end

-- Fleet settings & protection ---------------------------------------------------

local compiled = { protect = {}, unprotect = {}, valuables = {}, fuel = {}, vein = {} }

-- "*" is the only wildcard; everything else matches literally.
function cfg.glob(pattern)
  local escaped = pattern:lower():gsub("[%^%$%(%)%%%.%[%]%+%-%?]", "%%%0")
  return "^" .. escaped:gsub("%*", ".*") .. "$"
end

function cfg.compileList(list)
  local out = {}
  for _, p in ipairs(type(list) == "table" and list or {}) do
    if type(p) == "string" and p ~= "" then out[#out + 1] = cfg.glob(p) end
  end
  return out
end

function cfg.compileFleet()
  local protect, items = fleet.protect or {}, fleet.items or {}
  -- A protected-block line starting with "!" is an exception: "create:*"
  -- with "!create:*_ore" protects every Create block except its ores.
  local keep, except = {}, {}
  for _, p in ipairs(type(protect.blocks) == "table" and protect.blocks or {}) do
    if type(p) == "string" and p:sub(1, 1) == "!" then except[#except + 1] = p:sub(2)
    else keep[#keep + 1] = p end
  end
  compiled.protect = cfg.compileList(keep)
  compiled.unprotect = cfg.compileList(except)
  compiled.valuables = cfg.compileList(items.valuables)
  compiled.fuel = cfg.compileList(items.fuel)
  compiled.vein = cfg.compileList(fleet.veinBlocks)
end

local function matches(name, patterns)
  name = name:lower()
  for _, p in ipairs(patterns) do
    if name:find(p) then return true end
  end
  return false
end

function cfg.protectedName(name)
  return matches(name, compiled.protect) and not matches(name, compiled.unprotect)
end

function cfg.loadFleet()
  if fs.exists(FLEET_FILE) then
    local f = fs.open(FLEET_FILE, "r")
    local data = textutils.unserialize(f.readAll())
    f.close()
    if type(data) == "table" then fleet = data end
  end
  cfg.compileFleet()
end

function cfg.adoptFleet(c)
  if type(c) ~= "table" or (tonumber(c.updatedAt) or 0) <= (fleet.updatedAt or 0) then return end
  fleet = c
  cfg.compileFleet()
  local f = fs.open(FLEET_FILE, "w")
  f.write(textutils.serialize(fleet))
  f.close()
  changed()
end

local LIQUIDS = { ["minecraft:water"] = true, ["minecraft:lava"] = true }

local function isTurtleBlock(name)
  return name:find("^computercraft:turtle") ~= nil
end

local function neighbour(dir)
  if dir == "up" then return { x = pos.x, y = pos.y + 1, z = pos.z } end
  if dir == "down" then return { x = pos.x, y = pos.y - 1, z = pos.z } end
  local sign = dir == "back" and -1 or 1
  return { x = pos.x + DX[heading] * sign, y = pos.y, z = pos.z + DZ[heading] * sign }
end

-- Blocks dug, waiting to be reported for the dashboard's 3D map:
-- { x, y, z, name } in world coordinates. Only recorded with GPS.
local dugLog = {}

local function noteDug(dir, name)
  -- Ore blocks the current fleet job has mined, by block name.
  if fleetJob and matches(name, compiled.vein) then
    fleetJob.ores = fleetJob.ores or {}
    fleetJob.ores[name] = (fleetJob.ores[name] or 0) + 1
  end
  if not gpsTrusted() then return end
  local w = toWorld(neighbour(dir))
  if #dugLog >= 5000 then table.remove(dugLog, 1) end
  dugLog[#dugLog + 1] = { w.x, w.y, w.z, name }
end

local function inBox(w, a)
  return w.x >= math.min(a.x1, a.x2) and w.x <= math.max(a.x1, a.x2)
    and w.y >= math.min(a.y1, a.y2) and w.y <= math.max(a.y1, a.y2)
    and w.z >= math.min(a.z1, a.z2) and w.z <= math.max(a.z1, a.z2)
end

-- Why the block on side `dir` (forward/up/down) must not be dug or built in, or
-- nil if it may. ComputerCraft blocks (turtles, GPS hosts) are always protected.
local function protection(dir, block, context)
  if block then
    local name = block.name:lower()
    if name:find("^computercraft:") or cfg.protectedName(name) then
      return "protected block " .. block.name
    end
  end
  if miningRoute and miningRoute.radius then
    if not gpsTrusted() then return "GPS position unknown, so the home mining radius can't be checked" end
    if not rowRoute.withinRadius(toWorld(neighbour(dir))) then return "outside the mining radius from the saved home" end
  end
  local areas = fleet.protect and fleet.protect.areas or {}
  if #areas == 0 then return nil end
  if not gpsTrusted() then return "GPS position unknown, so protected areas can't be checked" end
  local w = toWorld(neighbour(dir))
  -- The sole area exception is the next saved cell of initial staircase
  -- excavation. Block patterns and ComputerCraft protection ran above first.
  if context == "initialStair" and rowRoute.initialCell(w) then
    return nil
  end
  for _, a in ipairs(areas) do
    if inBox(w, a) then return "protected area " .. tostring(a.name or "") end
  end
end

-- Movement ------------------------------------------------------------------

local function cellKey(x, y, z)
  return x .. "," .. y .. "," .. z
end

forgetVisited = function()
  visited, visitedCount = {}, 0
end

-- A bounded in-memory cache helps ordinary travel recognize fallen blocks.
-- It is never persisted or consulted to choose a route home.
remember = function(p)
  local k = cellKey(p.x, p.y, p.z)
  if visited[k] then return end
  if visitedCount >= MAX_VISITED then forgetVisited() end
  visited[k], visitedCount = true, visitedCount + 1
end

local SIDES = {
  forward = { move = turtle.forward, dig = turtle.dig, attack = turtle.attack, inspect = turtle.inspect },
  up = { move = turtle.up, dig = turtle.digUp, attack = turtle.attackUp, inspect = turtle.inspectUp },
  down = { move = turtle.down, dig = turtle.digDown, attack = turtle.attackDown, inspect = turtle.inspectDown },
  back = { move = turtle.back },
}

-- `manual` is a move you asked for from the dashboard: into open space only
-- (it never digs), so it goes ahead even when GPS hasn't confirmed where the
-- turtle is or it's outside its radius. That's how a confused turtle gets
-- moved by hand to find its facing again.
local function move(dir, manual)
  if miningRoute and miningRoute.radius and not manual then
    if not gpsTrusted() then return false, "GPS position unknown" end
    local current, target = toWorld(pos), toWorld(neighbour(dir))
    -- Moving through open air never digs, so surface trips and a flight
    -- home from where it was carried may leave the circle. Digging can't.
    local surfaceTravel = (rowRoute.surfacePhase() and current.y == 67 and target.y == 67) or rowRoute.flying
    if not surfaceTravel and not rowRoute.withinRadius(target) then return false, "Outside mining radius" end
  end
  if miningRoute and gpsTrusted() then
    miningRoute.pendingMove = { from = toWorld(pos), to = toWorld(neighbour(dir)) }
    saveState()
  end
  physicalMove = true
  local ok, err = SIDES[dir].move()
  physicalMove = false
  if ok then
    if dir == "up" then
      pos.y = pos.y + 1
    elseif dir == "down" then
      pos.y = pos.y - 1
    else
      local s = dir == "back" and -1 or 1
      pos.x, pos.z = pos.x + DX[heading] * s, pos.z + DZ[heading] * s
    end
    odometer = odometer + 1
    blocked[cellKey(pos.x, pos.y, pos.z)] = nil
    remember(pos)
    if miningRoute then miningRoute.pendingMove = nil end
    saveState()
    changed()
  end
  if not ok and miningRoute then miningRoute.pendingMove = nil; saveState() end
  return ok, err
end

local function turn(right)
  local ok, err = (right and turtle.turnRight or turtle.turnLeft)()
  if ok then
    heading = (heading + (right and 1 or 3)) % 4
    saveState()
    changed()
  end
  return ok, err
end

local function face(h)
  checkStop()
  local diff = (h - heading) % 4
  if diff == 3 then
    turn(false)
  else
    for _ = 1, diff do turn(true) end
  end
end

-- Dig until the space is empty. Returns false (and a reason) if it can't be or
-- mustn't be.
local function clear(dir, context)
  local side = SIDES[dir]
  local stays, dug = 0, nil
  for _ = 1, 64 do
    local found, block = side.inspect()
    if not found or LIQUIDS[block.name] then return true end
    if isTurtleBlock(block.name) then return false, "another turtle is in the way" end
    local reason = protection(dir, block, context)
    if reason then return false, reason end
    -- A block that doesn't fall but is still there after digging isn't
    -- breaking here: a mod or claim puts it back without saying so.
    if block.name == dug and not nav.hasFallen(block.name) then
      stays = stays + 1
      if stays >= 3 then return false, "Cannot break it: it is still there after digging" end
    end
    local ok, err = side.dig()
    if ok then noteDug(dir, block.name) end
    -- "Nothing to dig here" means it's already gone (another turtle got it).
    if not ok and err ~= "Nothing to dig here" then return false, err end
    dug = block.name
    -- Let gravel/sand above us land so it gets dug on the next pass.
    if dir == "up" and (block.name:find("gravel") or block.name:find("sand") or block.name:find("powder")) then
      sleep(0.4)
    end
  end
  return false, "Too many falling blocks"
end

-- Blocks it must not or cannot break: protected by its own settings, or
-- refused by the game ("Cannot break protected block" under spawn
-- protection or a land claim, "Cannot break unbreakable block" for bedrock).
local function forbidden(why)
  return type(why) == "string" and (why:find("^protected ") ~= nil or why:find("^Cannot break") ~= nil)
end

-- Move one block, digging or attacking whatever is in the way. Another turtle
-- in the way is waited for rather than dug, for as long as it takes unless
-- `patience` (seconds) runs out: then it returns false, as it does with
-- the reason and the block's name at a block it may not break. Pause and
-- cancel still work while it waits.
local function tryDigMove(dir, context, patience)
  local side = SIDES[dir]
  local waited, tries = 0, 0
  while true do
    checkStop()
    local ok, err = move(dir)
    if ok then return true end
    if err == "Outside mining radius" then error(err, 0) end
    if err == "Out of fuel" then error("Out of fuel", 0) end
    local found, block = side.inspect()
    if found and isTurtleBlock(block.name) then
      -- Waiting on a turtle doesn't use up its tries.
      waited = waited + 0.5
      if patience and waited > patience then return false, "another turtle is in the way", block.name end
      if waited == 5 then setDetail("Waiting for another turtle to move") end
      sleep(0.5)
    else
      tries = tries + 1
      if tries > 400 then error("Can't move " .. dir, 0) end
      if found and not LIQUIDS[block.name] then
        local cleared, why = clear(dir, context)
        if not cleared and forbidden(why) then return false, why, block.name end
        if not cleared and why ~= "another turtle is in the way" then
          error(("Can't dig %s: %s"):format(block.name, why or "unknown"), 0)
        end
      elseif not side.attack() then
        sleep(0.2) -- falling block or entity we can't hit; give it a moment
      end
    end
  end
end

local function digMove(dir, context)
  local ok, why, name = tryDigMove(dir, context)
  if ok then return end
  if why == "Cannot break protected block" then why = why .. " (spawn protection or a land claim)" end
  error(("Can't dig %s: %s"):format(name, why), 0)
end

-- Walk to a target, one axis at a time in the given order (e.g. "yxz").
local function goTo(t, order)
  for axis in order:gmatch(".") do
    checkStop()
    if axis == "y" and t.y then
      while pos.y < t.y do digMove("up") end
      while pos.y > t.y do digMove("down") end
    elseif axis == "x" and t.x and pos.x ~= t.x then
      face(pos.x < t.x and 1 or 3)
      while pos.x ~= t.x do digMove("forward") end
    elseif axis == "z" and t.z and pos.z ~= t.z then
      face(pos.z < t.z and 0 or 2)
      while pos.z ~= t.z do digMove("forward") end
    end
  end
end

-- The same in world coordinates (needs GPS). Each world axis maps onto one
-- local axis, so every leg is a straight line.
local function goWorld(t, order)
  for axis in order:gmatch(".") do
    local w = toWorld(pos)
    if t[axis] and w[axis] ~= t[axis] then
      w[axis] = t[axis]
      goTo(fromWorld(w), "xyz")
    end
  end
end

local function faceCompass(c)
  face((c - calib.f0) % 4)
end

-- Navigation ----------------------------------------------------------------
-- Getting somewhere (home, the depot, a job) never breaks blocks. The turtle
-- plans the shortest open route, treating blocks it hasn't seen as open, and
-- re-plans around every block it bumps into. Turtles share where they are and
-- where they're about to move, and plan around each other. The one exception
-- to "never dig": sand, gravel and the like that fell into a block the turtle
-- already passed through may be cleared. Routes are planned in local
-- coordinates, so this works without GPS too.

local function markBlocked(c, untilTime)
  local k = cellKey(c.x, c.y, c.z)
  if blocked[k] == nil then
    blockedCount = blockedCount + 1
    if blockedCount > 50000 then blocked, blockedCount = {}, 1 end
  end
  blocked[k] = untilTime or true -- other turtles only block for a while
end

-- Where moving turtles are (or are about to be) only counts when planning
-- normally; a lenient plan ignores it and waits if one is really there.
-- Turtles standing still, and turtles bumped into recently, always count.
function nav.isOpen(x, y, z, lenient, mining)
  local k = cellKey(x, y, z)
  local now = os.clock()
  local t, p, b = traffic[k], parked[k], blocked[k]
  if mining then b = nil end -- ordinary obstacles may be mined on Force home
  if (not lenient and t and t > now) or (p and p > now) then return false end
  return b == nil or (b ~= true and b < now)
end

function nav.heapPush(heap, node, f)
  node.f = f
  heap[#heap + 1] = node
  local i = #heap
  while i > 1 do
    local p = math.floor(i / 2)
    if heap[p].f <= heap[i].f then break end
    heap[p], heap[i] = heap[i], heap[p]
    i = p
  end
end

function nav.heapPop(heap)
  local top, last = heap[1], table.remove(heap)
  if #heap > 0 then
    heap[1] = last
    local i = 1
    while true do
      local l, r, m = 2 * i, 2 * i + 1, i
      if l <= #heap and heap[l].f < heap[m].f then m = l end
      if r <= #heap and heap[r].f < heap[m].f then m = r end
      if m == i then break end
      heap[i], heap[m] = heap[m], heap[i]
      i = m
    end
  end
  return top
end

-- Each step with the heading it needs (nil for up and down, which need none).
nav.NEIGHBOURS = { { 1, 0, 0, 1 }, { -1, 0, 0, 3 }, { 0, 0, 1, 0 }, { 0, 0, -1, 2 }, { 0, 1, 0 }, { 0, -1, 0 } }

-- Turns needed to face local heading h from heading `from` (default: now).
local function turnsTo(h, from)
  local d = (h - (from or heading)) % 4
  return d == 3 and 1 or d
end

-- A goal for reaching one cell.
local function cellGoal(t)
  return {
    reached = function(x, y, z) return x == t.x and y == t.y and z == t.z end,
    estimate = function(x, y, z) return math.abs(x - t.x) + math.abs(y - t.y) + math.abs(z - t.z) end,
    centre = t,
  }
end

-- Turtles take turns at the dock. Only the turtle whose turn it is goes within
-- DOCK_ROOM blocks of it; the others wait just outside, so the depot works
-- anywhere with a little open space around the dock, even in a low room.
local DOCK_ROOM = 2

local function inDockRoom(dock, x, y, z)
  return math.abs(x - dock.x) <= DOCK_ROOM and math.abs(z - dock.z) <= DOCK_ROOM and math.abs(y - dock.y) <= DOCK_ROOM
end

-- Quickest open route to the goal (A*), or nil. A turn takes as long as a
-- move, so it counts as one: routes run straight rather than zig-zag.
-- `goal.allowed` can confine the route, and `goal.bounds` the search;
-- otherwise it stays near the trip.
local function findPath(goal, lenient)
  local from, c = pos, goal.centre
  local lo = { x = math.min(from.x, c.x) - 24, y = math.min(from.y, c.y) - 24, z = math.min(from.z, c.z) - 24 }
  local hi = { x = math.max(from.x, c.x) + 24, y = math.max(from.y, c.y) + 32, z = math.max(from.z, c.z) + 24 }
  if goal.bounds then lo, hi = goal.bounds.lo, goal.bounds.hi end
  -- The dock is only for the turtle whose turn it is, and the others keep out
  -- of the space around it unless there's no other way.
  local dock
  if fleet.depot and leases.depot ~= "granted" and gpsTrusted() then dock = fromWorld(fleet.depot) end
  -- Routes kept to blocks it knows keep out of it altogether: they'd often go
  -- back through it the way they came. (Without one, it's still avoided.)
  local keepOut = dock and goal.keepOut and not inDockRoom(dock, c.x, c.y, c.z)
  -- The cheapest onward route depends on facing as well as position.
  local startKey = cellKey(from.x, from.y, from.z) .. ":" .. heading
  local g, came, closed, open = { [startKey] = 0 }, {}, {}, {}
  nav.heapPush(open, { x = from.x, y = from.y, z = from.z, k = startKey, h = heading, cost = 0 }, goal.estimate(from.x, from.y, from.z))
  local expanded, limit = 0, goal.limit or 8000
  while #open > 0 do
    local cur = nav.heapPop(open)
    if not closed[cur.k] then
      if goal.reached(cur.x, cur.y, cur.z) then
        local path, node = {}, cur
        while node do
          table.insert(path, 1, node)
          node = came[node.k]
        end
        return path
      end
      closed[cur.k] = true
      expanded = expanded + 1
      if expanded > limit then return nil end
      if expanded % 500 == 0 then
        os.queueEvent("minerdash_yield") -- don't hog the computer
        os.pullEvent("minerdash_yield")
      end
      for _, d in ipairs(nav.NEIGHBOURS) do
        local x, y, z = cur.x + d[1], cur.y + d[2], cur.z + d[3]
        local k = cellKey(x, y, z)
        -- A turtle standing on the goal itself is waited for, not avoided.
        if (nav.isOpen(x, y, z, lenient, goal.mining) or (goal.reached(x, y, z) and blocked[k] == nil))
          and not (goal.blocked and (goal.blocked[k] == true or (tonumber(goal.blocked[k]) or 0) > os.clock()))
          and x >= lo.x and x <= hi.x and y >= lo.y and y <= hi.y and z >= lo.z and z <= hi.z
          and (not goal.allowed or goal.allowed(x, y, z))
          and not (dock and x == dock.x and y == dock.y and z == dock.z)
          and not (keepOut and inDockRoom(dock, x, y, z)) then
          local h = d[4] or cur.h
          -- Either approach can be quickest once the next turn is considered.
          for variant = 1, d[4] ~= nil and 2 or 1 do
            local back = variant == 2
            local facing = back and (h + 2) % 4 or h
            local stateKey = k .. ":" .. facing
            local ng = g[cur.k] + 1 + turnsTo(facing, cur.h) + ((dock and inDockRoom(dock, x, y, z)) and 4 or 0)
            if not closed[stateKey] and ng < (g[stateKey] or math.huge) then
              g[stateKey], came[stateKey] = ng, cur
              nav.heapPush(open, { x = x, y = y, z = z, k = stateKey, h = facing, back = back, cost = ng }, ng + goal.estimate(x, y, z))
            end
          end
        end
      end
    end
  end
  return nil
end

-- Sand, gravel and other blocks that fall: the only things travel may clear,
-- and only from blocks the turtle has already passed through.
function nav.hasFallen(name)
  return name ~= "minecraft:soul_sand"
    and not not (name:find("sand$") or name:find("gravel$") or name:find("concrete_powder$") or name:find("anvil$")
      or name == "minecraft:pointed_dripstone")
end

-- One step to a neighbouring cell: true, or false and why.
local function stepTo(n, mining)
  local dir = n.y > pos.y and "up" or n.y < pos.y and "down" or "forward"
  if dir == "forward" then
    if n.back then face(n.h or heading) end
    if n.back and pos.x - DX[heading] == n.x and pos.z - DZ[heading] == n.z then
      dir = "back"
    else
      for h = 0, 3 do
        if pos.x + DX[h] == n.x and pos.z + DZ[h] == n.z then face(h) end
      end
    end
  end
  for _ = 1, 20 do
    local ok, err = move(dir)
    if ok then return true end
    if err == "Outside mining radius" then return false, "block" end
    if err == "Out of fuel" then error("Out of fuel", 0) end
    if dir == "back" then
      -- There is no rear inspection API. Face a blocked step before applying
      -- the same safety checks used by forward travel.
      face((heading + 2) % 4)
      dir = "forward"
    end
    local found, block = SIDES[dir].inspect()
    if found and isTurtleBlock(block.name) then return false, "turtle" end
    if found and not LIQUIDS[block.name] then
      if mining then
        local cleared, why = clear(dir)
        if not cleared then return false, why == "another turtle is in the way" and "turtle" or "block" end
      else
        local fellIn = visited[cellKey(n.x, n.y, n.z)] and nav.hasFallen(block.name) and not protection(dir, block)
        if not fellIn then return false, "block" end
        if SIDES[dir].dig() then noteDug(dir, block.name) end
      end
    elseif not SIDES[dir].attack() then
      sleep(0.2) -- a mob in the way
    end
  end
  return false, "block"
end

function nav.describe(p)
  local w = toWorld(p) or p
  return ("%d, %d, %d"):format(w.x, w.y, w.z)
end

-- Go somewhere through open space. Raises an error, without digging, if
-- there's no open way.
local function navigate(goal)
  local tries, waits = 0, 0
  while not goal.reached(pos.x, pos.y, pos.z) do
    checkStop()
    -- If other turtles leave no way through, plan as if they weren't there:
    -- they move on, and bumping into one just means waiting.
    local path = findPath(goal) or findPath(goal, true)
    if not path then
      travelNext = nil
      error((goal.mining and "Found no safe mining route to %s" or "Found no open way to %s without digging"):format(nav.describe(goal.centre)), 0)
    end
    for i = 2, #path do
      travelNext = path[i]
      local ok, why = stepTo(path[i], goal.mining)
      if not ok then
        if why == "turtle" then
          -- Another turtle in the way: wait, then go around if it stays put.
          waits = waits + 1
          if waits % 10 == 0 then
            markBlocked(path[i], os.clock() + 20)
            if goal.mining then
              goal.blocked = goal.blocked or {}
              goal.blocked[cellKey(path[i].x, path[i].y, path[i].z)] = os.clock() + 20
            end
          end
          sleep(0.5)
        else
          markBlocked(path[i])
          if goal.mining then
            goal.blocked = goal.blocked or {}
            goal.blocked[cellKey(path[i].x, path[i].y, path[i].z)] = true
          end
        end
        break
      end
      if heading ~= path[i].h then break end -- inspecting behind changed the approach; replan
    end
    tries = tries + 1
    if tries > 600 then
      travelNext = nil
      error((goal.mining and "Gave up finding a safe mining route to %s" or "Gave up finding an open way to %s"):format(nav.describe(goal.centre)), 0)
    end
  end
  travelNext = nil
end

-- Ordinary local jobs use open-space navigation. Row miners use only their
-- saved staircase, even after the current assignment has been cleared.
local function travelHome()
  setDetail("Heading home")
  if miningRoute then rowRoute.exit() else navigate(cellGoal(home)) end
end

-- Inventory & fuel ----------------------------------------------------------

local function fuelLevel()
  local fuel = turtle.getFuelLevel()
  return fuel == "unlimited" and math.huge or fuel
end

local function fuelLimit()
  local limit = turtle.getFuelLimit()
  return limit == "unlimited" and math.huge or limit
end

-- Burn fuel items from the inventory until fuel >= target. Returns success.
-- Burn fuel from the selected slot until fuel reaches target (or the slot
-- is empty). Each refuel call takes a game tick, so it burns one item to
-- learn what an item is worth, then all it needs in a single call.
local function refuelSelected(target)
  target = math.min(target, fuelLimit())
  local before = fuelLevel()
  if before >= target or turtle.getItemCount() == 0 or not turtle.refuel(1) then return end
  local each = fuelLevel() - before
  if each > 0 and fuelLevel() < target and turtle.getItemCount() > 0 then
    turtle.refuel(math.min(turtle.getItemCount(), math.ceil((target - fuelLevel()) / each)))
  end
end

local function refuelFromInventory(target)
  target = math.min(target, fuelLimit())
  if fuelLevel() >= target then return true end
  local selected = turtle.getSelectedSlot()
  for slot = 1, 16 do
    if fuelLevel() >= target then break end
    if turtle.getItemCount(slot) > 0 then
      turtle.select(slot)
      refuelSelected(target)
    end
  end
  turtle.select(selected)
  changed()
  return fuelLevel() >= target
end

local function waitForFuel(target)
  local warned = false
  while not refuelFromInventory(target) do
    if not warned then
      log("warn", ("Need %d fuel. Put fuel in my inventory to continue."):format(target))
      warned = true
    end
    setDetail("Waiting for fuel")
    waitSeconds(5)
  end
end

local function emptySlots()
  local n = 0
  for slot = 1, 16 do
    if turtle.getItemCount(slot) == 0 then n = n + 1 end
  end
  return n
end

local function firstEmptySlot()
  for slot = 1, 16 do
    if turtle.getItemCount(slot) == 0 then return slot end
  end
end

local function isInventory(side)
  for _, t in ipairs({ peripheral.getType(side) }) do
    if t == "inventory" or t:find("chest") or t:find("barrel") or t:find("shulker") then return true end
  end
  return false
end

-- At a local job's base: drop everything into the chest behind, keeping one
-- stack of fuel. Without a chest it either waits for one or (needChest =
-- false) skips unloading.
local function unload(base, needChest)
  face((base.heading + 2) % 4)
  if not needChest and not isInventory("front") then
    face(base.heading)
    return
  end
  local warned = false
  while not isInventory("front") do
    if not warned then log("warn", "No chest behind the job's start. Place one to continue."); warned = true end
    setDetail("Waiting for a chest behind the start")
    waitSeconds(5)
  end
  local keptFuel = false
  for slot = 1, 16 do
    if turtle.getItemCount(slot) > 0 then
      turtle.select(slot)
      if not keptFuel and turtle.refuel(0) then
        keptFuel = true
      else
        warned = false
        while turtle.getItemCount(slot) > 0 and not turtle.drop() do
          if not warned then log("warn", "Chest is full. Empty it to continue."); warned = true end
          setDetail("Chest is full")
          waitSeconds(5)
        end
      end
    end
  end
  turtle.select(1)
  face(base.heading)
  changed()
end

-- With a depot set up, every job unloads there: junk, valuables and fuel go
-- in their chests and the turtle refuels. depotVisit and depotCost are
-- defined with the fleet code below.
local depotVisit, depotCost

local function depotReady()
  return fleet.depot ~= nil and gpsTrusted()
end

-- A trip describes how a local job travels between its work area and its base
-- (where it started): horizontally at corridorY (a level it has already dug),
-- then vertically.
local function newTrip(corridorY, base)
  local trip = { base = base }
  function trip.cost(from)
    from = from or pos
    return math.abs(from.y - corridorY) + math.abs(from.x - base.x) + math.abs(from.z - base.z)
      + math.abs(corridorY - base.y)
  end
  function trip.toBase()
    goTo({ y = corridorY }, "y")
    goTo(base, "xz")
    goTo(base, "y")
    face(base.heading)
  end
  function trip.back(spot)
    goTo({ y = corridorY }, "y")
    goTo(spot, "zx")
    goTo(spot, "y")
    face(spot.heading)
  end
  return trip
end

-- Fuel to get from `from` (default: here) back to where the job refuels:
-- along its own corridor to the start, then on to the depot if there is one.
-- trip.flown is the longest flight it has made between the start and the depot.
local function refuelCost(trip, from)
  local cost = trip.cost(from)
  if depotReady() then cost = cost + depotCost(toWorld(trip.base), trip.flown) end
  return cost
end

-- Unload from a local job: at the depot when there is one (sorting items and
-- refuelling), otherwise into the chest behind the job's start. Either way it
-- ends up back at the start.
local function unloadAt(trip, needChest, minFuel)
  if depotReady() then
    local flown = depotVisit(minFuel or 0)
    local start = odometer
    navigate(cellGoal(trip.base))
    trip.flown = math.max(trip.flown or 0, flown, odometer - start)
    face(trip.base.heading)
  else
    unload(trip.base, needChest)
  end
end

-- Back to the start to unload and refuel, then out to where it was. It leaves
-- with enough fuel to get there, back again and on to where it refuels.
local function serviceTrip(trip, needChest)
  local spot = here()
  trip.toBase()
  unloadAt(trip, needChest, 2 * refuelCost(trip, spot) + 64)
  waitForFuel(trip.cost(spot) + refuelCost(trip, spot) + 64)
  trip.back(spot)
end

-- Never go further than it has the fuel to come back from.
local function ensureFuel(trip)
  if refuelFromInventory(refuelCost(trip) + 64) then return end
  log("warn", "Low on fuel, heading back to the start")
  setDetail("Low on fuel, heading back")
  serviceTrip(trip, false)
end

local function ensureSpace(trip)
  if emptySlots() > 1 then return end
  setDetail("Inventory full, unloading")
  serviceTrip(trip, true)
end

-- After a job: back out to the start, unload (and refuel at the depot), then
-- go home. A cancelled job leaves its trip for goHome, which does the same.
local function finishJob(trip, ok, err)
  if not ok and err == STOP then
    pendingTrip = trip
    error(STOP, 0)
  end
  setDetail("Returning to the start")
  if ok then
    trip.toBase()
    unloadAt(trip, false)
    travelHome()
    face(home.heading)
    return
  end
  -- Something stopped the job: unload if it can, then head home.
  log("warn", ("Stopped: %s. Heading home."):format(tostring(err)))
  pcall(function()
    trip.toBase()
    unloadAt(trip, false)
  end)
  pcall(travelHome)
  error(err, 0)
end

-- Local jobs (long-running; can be paused, resumed and cancelled) ---------------

local jobs = {}

function jobs.tunnel(a)
  local length = clampInt(a.length, 1, 1024, 32)
  local height = clampInt(a.height, 1, 3, 2)
  local base = here()
  local forward = heading
  local trip = newTrip(base.y + (height == 3 and 1 or 0), base)
  log("info", ("Tunnel %d long, %d high"):format(length, height))

  local ok, err = pcall(function()
    -- A 3-high tunnel is dug from its middle row.
    if height == 3 then digMove("up") end
    for i = 1, length do
      ensureFuel(trip)
      ensureSpace(trip)
      face(forward)
      digMove("forward")
      if height >= 2 then clear("up") end
      if height == 3 then clear("down") end
      setDetail(("Block %d of %d"):format(i, length), i / length)
    end
  end)
  finishJob(trip, ok, err)
end

-- Digs a box `length` forward x `width` to the right x `depth` down, starting
-- below the turtle. Mines three layers per pass (dig up, move, dig down).
function jobs.quarry(a)
  local length = clampInt(a.length, 1, 128, 8)
  local width = clampInt(a.width, 1, 128, 8)
  local depth = clampInt(a.depth, 1, 384, 16)
  local origin, f = here(), heading
  local r = (f + 1) % 4
  local trip = newTrip(origin.y - 1, origin)
  log("info", ("Quarry %dx%d, %d deep"):format(length, width, depth))

  local function cell(i, j, y)
    return { x = origin.x + i * DX[f] + j * DX[r], y = y, z = origin.z + i * DZ[f] + j * DZ[r] }
  end

  -- Snake across the rectangle. Alternate passes walk the snake backwards so
  -- each pass starts where the previous one ended.
  local path = {}
  for j = 0, width - 1 do
    for k = 0, length - 1 do
      path[#path + 1] = { j % 2 == 0 and k or length - 1 - k, j }
    end
  end
  local passes = math.ceil(depth / 3)
  local total, done = passes * #path, 0

  local ok, err = pcall(function()
    for p = 0, passes - 1 do
      local top = origin.y - 1 - 3 * p
      local bottom = math.max(top - 2, origin.y - depth)
      local mid = bottom < top and top - 1 or top
      for n = 1, #path do
        local c = path[p % 2 == 0 and n or #path - n + 1]
        ensureFuel(trip)
        ensureSpace(trip)
        goTo(cell(c[1], c[2], mid), "yxz")
        if mid < top then clear("up") end
        if bottom < mid then clear("down") end
        done = done + 1
        setDetail(("Layers %d-%d of %d"):format(origin.y - top, origin.y - bottom, depth), done / total)
      end
    end
  end)
  if not ok and tostring(err):find("bedrock") then
    log("info", "Reached bedrock")
    ok = true
  end
  finishJob(trip, ok, err)
end

-- Fleet: the shared depot and fleet jobs ------------------------------------------

-- The dock is shared, so ask the server for a turn and wait for it.
-- Download this server's script, check it, save it over this program and
-- reboot. Returns false and why if the download is unusable.
local function installUpdate()
  local base = (url:gsub("^ws", "http"):gsub("/ws/turtle$", ""))
  local res, err = http.get(base .. "/turtle.lua")
  if not res then return false, "Download failed: " .. tostring(err) end
  local code = res.readAll()
  res.close()
  if not (code and code:find("MinerDash", 1, true)) then return false, "Downloaded script is invalid" end
  local compiled, why = load(code, "minerdash")
  if not compiled then return false, "Downloaded script doesn't load: " .. tostring(why) end
  local f = fs.open(shell.getRunningProgram(), "w")
  f.write(code)
  f.close()
  log("info", "Updated, rebooting")
  sleep(0.5)
  os.reboot()
end

-- An update asked for mid-job is applied only where a reboot loses nothing:
-- between two steps, or parked waiting at the depot. The job resumes after.
local function updateIfAsked()
  if not updateRequested then return end
  updateRequested = false
  local _, why = installUpdate()
  log("warn", "Update skipped, carrying on: " .. tostring(why))
end

local function acquire(resource)
  if leases[resource] == "granted" then return end
  leases[resource] = "waiting"
  local ok, err = pcall(function()
    while leases[resource] ~= "granted" do
      send({ type = "lease", resource = resource, op = "acquire" })
      local timer = os.startTimer(5)
      repeat
        local event, id = os.pullEvent()
        checkStop()
        if leases[resource] ~= "granted" then updateIfAsked() end
      until leases[resource] == "granted" or (event == "timer" and id == timer)
    end
  end)
  if not ok then
    leases[resource] = nil
    send({ type = "lease", resource = resource, op = "release" })
    error(err, 0)
  end
  saveState()
end

local function release(resource)
  if leases[resource] == nil then return end
  leases[resource] = nil
  send({ type = "lease", resource = resource, op = "release" })
  saveState()
end

-- Where to wait for a turn at the dock, and to step out to after one: any open
-- block just outside the space around the dock, within 2 of its height, that
-- isn't another turtle or another turtle's home.
function dock.around()
  local dock, now = fromWorld(fleet.depot), os.clock()
  local function off(x, z) return math.max(math.abs(x - dock.x), math.abs(z - dock.z)) end
  return {
    reached = function(x, y, z)
      local d, k = off(x, z), cellKey(x, y, z)
      return d > DOCK_ROOM and d <= DOCK_ROOM + 3 and math.abs(y - dock.y) <= 2
        and not (homesNear[k] and homesNear[k] > now)
        and ((x == pos.x and y == pos.y and z == pos.z) or nav.isOpen(x, y, z))
    end,
    estimate = function(x, y, z)
      local d = off(x, z)
      return math.max(0, DOCK_ROOM + 1 - d, d - DOCK_ROOM - 3) + math.max(0, math.abs(y - dock.y) - 2)
    end,
    centre = dock,
  }
end

-- Whether world position w is where turtles wait for the dock, or closer.
function dock.atDepot(w)
  local D = fleet.depot
  return D ~= nil and math.max(math.abs(w.x - D.x), math.abs(w.z - D.z)) <= DOCK_ROOM + 3 and math.abs(w.y - D.y) <= 2
end

-- Return home and settle facing the saved direction.
local function comeHome()
  travelHome()
  face(home.heading)
  release("depot")
end

-- Fleet jobs work in world coordinates. If GPS doesn't know which way the
-- turtle faces, step into an empty neighbouring block (never digging) until it does.
local function ensureCalibrated()
  local deadline = os.clock() + 10
  while not gpsChecked and os.clock() < deadline do waitSeconds(0.5) end
  if gpsTrusted() then return end
  if gpsState == "none" then error("Needs a wireless or ender modem for GPS", 0) end
  setDetail("Finding north with GPS")
  for _ = 1, 4 do
    for _, dir in ipairs({ "forward", "back" }) do
      if not gpsTrusted() and move(dir) then
        local wait = os.clock() + 6
        while not gpsTrusted() and os.clock() < wait do waitSeconds(0.5) end
      end
    end
    if gpsTrusted() then return end
    turn(true)
  end
  error("Couldn't confirm the GPS facing. Move it one block sideways by hand.", 0)
end

function dock.side(side)
  if side == "up" then return "top" end
  if side == "down" then return "bottom" end
  faceCompass(COMPASS_INDEX[side])
  return "front"
end

dock.DROP = { top = turtle.dropUp, bottom = turtle.dropDown, front = turtle.drop }
dock.SUCK = { top = turtle.suckUp, bottom = turtle.suckDown, front = turtle.suck }

-- Only ever drop into a chest, never onto the ground.
function dock.drop(side)
  local p = dock.side(side)
  return isInventory(p) and dock.DROP[p]()
end

function dock.suck(side)
  local p = dock.side(side)
  return isInventory(p) and dock.SUCK[p]()
end

function dock.category(name)
  if matches(name, compiled.fuel) then return "fuel" end
  if matches(name, compiled.valuables) then return "valuables" end
  return "junk"
end

-- Junk isn't worth a trip to the dock. Below ground, a row miner drops it
-- where it is, so its cargo space only ever holds valuables and fuel. It
-- never drops into a chest beside it.
function dock.dropJunk()
  if not (miningRoute and gpsTrusted() and toWorld(pos).y < miningRoute.home.y) then return end
  local into
  for _, side in ipairs({ "bottom", "top", "front" }) do
    if not isInventory(side) then into = side break end
  end
  if not into then return end
  local selected = turtle.getSelectedSlot()
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item and dock.category(item.name) == "junk" then
      turtle.select(slot)
      dock.DROP[into]()
    end
  end
  turtle.select(selected)
  changed()
end

-- Merge stacks of the same item split across slots. A turtle puts what it
-- digs into the first slot with room from the selected one onward, so a new
-- stack can start ahead of a partly full one.
function dock.compact()
  local selected, open = turtle.getSelectedSlot(), {}
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item then
      local into = open[item.name]
      if into then
        turtle.select(slot)
        turtle.transferTo(into)
        if turtle.getItemSpace(into) == 0 then open[item.name] = nil end
      end
      if turtle.getItemCount(slot) > 0 and turtle.getItemSpace(slot) > 0 and not open[item.name] then open[item.name] = slot end
    end
  end
  turtle.select(selected)
end

-- Before each step: drop junk once it fills two slots, and merge split stacks.
function dock.tidy()
  local junk, seen, split = 0, {}, false
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item then
      if dock.category(item.name) == "junk" then junk = junk + 1 end
      split = split or seen[item.name] == true
      seen[item.name] = true
    end
  end
  if junk >= 2 then dock.dropJunk() end
  if split then dock.compact() end
end

-- At the dock: sort the inventory into the three chests and top up fuel from
-- the fuel chest. One chest at a time, fuel last, so it turns as little as it
-- can. Returns a description of anything the player needs to fix.
function dock.work(minFuel)
  local D = fleet.depot
  local target = math.min(math.max(tonumber(fleet.refuelTo) or 10000, minFuel), fuelLimit())
  local full, slots = {}, { junk = {}, valuables = {}, fuel = {} }
  -- Fuel left after refuelling goes back in the fuel chest. Cargo space
  -- matters more than spare fuel, so what the chest can't take is burnt,
  -- up to the tank's limit, and anything still left is stored with the
  -- valuables, or else the junk.
  local function stowFuel(slot)
    turtle.select(slot)
    dock.drop(D.fuel)
    refuelSelected(fuelLimit())
    for _, cat in ipairs({ "valuables", "junk" }) do
      if turtle.getItemCount(slot) > 0 then dock.drop(D[cat]) end
    end
  end
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item then
      local cat = dock.category(item.name)
      if cat == "fuel" then
        turtle.select(slot)
        refuelSelected(target)
      end
      if turtle.getItemCount(slot) > 0 then table.insert(slots[cat], slot) end
    end
  end
  for _, cat in ipairs({ "junk", "valuables", "fuel" }) do
    for _, slot in ipairs(slots[cat]) do
      if cat == "fuel" then
        stowFuel(slot)
      else
        turtle.select(slot)
        dock.drop(D[cat])
        if turtle.getItemCount(slot) > 0 then full[cat] = true end
      end
    end
  end
  local outOfFuel = false
  while fuelLevel() < target do
    local slot = firstEmptySlot()
    if not slot then break end
    turtle.select(slot)
    local before = fuelLevel()
    if dock.suck(D.fuel) then
      refuelSelected(target)
      if turtle.getItemCount(slot) > 0 then stowFuel(slot) end
    end
    if fuelLevel() == before then
      outOfFuel = true
      break
    end
  end
  turtle.select(1)
  changed()
  local problems = {}
  for _, cat in ipairs({ "junk", "valuables" }) do
    if full[cat] then problems[#problems + 1] = "the " .. cat .. " chest is full or missing" end
  end
  if outOfFuel then problems[#problems + 1] = "the fuel chest is empty or missing usable fuel" end
  return #problems > 0 and table.concat(problems, ", ") or nil
end

-- Fuel to fly from world position w to the depot, into the dock and back out:
-- the longest flight from there it has actually made (`flown`), or until it
-- has made one, the straight-line distance with room for detours.
function depotCost(w, flown)
  local direct = distance(w, fleet.depot)
  local fly = flown and math.max(flown, direct) or math.floor(direct * 1.5) + 16
  return fly + 4 * (DOCK_ROOM + 3)
end

-- Unload and refuel at the shared depot. The turtle waits just outside the
-- space around the dock until it's its turn, goes in by any open way, and
-- steps back out before the next turtle's turn. Retries until it has room and
-- at least minFuel. Returns how many blocks it flew to get to the depot.
function rowRoute.sharedDepotVisit(minFuel, flat)
  local D = fleet.depot
  if not D then error("Set up the depot on the dashboard first", 0) end
  local start, flown = odometer, nil
  -- The chests are solid, so don't plan a way through them.
  for _, kind in ipairs({ "junk", "valuables", "fuel" }) do
    local side = D[kind]
    local c = COMPASS_INDEX[side]
    local dy = side == "up" and 1 or side == "down" and -1 or 0
    markBlocked(fromWorld({ x = D.x + (c and CX[c] or 0), y = D.y + dy, z = D.z + (c and CZ[c] or 0) }))
  end
  -- Never digging: if there's no open way, say so.
  local function go(goal, where)
    if flat then
      local allowed = goal.allowed
      local level = fromWorld({ x = D.x, y = 67, z = D.z }).y
      goal.allowed = function(x, y, z) return y == level and (not allowed or allowed(x, y, z)) end
      goal.limit = 40000
    end
    local ok, err = pcall(navigate, goal)
    if ok then return end
    if err == STOP then error(STOP, 0) end
    error(("Can't get %s without digging (%s). Leave some open space around the dock."):format(where, tostring(err)), 0)
  end
  while true do
    if leases.depot ~= "granted" then
      setDetail("Heading to the depot")
      go(dock.around(), "near the depot")
      flown = flown or odometer - start
      setDetail("Waiting for a turn at the depot")
      acquire("depot")
    end
    flown = flown or odometer - start
    local problem
    local ok, err = pcall(function()
      go(cellGoal(fromWorld(D)), "into the dock")
      setDetail("Unloading at the depot")
      problem = dock.work(minFuel)
    end)
    -- Whatever happened, step back out so the next turtle can come in.
    local stop = stopRequested
    stopRequested = false
    setDetail("Leaving the depot")
    local left = pcall(function() go(dock.around(), "out of the dock") end)
    stopRequested = stopRequested or stop
    if left then release("depot") end
    if not ok then error(err, 0) end
    if not left then error("Stuck at the dock: no open way back out of the space around it", 0) end
    checkStop()
    if problem then log("warn", "Depot: " .. problem) end
    if emptySlots() >= 4 and fuelLevel() >= minFuel then return flown end
    setDetail("Waiting: " .. (problem or "not enough fuel at the depot"))
    updateIfAsked()
    waitSeconds(30)
  end
end

-- The mining route is geometric and durable. The visited-cell cache above is
-- deliberately irrelevant to these stairs, their home, and their recovery.
function rowRoute.save(phase)
  if phase then miningRoute.phase = phase end
  saveState()
  changed()
end

function rowRoute.surfacePhase()
  local phase = miningRoute and miningRoute.phase
  return phase == "home" or phase == "toStairHome" or phase == "toDepot" or phase == "fromDepot"
end

function rowRoute.inCircle(w, center, radius)
  return (w.x - center.x)^2 + (w.z - center.z)^2 <= radius^2
end

function rowRoute.withinRadius(w)
  return not miningRoute.radius or rowRoute.inCircle(w, miningRoute.home, miningRoute.radius)
end

-- World Z of staircase step `step` (0 is the home). Step n has its foot at
-- Y 67 - n. When the radius is smaller than the depth, the stairs switch
-- back: south to Z -55 + radius, north to Z -55, south again, and so on.
-- The server plans the same cells (fleet.js stairZ).
function rowRoute.stairZ(step, radius)
  if not radius then return -55 + step end
  local p = step % (2 * radius)
  return -55 + (p <= radius and p or 2 * radius - p)
end

function rowRoute.position(w)
  if not miningRoute or w.x ~= miningRoute.home.x then return nil end
  local step = 67 - w.y
  if step ~= math.floor(step) then return nil end
  if step >= 0 and w.z == rowRoute.stairZ(step, miningRoute.radius) then return step, false end
  step = step + 1
  if step > 0 and w.z == rowRoute.stairZ(step, miningRoute.radius) then return step, true end
end

function rowRoute.initialCell(w)
  local r = miningRoute
  local p = r and r.stair.pending
  if not r or r.phase ~= "building" or not p or not samePos(w, p.to) or not samePos(toWorld(pos), p.from) then return false end
  return p.step == r.stair.completed + 1 and p.step <= 67 - r.targetY
    and w.x == r.home.x and w.z == rowRoute.stairZ(p.step, r.radius)
    and w.y == 67 - p.step + (p.leg == "forward" and 1 or 0)
    and (p.leg == "forward" or p.leg == "down")
end

function rowRoute.reconcile()
  local r = miningRoute
  local p = r and r.stair.pending
  if not p or not gpsTrusted() then return end
  if samePos(toWorld(pos), p.to) then
    if p.leg == "down" then
      r.stair.completed = math.max(r.stair.completed, p.step)
      r.stair.half = false
    elseif p.step == r.stair.completed + 1 then
      r.stair.half = true
    end
    r.stair.pending = nil
    rowRoute.save()
  end
end

function rowRoute.opened(w)
  local step, upper = rowRoute.position(w)
  if not step then return false end
  return step <= miningRoute.stair.completed or (upper and step == miningRoute.stair.completed + 1 and miningRoute.stair.half)
end

-- Exact opened-cell travel has no detour and never digs a new way. It only
-- clears what fell into, or lava and water formed in, these saved cells.
-- Blocks that turn up in cells it already dug: lava flowing into water
-- makes stone, cobblestone or obsidian. Sand and gravel fall in (hasFallen).
rowRoute.REFILL = { ["minecraft:stone"] = true, ["minecraft:cobblestone"] = true, ["minecraft:obsidian"] = true }

function rowRoute.walkStep(w, known)
  if not known and not rowRoute.opened(w) then error("That staircase step has not been opened", 0) end
  local current = toWorld(pos)
  if distance(current, w) ~= 1 then error("Saved route contains a non-adjacent step", 0) end
  local dir = w.y > current.y and "up" or w.y < current.y and "down" or "forward"
  if dir == "forward" then
    faceCompass(w.x ~= current.x and (w.x > current.x and 1 or 3) or (w.z > current.z and 2 or 0))
  end
  local tries, waited = 0, 0
  while true do
    checkStop()
    travelNext = fromWorld(w)
    local ok, err = move(dir)
    if ok then travelNext = nil return end
    if err == "Outside mining radius" then error(err, 0) end
    if err == "Out of fuel" then error(err, 0) end
    local found, block = SIDES[dir].inspect()
    if found and isTurtleBlock(block.name) then
      -- Another turtle on its route is waited for, however long it takes.
      waited = waited + 0.5
      if waited == 5 then setDetail("Waiting for another turtle to move") end
      sleep(0.5)
    else
      tries = tries + 1
      if tries > 120 then error("Saved route blocked by an entity it can't move past", 0) end
      if found and not LIQUIDS[block.name] then
        local reason = protection(dir, block)
        if reason then error("Saved route blocked: " .. reason, 0) end
        if not (nav.hasFallen(block.name) or rowRoute.REFILL[block.name]) then
          error("Saved route blocked by " .. block.name .. "; it will not dig a new route", 0)
        end
        local dug, why = SIDES[dir].dig()
        if not dug then error("Can't clear " .. block.name .. " from its saved route: " .. tostring(why), 0) end
        noteDug(dir, block.name)
      elseif not SIDES[dir].attack() then sleep(0.2) end
    end
  end
end

function rowRoute.surface(target)
  if not gpsTrusted() then error("GPS is required for the saved row route", 0) end
  if target.y ~= 67 or toWorld(pos).y ~= 67 then error("Depot travel must remain at Y 67", 0) end
  local goal = cellGoal(fromWorld(target))
  local level = fromWorld(target).y
  goal.allowed = function(_, y) return y == level end
  goal.limit = 40000
  navigate(goal)
end

function rowRoute.validate(a)
  if a.routeMode ~= "southRow" or a.access ~= "southStairs" then
    error("Old branch jobs are paused. Start a new south-row mining job.", 0)
  end
  local function integer(n, lo, hi) return type(n) == "number" and n == math.floor(n) and n >= lo and n <= hi end
  local h, b = a.routeHome, a.stairBottom
  if type(h) ~= "table" or not integer(h.x, -3e7, 3e7) or h.y ~= 67 or h.z ~= -55 or h.facing ~= "south" then
    error("Invalid saved south-facing home row", 0)
  end
  if not integer(a.y, -64, 67) or not integer(a.x, -3e7, 3e7) or not integer(a.z, -3e7, 3e7)
    or (a.band or 0) ~= 0 or (a.dir ~= "south" and a.dir ~= 2) then
    error("South-row mining requires one safe target Y and south-facing lanes", 0)
  end
  if not integer(a.radius, 1, 1024) then error("Set a mining radius from 1 to 1024 blocks", 0) end
  local staggered = a.pattern == "staggered"
  if type(b) ~= "table" or b.x ~= h.x or b.y ~= a.y or b.z ~= rowRoute.stairZ(67 - a.y, a.radius)
    or a.z ~= (staggered and h.z or b.z) then
    error("The staircase bottom must match the saved home and target Y", 0)
  end
  if not rowRoute.inCircle(b, h, a.radius) or not rowRoute.inCircle({ x = a.x, z = a.z }, h, a.radius) then
    error("The radius must reach the staircase bottom and assigned mining lane from the original home", 0)
  end
  if staggered then
    if not integer(a.first, -3e7, 3e7) or not integer(a.last, -3e7, 3e7) or a.x ~= a.first
      or math.abs(a.first - h.x) > a.radius or math.abs(a.last - h.x) > a.radius then
      error("Staggered mining columns must lie inside the radius from the original home", 0)
    end
    if a.y > 66 or not integer(a.low, -64, a.y - 1) or (a.peak ~= nil and not integer(a.peak, -64, 320)) then
      error("Invalid staggered mining levels", 0)
    end
  end
end

function rowRoute.ensure(a)
  rowRoute.validate(a)
  if not fleet.depot or fleet.depot.y ~= 67 then error("The shared depot dock must be at Y 67 for row mining", 0) end
  local deadline = os.clock() + 10
  while not gpsChecked and os.clock() < deadline do waitSeconds(0.5) end
  if not miningRoute then
    local w = worldPos()
    if gpsState ~= "ok" or not w or w.y ~= 67 or w.z ~= -55 or w.x ~= a.routeHome.x then
      error("Place the turtle at its home row (Y 67, Z -55), facing south, with a GPS fix", 0)
    end
    -- At first setup the user supplies the known south facing. No calibration
    -- movement is needed, and the captured home never follows later jobs.
    calib = { l = { x = pos.x, y = pos.y, z = pos.z }, w = { x = w.x, y = 67, z = -55 }, f0 = (2 - heading) % 4 }
    blocked, blockedCount, traffic, trafficCount, parked, homesNear = {}, 0, {}, 0, {}, {}
    forgetVisited()
    remember(pos)
    saveState()
  else
    rowRoute.findFacing()
    if not gpsChecked or not gpsTrusted() or miningRoute.pendingMove then
      error("GPS hasn't confirmed its position yet. Try again in a moment.", 0)
    end
  end
  local w = toWorld(pos)
  if not miningRoute then
    if not samePos(w, a.routeHome) then error("The first row job must start at the turtle's own saved row position", 0) end
    faceCompass(2)
    home = fromWorld(a.routeHome)
    home.heading = (2 - calib.f0) % 4
    miningRoute = {
      version = 1, home = { x = a.routeHome.x, y = 67, z = -55, facing = "south" },
      bottom = { x = a.stairBottom.x, y = a.y, z = a.stairBottom.z }, targetY = a.y,
      radius = a.radius,
      stair = { completed = 0, half = false, complete = a.y == 67 },
      bottomSaved = a.y == 67, phase = "home",
    }
    rowRoute.save()
  elseif not samePos(miningRoute.home, a.routeHome) then
    error("A later job cannot replace this turtle's saved home", 0)
  end
  if miningRoute.radius ~= a.radius or miningRoute.targetY ~= a.y then
    if not samePos(w, miningRoute.home) then error("Return to the saved home before changing the mining radius or level", 0) end
    -- Every radius shares the stair cells up to its first turn. Past that
    -- they differ, so only the shared steps still count as opened.
    local shared = math.min(miningRoute.radius or math.huge, a.radius)
    if miningRoute.stair.completed >= shared then
      miningRoute.stair.completed, miningRoute.stair.half = shared, false
    end
    miningRoute.radius, miningRoute.targetY = a.radius, a.y
    miningRoute.bottom = { x = miningRoute.home.x, y = a.y, z = rowRoute.stairZ(67 - a.y, a.radius) }
    miningRoute.stair.complete = miningRoute.stair.completed >= 67 - a.y
    miningRoute.bottomSaved = miningRoute.stair.complete
    miningRoute.work, miningRoute.veinPath, miningRoute.columns = nil, nil, nil
    rowRoute.save("home")
  end
  rowRoute.reconcile()
end

function rowRoute.buildLeg(dir, target, leg, step)
  if dir == "forward" then faceCompass(target.z > toWorld(pos).z and 2 or 0) end
  miningRoute.stair.pending = { from = toWorld(pos), to = target, leg = leg, step = step }
  rowRoute.save("building")
  if not rowRoute.initialCell(target) then error("Invalid initial stair excavation", 0) end
  digMove(dir, "initialStair")
  rowRoute.reconcile()
end

function rowRoute.flatMine(target)
  local w = toWorld(pos)
  if w.y ~= miningRoute.targetY or target.y ~= miningRoute.targetY then
    error("Mining return travel must stay at the saved safe mining Y", 0)
  end
  if not rowRoute.withinRadius(w) or not rowRoute.withinRadius(target) then
    error("Mining return waypoints must stay inside the radius from the original home", 0)
  end
  -- A short mined route at the safe level may detour around restricted
  -- blocks. It can never turn a horizontal return into a shaft to home.
  local goal = cellGoal(fromWorld(target))
  local level = fromWorld(target).y
  goal.allowed = function(x, y, z) return y == level and rowRoute.withinRadius(toWorld({ x = x, y = y, z = z })) end
  goal.mining, goal.blocked, goal.limit = true, {}, 40000
  navigate(goal)
end

function rowRoute.unwind()
  local r = miningRoute
  if not r.work or rowRoute.surfacePhase() then return end
  local current = toWorld(pos)
  if samePos(current, r.work) then return end
  local path = r.veinPath or (fleetJob and fleetJob.vein) or {}
  local index
  for i = #path, 1, -1 do if samePos(current, path[i]) then index = i break end end
  if not index then
    if rowRoute.opened(current) or rowRoute.inColumns(current) then return end
    if current.y ~= r.targetY then rowRoute.rejoin() end
    return
  end
  rowRoute.save("unwinding")
  while index > 0 do
    rowRoute.walkStep(index > 1 and path[index - 1] or r.work, true)
    index = index - 1
    r.unwindIndex = index
    rowRoute.save()
  end
  r.unwindIndex = nil
end

-- A staggered job's turtle works below the safe mining Y, in tunnels off
-- one shaft per column (see KINDS.staggered). Its columns are saved on the
-- route so a cleared job can still find its way out.
function rowRoute.inColumns(w)
  local c = miningRoute and miningRoute.columns
  return c ~= nil and w.x >= c.x1 and w.x <= c.x2 and w.y >= c.low and w.y < miningRoute.targetY
end

-- Back along its tunnel to the shaft, then straight up the shaft to the safe
-- mining Y. Tunnels are mined outward from the shaft, so every cell on this
-- way is already open; only fallen sand or gravel is cleared.
function rowRoute.leaveColumns()
  local c, w = miningRoute.columns, toWorld(pos)
  if not rowRoute.inColumns(w) then return end
  rowRoute.save("toShaft")
  setDetail("Returning to the mining shaft")
  local ok, err = pcall(function()
    while w.z ~= c.z do
      rowRoute.walkStep({ x = w.x, y = w.y, z = w.z + (c.z > w.z and 1 or -1) }, true)
      w = toWorld(pos)
    end
    while w.y < miningRoute.targetY do
      rowRoute.walkStep({ x = w.x, y = w.y + 1, z = w.z }, true)
      w = toWorld(pos)
    end
  end)
  if ok then return end
  if err == STOP then error(STOP, 0) end
  -- Its tunnel or shaft isn't open where it dug it: the world rolled back.
  log("warn", "Its way out is blocked (" .. tostring(err) .. ")")
  rowRoute.rejoin()
end

-- Off every route it saved (the world rolled back after a crash, or it was
-- moved by hand). At or above its home row it goes home through open air
-- without digging. Underground it digs the shortest way to its corridor
-- level, inside its radius and around anything protected, then carries on
-- from there. Normal returns never do this; they only use the blocks they dug.
function rowRoute.rejoin()
  local r, w = miningRoute, toWorld(pos)
  rowRoute.save("rejoining")
  if w.y >= r.home.y then
    log("warn", ("Off its saved route at X %d, Y %d, Z %d: flying home"):format(w.x, w.y, w.z))
    setDetail("Flying back home")
    -- Never higher than a few blocks above where it is or its home.
    local goal, ceiling = cellGoal(fromWorld(r.home)), math.max(w.y, r.home.y) + 4
    goal.allowed = function(x, y, z) return toWorld({ x = x, y = y, z = z }).y <= ceiling end
    rowRoute.flying = true
    local ok, err = pcall(navigate, goal)
    rowRoute.flying = false
    if not ok then error(err, 0) end
    return
  end
  local target = { x = w.x, y = r.targetY, z = r.columns and r.columns.z or w.z }
  log("warn", ("Off its saved route at X %d, Y %d, Z %d: digging back to Y %d"):format(w.x, w.y, w.z, r.targetY))
  setDetail("Digging back to its route")
  local goal = cellGoal(fromWorld(target))
  local top = math.max(r.targetY, w.y)
  goal.allowed = function(x, y, z)
    local c = toWorld({ x = x, y = y, z = z })
    return c.y <= top and rowRoute.withinRadius(c)
  end
  goal.mining, goal.blocked, goal.limit = true, {}, 40000
  navigate(goal)
end

-- At the safe mining Y, a staggered job's corridor runs along its shaft row
-- and the stair bottom joins it straight along the home column. Following
-- those two legs keeps travel in the blocks already dug.
function rowRoute.corridor(target)
  local c, h, w = miningRoute.columns, miningRoute.home, toWorld(pos)
  if c then
    -- Onto the corridor row, unless both ends are on the home column.
    if w.z ~= c.z and not (w.x == h.x and target.x == h.x) then
      rowRoute.flatMine({ x = w.x, y = target.y, z = c.z })
    end
    -- Along it to the target's column, or to the home column for the stairs.
    w = toWorld(pos)
    local x = target.z == c.z and target.x or h.x
    if w.z == c.z and w.x ~= x then rowRoute.flatMine({ x = x, y = target.y, z = c.z }) end
  end
  rowRoute.flatMine(target)
end

-- How far it walks to its stair bottom, for fuel estimates.
function rowRoute.toBottom(w)
  local c, b = miningRoute.columns, miningRoute.bottom
  if not c or not (rowRoute.inColumns(w) or (w.y == b.y and w.z == c.z)) then return distance(w, b) end
  return math.abs(w.z - c.z) + (b.y - w.y) + math.abs(w.x - b.x) + math.abs(c.z - b.z)
end

-- When GPS disagreed with where it thought it was (moved by hand, or the
-- world rolled back), its facing is in doubt and it won't travel. One step
-- sideways into open space with a GPS fix there settles the facing; then it
-- steps back. It never digs to do this.
function rowRoute.findFacing()
  local deadline = os.clock() + 10
  while not gpsChecked and os.clock() < deadline do waitSeconds(0.5) end
  -- A move left half-done when the server stopped is settled by its next
  -- GPS fix, which comes every 30 seconds.
  deadline = os.clock() + 35
  while miningRoute and miningRoute.pendingMove and gpsState == "ok" and os.clock() < deadline do waitSeconds(0.5) end
  if gpsTrusted() or not calib then return end
  if gpsState ~= "ok" then
    error("No GPS signal here, so it can't confirm where it is. GPS hosts placed higher reach deeper; or move it by hand.", 0)
  end
  setDetail("Finding its facing with GPS")
  -- With no open side at all (in a shaft, say), it climbs through open space
  -- and tries again higher up, but never above its home row. If it could
  -- step aside but GPS didn't settle its facing, it stops there: climbing
  -- wouldn't help, and in open air it would only rise into the sky.
  local top = miningRoute and miningRoute.home.y - 1 or calib.w.y
  for _ = 1, 128 do
    local found, stepped = rowRoute.stepAside()
    if found then return end
    if stepped then
      error("GPS didn't settle its facing after stepping aside. GPS may be unreliable here; move it one block sideways by hand.", 0)
    end
    if turtle.detectUp() or (gpsState == "ok" and calib.w.y + pos.y - calib.l.y >= top) then break end
    physicalMove = true
    local up = turtle.up()
    physicalMove = false
    if not up then break end
    pos.y = pos.y + 1
    saveState()
  end
  error("Can't confirm its GPS position and facing: no open space beside it, or above it below the home row. Move it one block sideways by hand.", 0)
end

-- One step sideways into open space and back, with GPS fixes. Returns true
-- once its facing is known, and whether it found open space to step into.
function rowRoute.stepAside()
  local stepped = false
  for _ = 1, 4 do
    if not turtle.detect() then
      local from = { x = pos.x, z = pos.z }
      physicalMove = true
      local moved = turtle.forward()
      physicalMove = false
      if moved then
        stepped = true
        local function settle()
          local wait = os.clock() + 8
          while not gpsTrusted() and os.clock() < wait do waitSeconds(0.5) end
        end
        pos.x, pos.z = pos.x + DX[heading], pos.z + DZ[heading]
        saveState()
        settle()
        physicalMove = true
        if turtle.back() then pos.x, pos.z = from.x, from.z end
        physicalMove = false
        saveState()
        changed()
        -- If it was somewhere else entirely, the first fix only moved it to
        -- the right place; stepping back then settles the facing.
        settle()
        if gpsTrusted() then return true, true end
      end
    end
    turn(true)
  end
  return false, stepped
end

function rowRoute.exit(intent)
  if not miningRoute then error("No saved south-row route. Start a new row job first.", 0) end
  rowRoute.findFacing()
  if not gpsChecked or not gpsTrusted() or miningRoute.pendingMove then
    error("GPS hasn't confirmed its position yet. Try again in a moment.", 0)
  end
  if intent then miningRoute.intent = intent end
  setDetail("Returning to the saved staircase")
  rowRoute.reconcile()
  rowRoute.unwind()
  rowRoute.leaveColumns()
  local w = toWorld(pos)
  if w.y == 67 and (rowRoute.surfacePhase() or rowRoute.opened(w)) then
    setDetail("Returning to the saved home")
    rowRoute.save("toStairHome")
    rowRoute.surface(miningRoute.home)
  else
    local step, upper = rowRoute.position(w)
    if not step or not rowRoute.opened(w) then
      rowRoute.save("toBottom")
      rowRoute.corridor(miningRoute.bottom)
      step, upper = rowRoute.position(toWorld(pos))
    end
    rowRoute.save("climbing")
    setDetail("Climbing the saved staircase")
    while step > 0 do
      if not upper then
        rowRoute.walkStep({ x = miningRoute.home.x, y = 68 - step, z = rowRoute.stairZ(step, miningRoute.radius) })
      end
      rowRoute.walkStep({ x = miningRoute.home.x, y = 68 - step, z = rowRoute.stairZ(step - 1, miningRoute.radius) })
      step, upper = step - 1, false
    end
  end
  faceCompass(2)
  rowRoute.save("home")
end

function rowRoute.enter(a, service)
  setDetail("Heading to the mining level")
  rowRoute.ensure(a)
  rowRoute.unwind()
  -- Out of any earlier job's columns before taking on this job's.
  rowRoute.leaveColumns()
  miningRoute.columns = a.pattern == "staggered"
    and { x1 = math.min(a.first, a.last), x2 = math.max(a.first, a.last), z = a.z, low = a.low } or nil
  if not rowRoute.surfacePhase() and toWorld(pos).y == a.y and not rowRoute.position(toWorld(pos)) then
    rowRoute.save("toWork")
    rowRoute.corridor({ x = a.x, y = a.y, z = a.z })
    rowRoute.save("work")
    return
  end
  if toWorld(pos).y == 67 and not rowRoute.position(toWorld(pos)) then rowRoute.surface(miningRoute.home) end
  local depth = 67 - a.y
  while true do
    checkStop()
    rowRoute.reconcile()
    local w = toWorld(pos)
    local step, upper = rowRoute.position(w)
    if not step then error("The turtle is not on its saved staircase", 0) end
    if service and (emptySlots() <= 2 or fuelLevel() < 2 * (distance(w, miningRoute.home) + depotCost(miningRoute.home)) + 100) then
      service()
      setDetail("Heading to the mining level")
      w = toWorld(pos)
      step, upper = rowRoute.position(w)
      if not step then error("Depot servicing did not return the turtle to its saved home", 0) end
    end
    if step == depth and not upper then break end
    if upper then
      local target = { x = w.x, y = 67 - step, z = w.z }
      if step <= miningRoute.stair.completed then rowRoute.save("descending"); rowRoute.walkStep(target)
      else rowRoute.buildLeg("down", target, "down", step) end
    else
      local nextStep = step + 1
      local target = { x = w.x, y = w.y, z = rowRoute.stairZ(nextStep, miningRoute.radius) }
      if nextStep <= miningRoute.stair.completed or (nextStep == miningRoute.stair.completed + 1 and miningRoute.stair.half) then
        rowRoute.save("descending"); rowRoute.walkStep(target)
      else rowRoute.buildLeg("forward", target, "forward", nextStep) end
    end
  end
  miningRoute.stair.complete, miningRoute.bottomSaved = true, true
  rowRoute.save("toWork")
  rowRoute.corridor({ x = a.x, y = a.y, z = a.z })
  rowRoute.save("work")
end

function depotVisit(minFuel)
  if not miningRoute then return rowRoute.sharedDepotVisit(minFuel, false) end
  if not fleet.depot or fleet.depot.y ~= 67 then error("The shared depot dock must be at Y 67", 0) end
  miningRoute.minFuel = math.max(miningRoute.minFuel or 0, minFuel or 0)
  local flown = 0
  if miningRoute.phase ~= "fromDepot" then
    if miningRoute.phase ~= "toDepot" then rowRoute.exit() end
    rowRoute.save("toDepot")
    flown = rowRoute.sharedDepotVisit(miningRoute.minFuel + depotCost(miningRoute.home) + 64, true)
    rowRoute.save("fromDepot")
  end
  setDetail("Returning home from the depot")
  rowRoute.surface(miningRoute.home)
  faceCompass(2)
  miningRoute.minFuel = nil
  rowRoute.save("home")
  return flown
end

-- A cancelled assignment can be cleared before the return finishes. Keep
-- that obligation on the permanent route so a reboot still completes it.
-- Fuel to get from here back to the saved home, with a margin.
function rowRoute.fuelHome()
  local w = toWorld(pos)
  if w.y >= 67 then return 2 * distance(w, miningRoute.home) + 64 end
  return rowRoute.toBottom(w) + 2 * (67 - miningRoute.targetY) + 64
end

-- Going home goes straight there with whatever it carries, and only calls
-- at the depot when it hasn't the fuel to get home. A job's own depot trip
-- still unloads and refuels.
function rowRoute.recover()
  if not miningRoute then error("No saved south staircase to recover", 0) end
  rowRoute.findFacing()
  if not gpsTrusted() then
    error("GPS hasn't confirmed its position yet. Try again in a moment.", 0)
  end
  dock.dropJunk()
  if miningRoute.intent == "service" or fuelLevel() < rowRoute.fuelHome() then depotVisit(miningRoute.minFuel or 0)
  else rowRoute.exit() end
  miningRoute.intent, miningRoute.service = nil, nil
  rowRoute.save("home")
  release("depot")
end

function vein.isVein(block)
  return matches(block.name, compiled.vein)
end

-- Dig out a vein of ore starting at the block on side `dir`, then come back.
-- veins.left caps how many blocks; veins.allowed(w), if set, says which world
-- blocks it may dig. veins.path is the way in from where it started. If
-- veins.full(depth) says it needs the depot before going deeper, it stops and
-- sets veins.cut to that way in, so it can come back and finish the vein.
local exploreHere

-- Back into the neighbouring block p it came from, turning as little as it
-- can: if it's facing away from p, it just backs up.
local function stepBack(p)
  if p.y ~= pos.y then return goTo(p, "y") end
  local toward = 0
  for h = 0, 3 do
    if pos.x + DX[h] == p.x and pos.z + DZ[h] == p.z then toward = h end
  end
  local away = (toward + 2) % 4
  if turnsTo(away) < turnsTo(toward) then
    face(away)
    if move("back") then return end
  end
  goTo(p, "xyz")
end

function vein.checkpointVein(veins)
  if veins.checkpoint then veins.checkpoint() end
end

function vein.cutVein(veins)
  veins.cut = { table.unpack(veins.path) }
  vein.checkpointVein(veins)
end

function vein.mineVein(dir, veins, depth)
  if veins.cut then return end
  local found, block = SIDES[dir].inspect()
  if not (found and vein.isVein(block)) or protection(dir, block) then return end
  if veins.allowed and not veins.allowed(toWorld(neighbour(dir))) then return end
  -- A bounded pass yields at an observed ore block, rather than silently
  -- abandoning a large or deep vein. Replay reaches this point next time.
  if veins.left <= 0 or (veins.full and veins.full(#veins.path + 1)) then
    vein.cutVein(veins)
    return
  end
  veins.left = veins.left - 1
  local back = here()
  -- Save the intended step before movement saves its new position. A reboot
  -- can then replay the seed even if the ore vanished during that move.
  veins.path[#veins.path + 1] = toWorld(neighbour(dir))
  vein.checkpointVein(veins)
  if not tryDigMove(dir, nil, 10) then
    -- Ore the game won't let it break (spawn protection or a land claim),
    -- or another turtle sitting where the vein goes.
    table.remove(veins.path)
    vein.checkpointVein(veins)
    return
  end
  -- Coming in sideways, the block behind is the one it came from.
  exploreHere(veins, depth + 1, dir == "forward" and (back.heading + 2) % 4 or nil)
  stepBack(back)
  table.remove(veins.path)
  vein.checkpointVein(veins)
end

-- Follow the vein from every side of the block it's in (except `behind`, a
-- heading), looking at the nearest side next so it turns as little as it can.
function exploreHere(veins, depth, behind)
  if veins.cut then return end
  vein.mineVein("up", veins, depth)
  vein.mineVein("down", veins, depth)
  local sides = {}
  for h = 0, 3 do
    if h ~= behind then sides[#sides + 1] = h end
  end
  while #sides > 0 and not veins.cut do
    local best = 1
    for n = 2, #sides do
      if turnsTo(sides[n]) < turnsTo(sides[best]) then best = n end
    end
    face(table.remove(sides, best))
    vein.mineVein("forward", veins, depth)
  end
end

-- Finish a vein it left for the depot: back in along the way it dug, then
-- look around every block of that way again on the way out.
function vein.resumeVein(veins, path)
  local start = here()
  veins.path = {}
  for i, w in ipairs(path) do
    goWorld(w, "xyz")
    veins.path[i] = w
    vein.checkpointVein(veins)
  end
  veins.resume = nil
  vein.checkpointVein(veins)
  for i = #path, 1, -1 do
    exploreHere(veins, i)
    table.remove(veins.path)
    if i > 1 then goWorld(path[i - 1], "xyz") end
    vein.checkpointVein(veins)
  end
  goTo(start, "xyz")
  face(start.heading)
end

-- What a level job can be told to collect (by the dashboard's names), counted
-- as items it brings back. "valuables" is everything on the valuables list.
local GOAL_ITEMS = {
  diamond = { name = "diamonds", match = { "*diamond*" } },
  redstone = { name = "redstone", match = { "*redstone*" } },
  gold = { name = "gold", match = { "*gold*" } },
  lapis = { name = "lapis", match = { "*lapis*" } },
  iron = { name = "iron", match = { "*iron*" } },
  copper = { name = "copper", match = { "*copper*" } },
  coal = { name = "coal", match = { "*coal*" } },
  emerald = { name = "emeralds", match = { "*emerald*" } },
  debris = { name = "ancient debris", match = { "*ancient_debris*" } },
  valuables = { name = "valuables" },
}

local function countItems(patterns)
  local n = 0
  for slot = 1, 16 do
    if turtle.getItemCount(slot) > 0 then
      local item = turtle.getItemDetail(slot)
      if item and matches(item.name, patterns) then n = n + item.count end
    end
  end
  return n
end

-- A goal for reaching any of some columns (local x1..x2, z1..z2) at height y,
-- or anywhere above it too with orAbove.
local function columnsGoal(cols, y, orAbove)
  local function off(v, lo, hi) return math.max(lo - v, 0, v - hi) end
  return {
    reached = function(x, yy, z)
      return x >= cols.x1 and x <= cols.x2 and z >= cols.z1 and z <= cols.z2 and (yy == y or (orAbove and yy > y))
    end,
    estimate = function(x, yy, z)
      return off(x, cols.x1, cols.x2) + off(z, cols.z1, cols.z2) + (orAbove and math.max(y - yy, 0) or math.abs(yy - y))
    end,
    centre = { x = cols.x1, y = y, z = cols.z1 },
    bounds = {
      lo = { x = math.min(pos.x, cols.x1) - 24, y = math.min(pos.y, y) - 24, z = math.min(pos.z, cols.z1) - 24 },
      hi = { x = math.max(pos.x, cols.x2) + 24, y = math.max(pos.y, y) + 32, z = math.max(pos.z, cols.z2) + 24 },
    },
  }
end

-- Fleet job kinds. Each walks a numbered sequence of steps in world
-- coordinates from an entry column, so it can stop for the depot (or a reboot)
-- at any step and pick up where it left off.
local KINDS = {}

-- Mine one target level in parallel, two-high, fully inspected tunnels.

-- How far along the tunnels, and how far to their right, world block w is.
local function along(a, w) return (w.x - a.x) * CX[a.dir] + (w.z - a.z) * CZ[a.dir] end
local function across(a, w)
  local r = (a.dir + 1) % 4
  return (w.x - a.x) * CX[r] + (w.z - a.z) * CZ[r]
end

local function tunnelCell(a, i)
  return { x = a.x + i * CX[a.dir], y = a.y, z = a.z + i * CZ[a.dir] }
end

local function goalOf(a)
  return GOAL_ITEMS[a.goalItem] or GOAL_ITEMS.valuables
end

local function branchClearHeadroom()
  local ok, reason = clear("up")
  if not ok then error("Can't clear tunnel headroom: " .. tostring(reason), 0) end
end

KINDS.branchMine = {
  total = function(a) return a.length end,
  entry = function(a) return a.routeHome end,
  cell = tunnelCell,
  inside = function(a, w)
    local d = along(a, w)
    return across(a, w) == 0 and d >= 0 and d < a.length and w.y == a.y
      and (not a.radius or rowRoute.inCircle(w, a.routeHome, a.radius))
  end,
  -- Veins stay within the band and this turtle's slice: up to halfway to the
  -- next turtle's tunnel on either side.
  mayDig = function(a, w)
    if a.radius and not rowRoute.inCircle(w, a.routeHome, a.radius) then return false end
    if a.coverage == "allSides" then return type(a.veinBounds) == "table" and inBox(w, a.veinBounds) end
    if a.band == nil then return true end -- a job from before height bands
    local s, x, d = a.spacing or 3, across(a, w), along(a, w)
    return w.y >= a.y - a.band and w.y <= a.y + 1 + a.band and d >= 0 and d < a.length
      and x >= -math.floor((s - 1) / 2) and x <= math.ceil((s - 1) / 2)
  end,
  walk = function(a, t) rowRoute.flatMine(t) end,
  -- Both walls, the nearer first: four turns a block, whichever way along the
  -- tunnel it's going.
  work = function(a, i, veins)
    if a.coverage == "allSides" then
      local root = here()
      local function finish()
        if not samePos(pos, root) then stepBack(root) end
        face(root.heading)
        return not veins.cut
      end
      local upper = toWorld({ x = pos.x, y = pos.y + 1, z = pos.z })
      if veins.allowed and not veins.allowed(upper) then error("Tunnel headroom is outside its planned mining bounds", 0) end
      if not a.scan then branchClearHeadroom() return true end
      if veins.resume then
        vein.resumeVein(veins, veins.resume)
        if veins.cut then return finish() end
      end
      -- Follow an ore headroom seed before clearing the tunnel's upper cell.
      exploreHere(veins, 0)
      if veins.cut then return finish() end
      branchClearHeadroom()
      if veins.full and veins.full(1) then
        vein.cutVein(veins)
        return finish()
      end
      -- Keep the ordinary upper-cell move in the lower-root path. Depot and
      -- reboot recovery can replay it, including a reboot during the move.
      veins.path[#veins.path + 1] = toWorld(neighbour("up"))
      vein.checkpointVein(veins)
      digMove("up")
      exploreHere(veins, 1)
      stepBack(root)
      table.remove(veins.path)
      vein.checkpointVein(veins)
      return finish()
    end
    branchClearHeadroom()
    if not a.scan then return true end
    if veins.resume then vein.resumeVein(veins, veins.resume) end
    vein.mineVein("down", veins, 0)
    local along = (a.dir - calib.f0) % 4
    local walls = { (along + 1) % 4, (along + 3) % 4 }
    if turnsTo(walls[2]) < turnsTo(walls[1]) then walls[1], walls[2] = walls[2], walls[1] end
    for _, h in ipairs(walls) do
      face(h)
      vein.mineVein("forward", veins, 0)
    end
    return not veins.cut
  end,
  goal = function(a)
    if (a.goal or 0) <= 0 then return nil end
    local g = goalOf(a)
    return { count = a.goal, name = g.name, patterns = g.match and cfg.compileList(g.match) or compiled.valuables }
  end,
  detail = function(a, i, fj)
    local c = tunnelCell(a, math.min(i, a.length - 1))
    local where = ("Y %d, %d of %d blocks out"):format(c.y, along(a, c) + 1, a.length)
    if (a.goal or 0) > 0 then
      return ("Found %d of %d %s (%s)"):format(fj.found or 0, a.goal, goalOf(a).name, where)
    end
    return "Tunnel at " .. where
  end,
  enter = function(a, service) rowRoute.enter(a, service) end,
  exit = function() rowRoute.exit() end,
}

-- Staggered mining runs 1x1 north-south tunnels through the whole cylinder.
-- On every level there is a tunnel in one of every five columns, shifted
-- two columns east for each level down: column x has a tunnel at level y
-- when (x + 2y) % 5 == 0. Each tunnel block is checked up, down, east and
-- west, and every block between tunnels touches exactly one tunnel, so no
-- exposed ore is missed while only a fifth of the rock is dug.
--
-- A turtle takes a run of columns, from a.first to a.last. Each column's
-- tunnels cross a shaft at Z -55 (a.z), the circle's widest row, and run
-- out north and south to the circle's edge. The shafts hang off a corridor
-- along Z -55 at the access level a.y, two above the top tunnel, where the
-- staircase ends. Tunnels are mined outward from the shaft, so the way
-- back is always open.
--
-- Levels are mined in passes of five, starting with the band around a.peak,
-- where the ore is most common, and moving outward. A pass has one tunnel
-- in each column, so it sweeps the run, back and forth on alternate passes.
-- Each shaft is always dug in one piece from the corridor down, so once a
-- pass has reached every column, later passes cross between shafts at depth.
local staggeredPlans = setmetatable({}, { __mode = "k" })

local function staggeredHalf(a, x)
  return math.floor(math.sqrt(a.radius ^ 2 - (x - a.routeHome.x) ^ 2))
end

local function staggeredPlan(a)
  local plan = staggeredPlans[a]
  if plan then return plan end
  plan = { total = 0 }
  local top, low = a.y - 1, a.low
  local peak = math.max(low, math.min(top, tonumber(a.peak) or top))
  -- Bands of five levels, the peak's band whole where the levels allow.
  local base = math.max(low, math.min(peak - 2, top - 4))
  local bands, k = {}, 0
  while base + 5 * (k - 1) + 4 >= low do k = k - 1 end
  while base + 5 * k <= top do bands[#bands + 1] = k; k = k + 1 end
  table.sort(bands, function(p, q) return math.abs(p) < math.abs(q) or (math.abs(p) == math.abs(q) and p > q) end)
  local cols, deepest = {}, {}
  for x = a.first, a.last, a.last >= a.first and 1 or -1 do
    cols[#cols + 1], deepest[x] = x, a.y
  end
  -- Work done before this turtle took these columns over (a.done, from a
  -- turtle joining the job): every pass before done.pass, and in that pass
  -- the column ranges done.cols. It isn't mined again, but it was dug.
  local done = type(a.done) == "table" and a.done or { pass = 0, cols = {} }
  local function finished(pass, x)
    if pass < done.pass then return true end
    if pass > done.pass then return false end
    for _, r in ipairs(done.cols) do
      if x >= r[1] and x <= r[2] then return true end
    end
    return false
  end
  for pass, band in ipairs(bands) do
    -- Every shaft is dug at least this far down when the pass starts.
    local floor = -math.huge
    for _, x in ipairs(cols) do floor = math.max(floor, deepest[x]) end
    local hi, lo = math.min(top, base + 5 * band + 4), math.max(low, base + 5 * band)
    for n = 1, #cols do
      local x = cols[pass % 2 == 1 and n or #cols + 1 - n]
      for y = hi, lo, -1 do
        if (x + 2 * y) % 5 == 0 then
          if not finished(pass, x) then
            local h = staggeredHalf(a, x)
            plan[#plan + 1] = { x = x, y = y, h = h, floor = floor, pass = pass, start = plan.total }
            plan.total = plan.total + 2 * h + 1
          end
          deepest[x] = math.min(deepest[x], y)
        end
      end
    end
  end
  plan.passes = #bands
  staggeredPlans[a] = plan
  return plan
end

-- Step i: a tunnel's shaft crossing, then north to the edge, then south
-- from the shaft to the edge.
local function staggeredCell(a, i)
  local plan = staggeredPlan(a)
  if #plan == 0 then return { x = a.first, y = a.y - 1, z = a.z, floor = a.y, pass = 0, passes = plan.passes, start = 0 } end
  i = math.max(0, math.min(i, plan.total - 1))
  local lo, hi = 1, #plan
  while lo < hi do
    local mid = math.floor((lo + hi + 1) / 2)
    if plan[mid].start <= i then lo = mid else hi = mid - 1 end
  end
  local t = plan[lo]
  local j = i - t.start
  return {
    x = t.x, y = t.y, z = j <= t.h and a.z - j or a.z + j - t.h,
    floor = t.floor, pass = t.pass, passes = plan.passes, start = t.start,
  }
end

-- Straight along one world axis to t's coordinate, stopping at a block it
-- may not break: returns false, why and the block's name there.
local function staggeredLeg(t, axis)
  while true do
    local w = toWorld(pos)
    if w[axis] == t[axis] then return true end
    local up = t[axis] > w[axis]
    local dir = "forward"
    if axis == "y" then dir = up and "up" or "down"
    elseif axis == "x" then faceCompass(up and 1 or 3)
    else faceCompass(up and 2 or 0) end
    local ok, why, name = tryDigMove(dir)
    if not ok then return false, why, name end
  end
end

KINDS.staggered = {
  total = function(a) return staggeredPlan(a).total end,
  entry = function(a) return a.routeHome end,
  cell = staggeredCell,
  -- On the corridor, a shaft or a tunnel of this turtle's columns.
  inside = function(a, w)
    if w.x < math.min(a.first, a.last) or w.x > math.max(a.first, a.last) or w.y > a.y or w.y < a.low then return false end
    if w.z == a.z then return true end
    return w.y < a.y and (w.x + 2 * w.y) % 5 == 0 and math.abs(w.z - a.z) <= staggeredHalf(a, w.x)
  end,
  mayDig = function(a, w)
    return rowRoute.inCircle(w, a.routeHome, a.radius) and type(a.veinBounds) == "table" and inBox(w, a.veinBounds)
  end,
  -- Back along the tunnel to its shaft. For another column, up its own shaft
  -- to a level every shaft between is dug to (the corridor at first) and
  -- across. Then up or down the target shaft, deepening only that one, and
  -- out along the tunnel. Returns false, "shaft" or "tunnel" when a block it
  -- may not break is in the way.
  walk = function(a, t)
    -- How far down each shaft stopped at such a block.
    local stopped = fleetJob.stoppedShafts or {}
    if stopped[t.x] and t.y < stopped[t.x] then return false, "shaft" end
    local w = toWorld(pos)
    if w.x ~= t.x or w.y ~= t.y then
      if w.z ~= a.z then goWorld({ z = a.z }, "z") end
      if w.x ~= t.x then
        local across = math.min(a.y, math.max(w.y, t.y, t.floor or a.y))
        for x = math.min(w.x, t.x), math.max(w.x, t.x) do
          if stopped[x] and stopped[x] > across then across = a.y end
        end
        goWorld({ y = across }, "y")
        if across == a.y then rowRoute.flatMine({ x = t.x, y = a.y, z = a.z })
        else goWorld({ x = t.x }, "x") end
      end
      local ok, why, name = staggeredLeg(t, "y")
      if not ok then
        stopped[t.x] = toWorld(pos).y
        fleetJob.stoppedShafts = stopped
        log("warn", ("Shaft at X %d stops at Y %d: %s %s. Skipping its tunnels below."):format(t.x, stopped[t.x], name, why))
        return false, "shaft"
      end
    end
    local ok, why, name = staggeredLeg(t, "z")
    if not ok then
      local w = toWorld(pos)
      log("warn", ("Tunnel stops at X %d, Y %d, Z %d: %s %s. Skipping the rest of it."):format(w.x, w.y, w.z, name, why))
      return false, "tunnel"
    end
  end,
  -- Which pass and column step i is in.
  at = function(a, i)
    local c = staggeredCell(a, i)
    return { pass = c.pass, x = c.x }
  end,
  -- Past a blocked tunnel half, on to the other half or the next tunnel.
  skip = function(a, i, why)
    local plan = staggeredPlan(a)
    local lo, hi = 1, #plan
    while lo < hi do
      local mid = math.floor((lo + hi + 1) / 2)
      if plan[mid].start <= i then lo = mid else hi = mid - 1 end
    end
    local t = plan[lo]
    if why == "tunnel" and i - t.start <= t.h then return t.start + t.h + 1 end
    return t.start + 2 * t.h + 1
  end,
  -- Up, down, east and west. North and south are the tunnel itself.
  work = function(a, i, veins)
    local root = here()
    local function finish()
      if not samePos(pos, root) then stepBack(root) end
      face(root.heading)
      return not veins.cut
    end
    if veins.resume then
      vein.resumeVein(veins, veins.resume)
      if veins.cut then return finish() end
    end
    vein.mineVein("up", veins, 0)
    vein.mineVein("down", veins, 0)
    local walls = { (1 - calib.f0) % 4, (3 - calib.f0) % 4 }
    if turnsTo(walls[2]) < turnsTo(walls[1]) then walls[1], walls[2] = walls[2], walls[1] end
    for _, h in ipairs(walls) do
      if veins.cut then break end
      face(h)
      vein.mineVein("forward", veins, 0)
    end
    return finish()
  end,
  detail = function(a, i)
    local c = staggeredCell(a, i)
    return ("Pass %d of %d, tunnel at X %d, Y %d, Z %d"):format(c.pass, c.passes, c.x, c.y, c.z)
  end,
  enter = function(a, service) rowRoute.enter(a, service) end,
  exit = function() rowRoute.exit() end,
}

local function kindOf(job)
  if job.kind == "branchMine" and job.args and job.args.pattern == "staggered" then return KINDS.staggered end
  return KINDS[job.kind]
end

-- The quarry's columns and top height in local coordinates.
local function quarryColumns(a)
  local p, q = fromWorld({ x = a.x1, y = a.yTop, z = a.z1 }), fromWorld({ x = a.x2, y = a.yTop, z = a.z2 })
  return { x1 = math.min(p.x, q.x), x2 = math.max(p.x, q.x), z1 = math.min(p.z, q.z), z2 = math.max(p.z, q.z) }, p.y
end

-- A box from yTop down to yBottom, three layers per pass.
local function quarryCell(a, i)
  local W, L = a.x2 - a.x1 + 1, a.z2 - a.z1 + 1
  local per = W * L
  local p, k = math.floor(i / per), i % per
  if p % 2 == 1 then k = per - 1 - k end -- every other pass runs the snake backwards
  local row, col = math.floor(k / L), k % L
  if row % 2 == 1 then col = L - 1 - col end
  local top = a.yTop - 3 * p
  local bottom = math.max(top - 2, a.yBottom)
  return { x = a.x1 + row, y = bottom < top and top - 1 or top, z = a.z1 + col, top = top, bottom = bottom }
end

KINDS.areaQuarry = {
  total = function(a)
    return (a.x2 - a.x1 + 1) * (a.z2 - a.z1 + 1) * math.ceil((a.yTop - a.yBottom + 1) / 3)
  end,
  entry = function(a) return { x = a.x1, y = a.yTop, z = a.z1 } end,
  cell = quarryCell,
  inside = function(a, w)
    return w.x >= a.x1 and w.x <= a.x2 and w.z >= a.z1 and w.z <= a.z2 and w.y <= a.yTop and w.y >= a.yBottom
  end,
  walk = function(a, t) goWorld(t, "xzy") end,
  -- Fly without digging to any open block just above the box, then dig down
  -- into it. Nothing above the box is ever dug.
  enter = function(a)
    local cols, top = quarryColumns(a)
    local ok, err = pcall(navigate, columnsGoal(cols, top + 1))
    if not ok then
      if err == STOP then error(STOP, 0) end
      error(("Can't get into the quarry from above without digging. Its top (Y %d) must be at or above the ground."):format(a.yTop), 0)
    end
    digMove("down")
  end,
  -- Up through the dug layers to the top; the way out above is open.
  exit = function(a)
    if KINDS.areaQuarry.inside(a, toWorld(pos)) then goWorld({ y = a.yTop }, "y") end
  end,
  work = function(a, i)
    local c = quarryCell(a, i)
    if c.y < c.top then clear("up") end
    if c.bottom < c.y then clear("down") end
  end,
  detail = function(a, i)
    local c = quarryCell(a, math.max(0, i - 1))
    return ("Quarry layers %d to %d"):format(c.top, c.bottom)
  end,
}

-- Fuel to get from here to the depot and back again: out of the job the way
-- it really goes (back through its own tunnels to where it came in, plus
-- `extra` for a detour it's on), the flight from there, and the same back,
-- with a margin.
local function roundTrip(k, a, extra)
  if a.routeMode == "southRow" and miningRoute then
    return 2 * (rowRoute.toBottom(toWorld(pos)) + 2 * (67 - a.y)
      + (extra or 0) + depotCost(miningRoute.home, fleetJob.route)) + 100
  end
  local e = k.entry(a)
  local w = toWorld(pos)
  local access = k.accessCost and k.accessCost(a, w) or 0
  return 2 * (distance(w, e) + access + (extra or 0) + depotCost(e, fleetJob.route)) + 100
end

-- Remember the longest real flight between the depot and the job, from one of
-- `flown` blocks that started or ended at world position w.
local function noteRoute(k, a, flown, w)
  if a.routeMode == "southRow" then
    fleetJob.route = math.max(fleetJob.route or 0, flown)
    return
  end
  fleetJob.route = math.max(fleetJob.route or 0, flown + distance(w, k.entry(a)))
end

-- From anywhere to step i. Coming in from the depot, it measures the flight.
local function moveToStep(k, a, i, service)
  if a.routeMode == "southRow" then rowRoute.unwind() end
  if not k.inside(a, toWorld(pos)) then
    local from, start = toWorld(pos), odometer
    k.enter(a, service)
    if dock.atDepot(from) then noteRoute(k, a, odometer - start, toWorld(pos)) end
  end
  return k.walk(a, k.cell(a, i))
end

-- From anywhere in the job, out to where it can fly from.
local function leaveWork(k, a)
  k.exit(a)
end

local function fleetWork()
  local k = kindOf(fleetJob)
  if not k then error("Unknown fleet job " .. tostring(fleetJob.kind), 0) end
  if not fleet.depot then error("Set up the depot on the dashboard first", 0) end
  local a = fleetJob.args
  if fleetJob.kind == "branchMine" then rowRoute.ensure(a) else ensureCalibrated() end
  local total = k.total(a)
  local goal = k.goal and k.goal(a)

  -- Count goal items as they turn up in the inventory: not ones it started
  -- with, and not ones it has since dropped off or burnt.
  local function tally()
    if not goal then return end
    local now = countItems(goal.patterns)
    fleetJob.found = (fleetJob.found or 0) + math.max(0, now - (fleetJob.held or now))
    fleetJob.held = now
  end

  local function done()
    return fleetJob.step >= total or (goal ~= nil and (fleetJob.found or 0) >= goal.count)
  end

  -- Cover replaying a saved route before another bounded exploration pass.
  -- The extra detour allowance also covers the endpoint's return estimate.
  local function continuationFuel()
    local replay = fleetJob.vein and #fleetJob.vein or 0
    return roundTrip(k, a, 2 * replay) + replay
  end

  local function visit()
    tally()
    if a.routeMode == "southRow" then dock.dropJunk() end
    local need = continuationFuel()
    fleetJob.phase = "depot"
    saveState()
    if a.routeMode == "southRow" then
      miningRoute.intent = "service"
      rowRoute.save()
    else leaveWork(k, a) end
    local from = toWorld(pos)
    noteRoute(k, a, depotVisit(need + 200), from)
    if a.routeMode == "southRow" then miningRoute.intent = nil end
    fleetJob.phase = "work"
    setDetail("Returning to the mine")
    saveState()
    tally()
  end

  -- Before each step: burn fuel it's carrying, and go to the depot if it's
  -- nearly full or hasn't the fuel to get there and back. After a step cut
  -- short (a vein it had no room or fuel to finish), it wants a bit more.
  local function service(cut)
    -- Junk goes in batches as it builds up: at most about a stack is carried,
    -- without leaving an item behind for every block mined.
    if a.routeMode == "southRow" then dock.tidy() end
    local need = continuationFuel() + (cut and 64 or 0)
    if emptySlots() > 2 and fuelLevel() >= need then return end
    tally()
    refuelFromInventory(need + 200)
    -- Room taken by junk is freed on the spot rather than by a depot trip.
    if a.routeMode == "southRow" then dock.dropJunk() end
    tally()
    if emptySlots() <= 2 or fuelLevel() < need then visit() end
  end

  -- Switch to settings that hand some columns to a turtle joining the job,
  -- keeping its place: the same tunnel, the same block of it.
  local function shareColumns()
    local nextArgs = fleetJob.nextArgs
    fleetJob.nextArgs = nil
    local c, step = staggeredCell(a, fleetJob.step), nil
    for _, t in ipairs(staggeredPlan(nextArgs)) do
      if t.pass == c.pass and t.x == c.x and t.y == c.y then
        step = t.start + fleetJob.step - c.start
        break
      end
    end
    if not step then
      log("warn", "Couldn't share its columns: it had moved past them")
      saveState()
      return
    end
    staggeredPlans[a] = nil
    for key in pairs(a) do a[key] = nil end
    for key, value in pairs(nextArgs) do a[key] = value end
    fleetJob.step, total = step, k.total(a)
    miningRoute.columns = { x1 = math.min(a.first, a.last), x2 = math.max(a.first, a.last), z = a.z, low = a.low }
    saveState()
    log("info", ("Sharing the job: now mining columns X %d to %d"):format(miningRoute.columns.x1, miningRoute.columns.x2))
  end

  local veins = { left = 0 }
  if k.mayDig then veins.allowed = function(w) return k.mayDig(a, w) end end
  veins.full = function(depth) return emptySlots() <= 1 or fuelLevel() < roundTrip(k, a, depth) end
  if a.coverage == "allSides" then
    veins.checkpoint = function()
      if not fleetJob then return end
      local path = veins.cut or veins.resume or veins.path
      fleetJob.vein = path and { table.unpack(path) } or nil
      if a.routeMode == "southRow" then miningRoute.veinPath = path and { table.unpack(path) } or nil end
      saveState()
    end
  end

  local ok, err = pcall(function()
    if fleetJob.phase == "depot" then visit() end
    tally()
    local cut = false
    while not done() do
      checkStop()
      service(cut)
      local reached, why = moveToStep(k, a, fleetJob.step, service)
      if reached == false then
        -- A block it may not break is in the way: on to the next part of
        -- the job it can reach.
        fleetJob.step, fleetJob.vein, cut = k.skip(a, fleetJob.step, why), nil, false
        if a.routeMode == "southRow" then miningRoute.veinPath = nil end
      else
        setDetail(k.detail(a, fleetJob.step, fleetJob), fleetJob.step / total)
        if a.routeMode == "southRow" then
          miningRoute.work, miningRoute.veinPath = toWorld(pos), fleetJob.vein
          rowRoute.save("work")
        end
        veins.left, veins.path, veins.cut, veins.resume = 32, {}, nil, fleetJob.vein
        cut = k.work(a, fleetJob.step, veins) == false
        -- A vein it had to leave is finished from where it left off.
        fleetJob.vein = cut and veins.cut or nil
        if a.routeMode == "southRow" then miningRoute.veinPath = fleetJob.vein end
        if not cut then fleetJob.step = fleetJob.step + 1 end
      end
      tally()
      saveState()
      if fleetJob.nextArgs then shareColumns() end
      updateIfAsked()
      local progress = fleetJob.step / total
      if goal then progress = math.max(progress, math.min(1, (fleetJob.found or 0) / goal.count)) end
      setDetail(k.detail(a, fleetJob.step, fleetJob), progress)
    end
  end)
  if not ok and err ~= STOP and tostring(err):find("bedrock") then
    log("info", "Reached bedrock")
    fleetJob.step, ok = total, true
  end
  if not ok then
    if err == STOP then
      fleetJob.paused = true
    else
      -- Something stopped the job: note why (it can be resumed later), drop
      -- off what it mined at the depot, and go home rather than sit in the mine.
      fleetJob.failed = tostring(err)
      saveState()
      log("warn", ("Stopped: %s. Heading home."):format(tostring(err)))
      pcall(function()
        if depotReady() then
          if a.routeMode ~= "southRow" then leaveWork(k, a) end
          depotVisit(0)
        end
      end)
      pcall(comeHome)
    end
    saveState()
    error(err, 0)
  end
  if goal then
    local found = fleetJob.found or 0
    log("info", found >= goal.count and ("Goal reached: %d %s"):format(found, goal.name)
      or ("Mined its whole area: found %d of %d %s"):format(found, goal.count, goal.name))
  end
  setDetail("Job done, unloading")
  visit()
  -- The receipt keeps the job's ore count once the job itself is cleared.
  lastFleetResult = { id = fleetJob.queueId, ok = true, jobId = fleetJob.args.jobId, ores = fleetJob.ores }
  fleetJob = nil
  saveState()
  comeHome()
end

local function toCompass(v)
  return type(v) == "string" and COMPASS_INDEX[v] or clampInt(v, 0, 3, 0)
end

-- A level job's settings, checked.
function rowRoute.jobArgs(a)
  rowRoute.validate(a)
  local args = {
    kind = a.kind, x = clampInt(a.x, -3e7, 3e7, 0), z = clampInt(a.z, -3e7, 3e7, 0),
    y = a.y, dir = 2,
    radius = a.radius,
    length = math.floor(math.sqrt(a.radius^2 - (a.x - a.routeHome.x)^2)) - (a.z + 55) + 1, scan = true,
    spacing = 2, band = 0,
    goal = 0, goalItem = GOAL_ITEMS[a.goalItem] and a.goalItem or "valuables",
  }
  if a.pattern == "staggered" then
    args.pattern, args.first, args.last, args.low, args.peak, args.spacing = "staggered", a.first, a.last, a.low, a.peak, 5
    args.yTop, args.yBottom = tonumber(a.yTop), tonumber(a.yBottom)
    args.length = nil
  end
  args.routeMode, args.access, args.entryY = "southRow", "southStairs", 67
  args.routeHome = { x = a.routeHome.x, y = 67, z = -55, facing = "south" }
  args.stairBottom = { x = a.stairBottom.x, y = a.y, z = a.stairBottom.z }
  if a.coverage == "allSides" then
    local bounds = a.veinBounds
    if type(bounds) ~= "table" then error("All-side scanning needs planned vein bounds", 0) end
    local validated = {}
    for _, key in ipairs({ "x1", "y1", "z1", "x2", "y2", "z2" }) do
      local value = tonumber(bounds[key])
      local vertical = key:sub(1, 1) == "y"
      if not value or value ~= math.floor(value) or value < (vertical and -64 or -3e7)
        or value > (vertical and 319 or 3e7) then error("Invalid planned vein bounds", 0) end
      validated[key] = value
    end
    if validated.x1 > validated.x2 or validated.y1 > validated.y2 or validated.z1 > validated.z2 then
      error("Invalid planned vein bounds", 0)
    end
    args.coverage, args.veinBounds = "allSides", validated
  else error("Radius mining requires all-side ore coverage", 0) end
  -- Shared by every turtle on the same job, to add up what they mine.
  if type(a.jobId) == "string" and #a.jobId <= 64 then args.jobId = a.jobId end
  if args.pattern == "staggered" and a.done ~= nil then
    local d = a.done
    local function int(n) return type(n) == "number" and n == math.floor(n) end
    if type(d) ~= "table" or not int(d.pass) or d.pass < 0 or type(d.cols) ~= "table" or #d.cols > 32 then
      error("Invalid finished work for this job", 0)
    end
    local cols = {}
    for i, r in ipairs(d.cols) do
      if type(r) ~= "table" or not int(r[1]) or not int(r[2]) then error("Invalid finished work for this job", 0) end
      cols[i] = { r[1], r[2] }
    end
    args.done = { pass = d.pass, cols = cols }
  end
  return args
end

function jobs.fleetJob(a)
  -- The server can resend after a lost connection. A saved receipt prevents
  -- completed assignments from being mined twice, including after a reboot.
  if a.queueId and lastFleetResult and lastFleetResult.id == a.queueId then return end
  if fleetJob then error("Resume or cancel the saved fleet job first", 0) end
  local args
  if a.kind == "branchMine" then
    args = rowRoute.jobArgs(a)
  elseif a.kind == "areaQuarry" then
    local x1, x2 = clampInt(a.x1, -3e7, 3e7, 0), clampInt(a.x2, -3e7, 3e7, 0)
    local z1, z2 = clampInt(a.z1, -3e7, 3e7, 0), clampInt(a.z2, -3e7, 3e7, 0)
    local y1, y2 = clampInt(a.yTop, -64, 320, 0), clampInt(a.yBottom, -64, 320, 0)
    args = {
      kind = a.kind, x1 = math.min(x1, x2), x2 = math.max(x1, x2), z1 = math.min(z1, z2), z2 = math.max(z1, z2),
      yTop = math.max(y1, y2), yBottom = math.min(y1, y2),
    }
  else
    error("Unknown fleet job " .. tostring(a.kind), 0)
  end
  if miningRoute and args.kind ~= "branchMine" then error("This row miner uses its saved staircase. Start a south-row level job.", 0) end
  fleetJob = { kind = args.kind, args = args, step = 0, phase = "work" }
  if type(a.queueId) == "string" and #a.queueId <= 96 then fleetJob.queueId = a.queueId end
  saveState()
  log("info", "Starting fleet job: " .. args.kind)
  fleetWork()
end

function jobs.resume()
  if not fleetJob then error("No fleet job to resume", 0) end
  fleetJob.paused, fleetJob.failed = nil, nil
  saveState()
  fleetWork()
end

-- Cancel without losing the independent home, bottom, or opened vein exit.
function jobs.goHome()
  setDetail("Returning home")
  if miningRoute then
    miningRoute.intent = "home"
    if fleetJob then
      lastFleetResult = { id = fleetJob.queueId, ok = false, msg = "Cancelled; returning by saved staircase", jobId = fleetJob.args.jobId, ores = fleetJob.ores }
    end
    fleetJob, pendingTrip = nil, nil
    rowRoute.save()
    rowRoute.recover()
    return
  end
  if pendingTrip then
    local trip = pendingTrip
    pendingTrip = nil
    trip.toBase()
    if emptySlots() < 16 then unloadAt(trip, false) end
  end
  if fleetJob then
    local k, a = kindOf(fleetJob), fleetJob.args
    lastFleetResult = { id = fleetJob.queueId, ok = false, msg = "Cancelled; returning home", jobId = fleetJob.args.jobId, ores = fleetJob.ores }
    fleetJob = nil
    saveState()
    -- Drop off what it mined (and refuel) on the way home.
    if k and depotReady() and emptySlots() < 16 then
      leaveWork(k, a)
      depotVisit(0)
    end
  end
  comeHome()
end

-- Force Home can mine only at the saved safe Y. The ascent and surface
-- portion have the same restrictions as every other saved-stair return.
function jobs.forceHome()
  if not miningRoute then error("No saved south staircase. Line up at Y 67, Z -55 and start a new row job first.", 0) end
  jobs.goHome()
end

function jobs.recoverRoute() rowRoute.recover() end

-- Manual actions (run when no job is active) ------------------------------------
-- Each returns ok[, message] like the turtle API does.

local actions = {}

local function guardedDig(dir)
  local found, block = SIDES[dir].inspect()
  if not found then return false, "Nothing to dig here" end
  local reason = protection(dir, block)
  if reason then return false, "Won't dig: " .. reason end
  local ok, err = SIDES[dir].dig()
  if ok then noteDug(dir, block.name) end
  return ok, err
end

local function guardedPlace(dir, place)
  local reason = protection(dir, nil)
  if reason then return false, "Won't place: " .. reason end
  return place()
end

for _, dir in ipairs({ "forward", "up", "down" }) do
  actions[dir] = function(a)
    if a.dig then
      digMove(dir)
      return true
    end
    return move(dir, true)
  end
end
actions.back = function() return move("back", true) end
actions.turnLeft = function() return turn(false) end
actions.turnRight = function() return turn(true) end
actions.dig = function() return guardedDig("forward") end
actions.digUp = function() return guardedDig("up") end
actions.digDown = function() return guardedDig("down") end
actions.place = function() return guardedPlace("forward", turtle.place) end
actions.placeUp = function() return guardedPlace("up", turtle.placeUp) end
actions.placeDown = function() return guardedPlace("down", turtle.placeDown) end
actions.select = function(a) return turtle.select(clampInt(a.slot, 1, 16, 1)) end

actions.refuel = function()
  if turtle.getFuelLevel() == "unlimited" then return true, "Fuel is unlimited on this server" end
  local before = turtle.getFuelLevel()
  if not turtle.refuel() then return false, "Selected slot isn't fuel" end
  return true, ("+%d fuel"):format(turtle.getFuelLevel() - before)
end

actions.drop = function() return turtle.drop() end

actions.dropAll = function()
  local selected = turtle.getSelectedSlot()
  for slot = 1, 16 do
    if turtle.getItemCount(slot) > 0 then
      turtle.select(slot)
      turtle.drop()
    end
  end
  turtle.select(selected)
  return true
end

-- Home is set once on first run; this moves it, either to the current spot or
-- to world coordinates (x, y, z and a facing).
actions.setHome = function(a)
  if miningRoute then return false, "The mining home is saved permanently with its staircase" end
  if a.x ~= nil then
    if not gpsTrusted() then return false, "Needs GPS to set home by coordinates" end
    local w = { x = clampInt(a.x, -3e7, 3e7, 0), y = clampInt(a.y, -64, 320, 64), z = clampInt(a.z, -3e7, 3e7, 0) }
    home = fromWorld(w)
    home.heading = (toCompass(a.facing or "north") - calib.f0) % 4
    forgetVisited()
    remember(pos)
    saveState()
    changed()
    return true, ("Home set to %d, %d, %d"):format(w.x, w.y, w.z)
  end
  setHome()
  local w = toWorld(home) or home
  return true, ("Home set to %d, %d, %d"):format(w.x, w.y, w.z)
end

actions.resetPosition = function()
  if miningRoute then return false, "The saved mining route requires its existing GPS coordinate frame" end
  pos, heading, calib = { x = 0, y = 0, z = 0 }, 0, nil
  blocked, blockedCount = {}, 0
  forgetVisited()
  setHome()
  return true, "Position reset to 0, 0, 0"
end

actions.update = installUpdate

actions.forgetJob = function()
  fleetJob = nil
  saveState()
  return true, "Fleet job cleared"
end

-- Worker ------------------------------------------------------------------------

local function blockName(inspect)
  local ok, block = inspect()
  return ok and block.name or nil
end

local function refreshSurroundings()
  around = {
    front = blockName(turtle.inspect),
    up = blockName(turtle.inspectUp),
    down = blockName(turtle.inspectDown),
  }
  changed()
end

local function runCommand(cmd)
  local name = cmd.action
  local a = type(cmd.args) == "table" and cmd.args or {}
  local queueId = name == "fleetJob" and a.queueId or (name == "resume" and fleetJob and fleetJob.queueId)
  local isJob = jobs[name] ~= nil
  local fn = jobs[name] or actions[name]
  if not fn then
    send({ type = "result", action = tostring(name), ok = false, msg = "Unknown action" })
    return
  end
  if miningRoute and (name == "tunnel" or name == "quarry") then
    send({ type = "result", action = name, ok = false, msg = "This turtle uses its saved south staircase. Start a level mining job." })
    return
  end

  stopRequested, pauseRequested = false, false
  if isJob then
    if name ~= "goHome" and name ~= "forceHome" then pendingTrip = nil end
    job = { name = name, detail = "Starting", progress = 0 }
    around = nil
    changed()
  end

  local ok, res, msg = pcall(fn, a)
  travelNext = nil
  local success = ok and res ~= false
  if not ok then msg = res == STOP and "Cancelled" or tostring(res) end
  local resumableStop = res == STOP and fleetJob and fleetJob.queueId == queueId and fleetJob.paused and not fleetJob.failed
  if queueId and not success and not resumableStop then
    lastFleetResult = { id = queueId, ok = false, msg = tostring(msg or "Failed") }
    saveState()
  end

  if isJob then
    job = nil
    log(success and "info" or res == STOP and "warn" or "error", name .. ": " .. (success and "done" or msg))
  else
    if not success then say("error", name .. ": " .. tostring(msg or "failed")) end
    send({ type = "result", action = name, ok = success, msg = msg })
  end
  refreshSurroundings()
end

-- An idle turtle burns fuel from its own inventory before it runs dry.
function net.idleRefuel()
  if fuelLevel() < 1000 then refuelFromInventory(2000) end
end

function net.worker()
  while true do
    local timer = os.startTimer(20)
    while #queue == 0 do
      local event, id = os.pullEvent()
      if event == "timer" and id == timer then
        net.idleRefuel()
        timer = os.startTimer(20)
      end
    end
    runCommand(table.remove(queue, 1))
    changed()
    -- An update asked for during a job that ended before its next step.
    if updateRequested and #queue == 0 then
      updateRequested = false
      runCommand({ action = "update" })
    end
  end
end

-- Connection --------------------------------------------------------------------

function net.status()
  local inventory = {}
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item then inventory[#inventory + 1] = { slot = slot, name = item.name, count = item.count } end
  end
  local fj
  if fleetJob then
    local k = kindOf(fleetJob)
    fj = {
      kind = fleetJob.kind, step = fleetJob.step, total = k and k.total(fleetJob.args),
      paused = fleetJob.paused, failed = fleetJob.failed, args = fleetJob.args, found = fleetJob.found, ores = fleetJob.ores,
      at = k and k.at and k.at(fleetJob.args, fleetJob.step), sharing = fleetJob.nextArgs ~= nil,
      queueId = fleetJob.queueId,
    }
  end
  return {
    type = "status",
    label = os.getComputerLabel(),
    fuel = turtle.getFuelLevel(),
    fuelLimit = turtle.getFuelLimit(),
    pos = pos,
    heading = heading,
    home = home,
    world = worldPos(),
    homeWorld = toWorld(home),
    homeFacing = calib and calib.f0 and COMPASS[(calib.f0 + home.heading) % 4] or nil,
    facing = calib and calib.f0 and COMPASS[(calib.f0 + heading) % 4] or nil,
    gpsState = gpsState,
    gpsTrusted = gpsTrusted(),
    moving = travelNext ~= nil,
    next = travelNext and toWorld(travelNext) or nil,
    selected = turtle.getSelectedSlot(),
    inventory = inventory,
    job = job,
    fleetJob = fj,
    holding = leases.depot == "granted",
    fleetAt = fleet.updatedAt,
    around = around,
    queued = #queue,
    queueSupported = true,
    oreScanSupported = true,
    staircaseSupported = true,
    forceHomeSupported = true,
    southRowSupported = true,
    radiusSupported = true,
    staggeredSupported = true,
    midJobUpdateSupported = true,
    jobShareSupported = true,
    miningRoute = miningRoute and {
      home = miningRoute.home, bottom = miningRoute.bottom, targetY = miningRoute.targetY,
      radius = miningRoute.radius,
      bottomSaved = miningRoute.bottomSaved, stair = miningRoute.stair,
      phase = miningRoute.phase, intent = miningRoute.intent,
    } or nil,
    lastFleetResult = lastFleetResult,
  }
end

function net.handleMessage(msg)
  if msg.type == "error" then
    say("error", "Server: " .. tostring(msg.msg))
    if msg.fatal then authFailed = true end
  elseif msg.type == "welcome" then
    say("info", "Connected to dashboard")
  elseif msg.type == "fleet" then
    cfg.adoptFleet(msg.fleet)
  elseif msg.type == "traffic" then
    if gpsTrusted() then
      if trafficCount > 4000 then traffic, parked, homesNear, trafficCount = {}, {}, {}, 0 end
      local now = os.clock()
      -- Homes stay put, so they're remembered for longer.
      for list, cells in pairs({ [traffic] = msg.cells, [parked] = msg.parked, [homesNear] = msg.homes }) do
        local untilTime = now + (list == homesNear and 300 or 2.5)
        for _, w in ipairs(type(cells) == "table" and cells or {}) do
          local c = fromWorld(w)
          list[cellKey(c.x, c.y, c.z)] = untilTime
          trafficCount = trafficCount + 1
        end
      end
    end
  elseif msg.type == "lease" then
    if msg.granted then
      leases[msg.resource] = "granted"
      saveState()
      os.queueEvent("minerdash_lease")
    end
  elseif msg.type == "cmd" then
    local name = msg.action
    if name == "stop" then
      -- Halt in place. A fleet job stays paused and can be resumed.
      queue = {}
      stopRequested, pauseRequested = true, false
      changed()
    elseif name == "pause" then
      if job then
        pauseRequested = true
        changed()
      end
    elseif name == "resume" then
      if job then
        pauseRequested = false
        changed()
      elseif fleetJob and #queue == 0 then
        queue[1] = { action = "resume" } -- a fleet job paused before a reboot
        os.queueEvent("minerdash_cmd")
      end
    elseif name == "setLabel" then
      local label = type(msg.args) == "table" and tostring(msg.args.label or "") or ""
      os.setComputerLabel(label ~= "" and label:sub(1, 32) or nil)
      changed()
    elseif name == "jobUpdate" then
      -- A turtle joining this job takes some of its columns. The new
      -- settings are kept and switched to between two steps.
      local a = type(msg.args) == "table" and msg.args or {}
      local ok, res = pcall(function()
        local current = fleetJob and fleetJob.args
        if not (current and current.pattern == "staggered" and a.pattern == "staggered" and a.jobId ~= nil and a.jobId == current.jobId) then
          error("Not on that job", 0)
        end
        return rowRoute.jobArgs(a)
      end)
      if ok then
        fleetJob.nextArgs = res
        saveState()
      end
      send({ type = "result", action = name, ok = ok, msg = ok and "Sharing its columns from the next step" or tostring(res) })
    elseif name == "update" and job then
      -- Mid-job, update at the next safe point; the job resumes after the reboot.
      updateRequested = true
      send({ type = "result", action = name, ok = true, msg = "Updating at the next safe point, then carrying on" })
    elseif (name == "goHome" or name == "forceHome") and job then
      -- Cancel whatever is running; goHome then backs out of it and heads home.
      queue = { msg }
      stopRequested, pauseRequested = true, false
      os.queueEvent("minerdash_cmd")
    elseif job then
      send({ type = "result", action = name, ok = false, msg = "Busy with " .. job.name .. ". Pause or cancel it first." })
    elseif #queue >= 20 then
      send({ type = "result", action = name, ok = false, msg = "Too many queued commands" })
    else
      queue[#queue + 1] = msg
      os.queueEvent("minerdash_cmd")
    end
  end
end

function net.receiver(sock)
  while true do
    local ok, raw = pcall(sock.receive)
    if not ok or not raw then return end
    local msg = textutils.unserializeJSON(raw)
    if type(msg) == "table" then net.handleMessage(msg) end
  end
end

function net.hasWirelessModem()
  return peripheral.find("modem", function(_, m) return m.isWireless() end) ~= nil
end

-- Take a GPS fix every 30s to verify tracking, and after each move until the
-- compass direction is known. Runs whether or not the server is reachable.
function net.updateGps(fixPos)
  local before = gpsState
  if not net.hasWirelessModem() then
    gpsState = "none"
  else
    local x, y, z = gps.locate(1)
    gpsState = x and "ok" or "nofix"
    -- Ignore fixes that straddled a move.
    if x and not physicalMove and samePos(fixPos, pos) then
      net.onFix(fixPos, { x = math.floor(x + 0.5), y = math.floor(y + 0.5), z = math.floor(z + 0.5) })
    end
  end
  if gpsState ~= before then changed() end
end

function net.gpsLoop()
  local lastFix, fixPos = -math.huge, nil
  while true do
    local now = os.clock()
    if now - lastFix >= 30 or (not gpsTrusted() and not samePos(fixPos, pos) and now - lastFix >= 1) then
      lastFix = now
      fixPos = { x = pos.x, y = pos.y, z = pos.z }
      net.updateGps(fixPos)
      gpsChecked = true
    end
    sleep(0.5)
  end
end

-- Report dug blocks a batch at a time: a table of block names, and four
-- numbers per block (x, y, z and the name's index).
function net.sendDug()
  if #dugLog == 0 then return true end
  local count = math.min(#dugLog, 400)
  local names, index, flat = {}, {}, {}
  for i = 1, count do
    local d = dugLog[i]
    if not index[d[4]] then
      names[#names + 1] = d[4]
      index[d[4]] = #names - 1
    end
    flat[#flat + 1], flat[#flat + 2], flat[#flat + 3], flat[#flat + 4] = d[1], d[2], d[3], index[d[4]]
  end
  if not send({ type = "dug", names = names, blocks = flat }) then return false end
  local rest = {}
  for i = count + 1, #dugLog do rest[#rest + 1] = dugLog[i] end
  dugLog = rest
  return true
end

function net.heartbeat()
  local lastSent = -math.huge
  while true do
    local now = os.clock()
    if dirty or now - lastSent >= 5 then
      dirty = false
      lastSent = now
      if not send(net.status()) then return end
    end
    if not net.sendDug() then return end
    sleep(0.5)
  end
end

function net.connection()
  local delay = 2
  while true do
    say("info", "Connecting to " .. url)
    authFailed = false
    local sock, err = http.websocket(url)
    if sock then
      ws = sock
      send({
        type = "hello", token = token, id = os.getComputerID(), label = os.getComputerLabel(), version = VERSION,
        holding = leases.depot == "granted", fleet = (fleet.updatedAt or 0) > 0 and fleet or nil,
      })
      changed()
      parallel.waitForAny(function() net.receiver(sock) end, net.heartbeat)
      ws = nil
      pcall(sock.close)
      say("warn", "Disconnected")
      delay = 2
    else
      say("warn", "Can't connect: " .. tostring(err))
    end
    if authFailed then
      say("error", "Token rejected. Run '" .. shell.getRunningProgram() .. " setup' to change it.")
      delay = 60
    end
    sleep(delay)
    delay = math.min(delay * 2, 30)
  end
end

-- A turn at the dock survives a reboot only at the dock. Anywhere else it
-- would keep every other turtle waiting.
function net.dropStaleDockTurn()
  if leases.depot ~= "granted" then return end
  local w, D = worldPos(), fleet.depot
  if w and D and inDockRoom(D, w.x, w.y, w.z) then return end
  leases.depot = nil
  saveState()
end

-- Main --------------------------------------------------------------------------

term.clear()
term.setCursorPos(1, 1)
print(("MinerDash %s | turtle #%d %s"):format(VERSION, os.getComputerID(), os.getComputerLabel() or ""))
loadState()
cfg.loadFleet()
net.dropStaleDockTurn()
remember(pos)
refreshSurroundings()
-- A recall survives even if the assignment was already cleared. An old
-- branch layout stays paused until replaced; never guess a staircase for it.
if miningRoute and miningRoute.intent == "home" then
  queue[1] = { action = "recoverRoute" }
elseif fleetJob and fleetJob.kind == "branchMine" and (fleetJob.args.routeMode ~= "southRow" or not fleetJob.args.radius) then
  fleetJob.paused, fleetJob.failed = true, "Old mining layout: return to the saved home and create a new radius mining job"
  saveState()
elseif fleetJob and not fleetJob.paused and not fleetJob.failed then
  queue[1] = { action = "resume" }
elseif miningRoute and miningRoute.intent and not fleetJob then
  queue[1] = { action = "recoverRoute" }
end
parallel.waitForAny(net.connection, net.worker, net.gpsLoop)
