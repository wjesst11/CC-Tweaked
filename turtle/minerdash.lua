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
-- Each turtle has a permanent home: where it first ran this script, or wherever
-- it's set from the dashboard. Cancelling a job brings it back there.
--
-- Two kinds of jobs:
--  * Local jobs (quarry, tunnel) unload into a chest placed directly behind
--    the spot where the job started.
--  * Fleet jobs (branchMine, areaQuarry) work in world coordinates and share one
--    depot: a dock block with junk, valuables and fuel chests next to it. Each
--    turtle flies at its own height (its lane) and the server lets one turtle at
--    a time use the dock, so turtles never run into each other.
-- Protected blocks and areas are never dug or built in, by any job or command.

local VERSION = "1.2.0"
local DEFAULT_URL = "__WS_URL__"
local STATE_FILE = ".minerdash_state"
local FLEET_FILE = ".minerdash_fleet"
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
local pendingTrip -- way back out of a cancelled local job
local dirty = true
local around      -- block names next to the turtle (refreshed when idle)
local calib       -- GPS anchor { l = local pos, w = world pos, f0 = compass of heading 0 }
local gpsState = "none" -- "none" (no wireless modem), "nofix" or "ok"
local gpsChecked = false -- a GPS fix has been attempted since boot
local lane        -- this turtle's travel lane: blocks above the fleet travel height
local leases = {} -- resource -> "granted" | "waiting"
local fleetJob    -- { kind, args, step, phase, paused, failed } for the current fleet job

-- Shared fleet settings from the dashboard. These defaults apply until the
-- server sends its copy; the latest copy is kept on disk so protection still
-- works while offline.
local fleet = {
  updatedAt = 0,
  refuelTo = 10000,
  protect = { blocks = { "*chest*", "*barrel*", "*shulker_box*", "*hopper*", "create:*" }, areas = {} },
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
    lane, fleetJob = data.lane, data.fleetJob
    if data.holding then leases.depot = "granted" end
  end
end

local function saveState()
  local f = fs.open(STATE_FILE, "w")
  f.write(textutils.serialize({
    pos = pos, heading = heading, home = home, calib = calib,
    lane = lane, fleetJob = fleetJob, holding = leases.depot == "granted",
  }))
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
local function onFix(l, w)
  local savedHome = calib and calib.home
  if calib and calib.f0 then
    local slip = calib.slip
    if samePos(toWorld(l), w) then
      -- A matching fix after a sideways move confirms the heading as well.
      if slip and (l.x ~= slip.x or l.z ~= slip.z) then
        calib.slip = nil
        saveState()
        changed()
      end
      return
    end
    -- Don't keep digging on a position that might be wrong.
    if job then stopRequested = true end
    if not slip then
      -- First assume only the position slipped (e.g. the server stopped mid-move).
      pos = fromWorld(w)
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
  elseif calib and (l.x ~= calib.l.x or l.z ~= calib.l.z) then
    for f0 = 0, 3 do
      calib.f0 = f0
      if samePos(toWorld(l), w) then
        if savedHome then
          home = fromWorld(savedHome.w)
          home.heading = (savedHome.compass - f0) % 4
          calib.home = nil
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

local compiled = { protect = {}, valuables = {}, fuel = {}, vein = {} }

-- "*" is the only wildcard; everything else matches literally.
local function glob(pattern)
  local escaped = pattern:lower():gsub("[%^%$%(%)%%%.%[%]%+%-%?]", "%%%0")
  return "^" .. escaped:gsub("%*", ".*") .. "$"
end

local function compileList(list)
  local out = {}
  for _, p in ipairs(type(list) == "table" and list or {}) do
    if type(p) == "string" and p ~= "" then out[#out + 1] = glob(p) end
  end
  return out
end

local function compileFleet()
  local protect, items = fleet.protect or {}, fleet.items or {}
  compiled.protect = compileList(protect.blocks)
  compiled.valuables = compileList(items.valuables)
  compiled.fuel = compileList(items.fuel)
  compiled.vein = compileList(fleet.veinBlocks)
end

local function matches(name, patterns)
  name = name:lower()
  for _, p in ipairs(patterns) do
    if name:find(p) then return true end
  end
  return false
end

local function loadFleet()
  if fs.exists(FLEET_FILE) then
    local f = fs.open(FLEET_FILE, "r")
    local data = textutils.unserialize(f.readAll())
    f.close()
    if type(data) == "table" then fleet = data end
  end
  compileFleet()
end

local function adoptFleet(c)
  if type(c) ~= "table" or (tonumber(c.updatedAt) or 0) <= (fleet.updatedAt or 0) then return end
  fleet = c
  compileFleet()
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
  return { x = pos.x + DX[heading], y = pos.y, z = pos.z + DZ[heading] }
end

local function inBox(w, a)
  return w.x >= math.min(a.x1, a.x2) and w.x <= math.max(a.x1, a.x2)
    and w.y >= math.min(a.y1, a.y2) and w.y <= math.max(a.y1, a.y2)
    and w.z >= math.min(a.z1, a.z2) and w.z <= math.max(a.z1, a.z2)
end

-- Why the block on side `dir` (forward/up/down) must not be dug or built in, or
-- nil if it may. ComputerCraft blocks (turtles, GPS hosts) are always protected.
local function protection(dir, block)
  if block then
    local name = block.name:lower()
    if name:find("^computercraft:") or matches(name, compiled.protect) then
      return "protected block " .. block.name
    end
  end
  local areas = fleet.protect and fleet.protect.areas or {}
  if #areas == 0 then return nil end
  if not gpsTrusted() then return "GPS position unknown, so protected areas can't be checked" end
  local w = toWorld(neighbour(dir))
  for _, a in ipairs(areas) do
    if inBox(w, a) then return "protected area " .. tostring(a.name or "") end
  end
end

-- Movement ------------------------------------------------------------------

local SIDES = {
  forward = { move = turtle.forward, dig = turtle.dig, attack = turtle.attack, inspect = turtle.inspect },
  up = { move = turtle.up, dig = turtle.digUp, attack = turtle.attackUp, inspect = turtle.inspectUp },
  down = { move = turtle.down, dig = turtle.digDown, attack = turtle.attackDown, inspect = turtle.inspectDown },
  back = { move = turtle.back },
}

local function move(dir)
  local ok, err = SIDES[dir].move()
  if ok then
    if dir == "up" then
      pos.y = pos.y + 1
    elseif dir == "down" then
      pos.y = pos.y - 1
    else
      local s = dir == "back" and -1 or 1
      pos.x, pos.z = pos.x + DX[heading] * s, pos.z + DZ[heading] * s
    end
    saveState()
    changed()
  end
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
local function clear(dir)
  local side = SIDES[dir]
  for _ = 1, 64 do
    local found, block = side.inspect()
    if not found or LIQUIDS[block.name] then return true end
    if isTurtleBlock(block.name) then return false, "another turtle is in the way" end
    local reason = protection(dir, block)
    if reason then return false, reason end
    local ok, err = side.dig()
    -- "Nothing to dig here" means it's already gone (another turtle got it).
    if not ok and err ~= "Nothing to dig here" then return false, err end
    -- Let gravel/sand above us land so it gets dug on the next pass.
    if dir == "up" and (block.name:find("gravel") or block.name:find("sand") or block.name:find("powder")) then
      sleep(0.4)
    end
  end
  return false, "Too many falling blocks"
end

-- Move one block, digging or attacking whatever is in the way. Another turtle
-- in the way is only passing through, so wait for it rather than dig.
local function digMove(dir)
  local side = SIDES[dir]
  local waited = 0
  for _ = 1, 400 do
    checkStop()
    local ok, err = move(dir)
    if ok then return end
    if err == "Out of fuel" then error("Out of fuel", 0) end
    local found, block = side.inspect()
    if found and isTurtleBlock(block.name) then
      waited = waited + 1
      if waited > 120 then error("Blocked by another turtle for a minute", 0) end
      sleep(0.5)
    elseif found and not LIQUIDS[block.name] then
      local cleared, why = clear(dir)
      if not cleared and why ~= "another turtle is in the way" then
        error(("Can't dig %s: %s"):format(block.name, why or "unknown"), 0)
      end
    elseif not side.attack() then
      sleep(0.2) -- falling block or entity we can't hit; give it a moment
    end
  end
  error("Can't move " .. dir, 0)
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
local function refuelFromInventory(target)
  target = math.min(target, fuelLimit())
  if fuelLevel() >= target then return true end
  local selected = turtle.getSelectedSlot()
  for slot = 1, 16 do
    if fuelLevel() >= target then break end
    if turtle.getItemCount(slot) > 0 then
      turtle.select(slot)
      while fuelLevel() < target and turtle.refuel(1) do end
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

local function ensureFuel(trip)
  if refuelFromInventory(trip.cost() + 64) then return end
  local spot = here()
  log("warn", "Low on fuel, heading back to the start")
  setDetail("Low on fuel, heading back")
  trip.toBase()
  unload(trip.base, false)
  waitForFuel(trip.cost(spot) * 2 + 64)
  trip.back(spot)
end

local function ensureSpace(trip)
  if emptySlots() > 1 then return end
  local spot = here()
  setDetail("Inventory full, unloading")
  trip.toBase()
  unload(trip.base, true)
  waitForFuel(trip.cost(spot) * 2 + 64)
  trip.back(spot)
end

-- Head back and unload after a job. A cancelled job leaves its trip for
-- goHome, which backs out the same way before going home.
local function finishJob(trip, ok, err)
  if not ok and err == STOP then
    pendingTrip = trip
    error(STOP, 0)
  end
  setDetail("Returning to the start")
  trip.toBase()
  unload(trip.base, false)
  if not ok then error(err, 0) end
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

-- Fleet: lanes, the shared depot and fleet jobs ----------------------------------

local function laneY()
  if not fleet.travelY then error("Set the travel height on the dashboard first", 0) end
  if not lane then error("Waiting for the server to assign a travel lane", 0) end
  return fleet.travelY + lane
end

-- The dock is shared, so ask the server for a turn and wait for it.
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

-- Fly to a column: straight up or down to this turtle's lane, across, then
-- down to t.y if given. Lanes are unique per turtle, so flights never collide.
local function travelTo(t)
  goWorld({ y = laneY() }, "y")
  goWorld(t, "xz")
  if t.y then goWorld(t, "y") end
end

-- Turtles queue beside the depot column, each at its own height.
local function waitSpot()
  return { x = fleet.depot.x + 1, z = fleet.depot.z }
end

-- Fly home along this turtle's lane and settle facing the way home was set.
local function flyHome()
  setDetail("Flying home")
  travelTo(toWorld(home))
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

local function dockSide(side)
  if side == "up" then return "top" end
  if side == "down" then return "bottom" end
  faceCompass(COMPASS_INDEX[side])
  return "front"
end

local DROP = { top = turtle.dropUp, bottom = turtle.dropDown, front = turtle.drop }
local SUCK = { top = turtle.suckUp, bottom = turtle.suckDown, front = turtle.suck }

-- Only ever drop into a chest, never onto the ground.
local function dockDrop(side)
  local p = dockSide(side)
  return isInventory(p) and DROP[p]()
end

local function dockSuck(side)
  local p = dockSide(side)
  return isInventory(p) and SUCK[p]()
end

local function category(name)
  if matches(name, compiled.fuel) then return "fuel" end
  if matches(name, compiled.valuables) then return "valuables" end
  return "junk"
end

-- At the dock: sort the inventory into the three chests and top up fuel from
-- the fuel chest. Returns a description of anything the player needs to fix.
local function dockWork()
  local D = fleet.depot
  local target = math.min(tonumber(fleet.refuelTo) or 10000, fuelLimit())
  local full = {}
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item then
      turtle.select(slot)
      local cat = category(item.name)
      if cat == "fuel" then
        while fuelLevel() < target and turtle.refuel(1) do end
      end
      if turtle.getItemCount(slot) > 0 then
        dockDrop(D[cat])
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
    if dockSuck(D.fuel) then
      while fuelLevel() < target and turtle.refuel(1) do end
      if turtle.getItemCount(slot) > 0 then dockDrop(D.fuel) end
    end
    if fuelLevel() == before then
      outOfFuel = true
      break
    end
  end
  turtle.select(1)
  changed()
  local problems = {}
  for _, cat in ipairs({ "junk", "valuables", "fuel" }) do
    if full[cat] then problems[#problems + 1] = "the " .. cat .. " chest is full or missing" end
  end
  if outOfFuel then problems[#problems + 1] = "the fuel chest is empty" end
  return #problems > 0 and table.concat(problems, ", ") or nil
end

-- Unload and refuel at the shared depot. Turtles wait their turn beside the
-- depot column, each at its own height; only the turtle holding the dock uses
-- the column. Retries until the turtle has room and at least minFuel.
local function depotVisit(minFuel)
  local D = fleet.depot
  if not D then error("Set up the depot on the dashboard first", 0) end
  local spot = waitSpot()
  while true do
    setDetail("Heading to the depot")
    travelTo(spot)
    setDetail("Waiting for a turn at the depot")
    acquire("depot")
    local problem
    local ok, err = pcall(function()
      goWorld({ x = D.x }, "x")
      goWorld({ y = D.y }, "y")
      setDetail("Unloading at the depot")
      problem = dockWork()
    end)
    -- Whatever happened, get out of the column so the next turtle can use it.
    local stop = stopRequested
    stopRequested = false
    local left = pcall(function()
      goWorld({ y = laneY() }, "y")
      goWorld(spot, "x")
    end)
    stopRequested = stopRequested or stop
    if left then release("depot") end
    if not ok then error(err, 0) end
    if not left then error("Stuck in the depot column", 0) end
    checkStop()
    if problem then log("warn", "Depot: " .. problem) end
    if emptySlots() >= 4 and fuelLevel() >= minFuel then return end
    setDetail("Waiting: " .. (problem or "not enough fuel at the depot"))
    waitSeconds(30)
  end
end

local function isVein(block)
  return matches(block.name, compiled.vein)
end

-- Dig out a vein of ore starting at the block on side `dir`, then come back.
local function mineVein(dir, budget, depth)
  if budget.left <= 0 or depth > 10 then return end
  local found, block = SIDES[dir].inspect()
  if not (found and isVein(block)) or protection(dir, block) then return end
  budget.left = budget.left - 1
  local back = here()
  digMove(dir)
  mineVein("up", budget, depth + 1)
  mineVein("down", budget, depth + 1)
  for _ = 1, 4 do
    turn(true)
    mineVein("forward", budget, depth + 1)
  end
  goTo(back, "xyz")
  face(back.heading)
end

-- Fleet job kinds. Each walks a numbered sequence of steps in world
-- coordinates from an entry column, so it can stop for the depot (or a reboot)
-- at any step and pick up where it left off.
local KINDS = {}

-- One 2-high tunnel at level y, starting at x/z and heading `dir`, mining any
-- ore veins it finds in the floor and walls.
KINDS.branchMine = {
  total = function(a) return a.length end,
  entry = function(a) return { x = a.x, y = a.y, z = a.z } end,
  cell = function(a, i) return { x = a.x + i * CX[a.dir], y = a.y, z = a.z + i * CZ[a.dir] } end,
  -- On the tunnel itself. (Vein detours always return to the tunnel before a
  -- step ends, so between steps the turtle is on the line.)
  inside = function(a, w)
    local ex, ez = a.x + (a.length - 1) * CX[a.dir], a.z + (a.length - 1) * CZ[a.dir]
    return (w.y == a.y or w.y == a.y + 1)
      and w.x >= math.min(a.x, ex) and w.x <= math.max(a.x, ex)
      and w.z >= math.min(a.z, ez) and w.z <= math.max(a.z, ez)
  end,
  -- Back to tunnel level, onto the tunnel line, then along it.
  walk = function(a, t)
    local along = CX[a.dir] ~= 0 and "x" or "z"
    goWorld(t, "y")
    goWorld(t, along == "x" and "z" or "x")
    goWorld(t, along)
  end,
  work = function(a)
    faceCompass(a.dir)
    clear("up")
    if a.scan then
      local budget = { left = 32 }
      mineVein("down", budget, 0)
      turn(false)
      mineVein("forward", budget, 0)
      turn(true)
      turn(true)
      mineVein("forward", budget, 0)
      turn(false)
    end
  end,
  detail = function(a, i) return ("Tunnel at Y %d: %d of %d"):format(a.y, i, a.length) end,
}

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
  -- Up through dug layers to the top, then across the top layer to the entry.
  toEntry = function(a)
    goWorld({ y = a.yTop }, "y")
    goWorld({ x = a.x1, z = a.z1 }, "xz")
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

local function moveToStep(k, a, i)
  local w, e = toWorld(pos), k.entry(a)
  if not k.inside(a, w) then
    if w.x == e.x and w.z == e.z then
      goWorld(e, "y") -- already in this job's shaft
    else
      travelTo(e)
    end
  end
  k.walk(a, k.cell(a, i))
end

-- From anywhere in the job, back to the entry column and up to the lane.
local function leaveWork(k, a)
  local e = k.entry(a)
  if k.inside(a, toWorld(pos)) then
    if k.toEntry then k.toEntry(a) else k.walk(a, e) end
  end
  local w = toWorld(pos)
  if w.x == e.x and w.z == e.z then goWorld({ y = laneY() }, "y") end
end

-- Fuel to get from here to the depot and back again, with a margin.
local function roundTrip(k, a)
  local w, e, D = toWorld(pos), k.entry(a), fleet.depot
  local ly = laneY()
  local oneWay = math.abs(w.x - e.x) + math.abs(w.z - e.z) + math.abs(w.y - e.y)
    + math.abs(ly - e.y) + math.abs(e.x - D.x) + math.abs(e.z - D.z) + 2 * math.abs(ly - D.y) + 2
  return 2 * oneWay + 100
end

local function fleetWork()
  local k = KINDS[fleetJob.kind]
  if not k then error("Unknown fleet job " .. tostring(fleetJob.kind), 0) end
  if not fleet.depot then error("Set up the depot on the dashboard first", 0) end
  ensureCalibrated()
  laneY()
  local a = fleetJob.args
  local total = k.total(a)

  local function visit()
    local need = roundTrip(k, a)
    fleetJob.phase = "depot"
    saveState()
    leaveWork(k, a)
    depotVisit(need)
    fleetJob.phase = "work"
    saveState()
  end

  local ok, err = pcall(function()
    if fleetJob.phase == "depot" then visit() end
    while fleetJob.step < total do
      checkStop()
      local need = roundTrip(k, a)
      if emptySlots() <= 2 or fuelLevel() < need then
        refuelFromInventory(need + 200)
        if emptySlots() <= 2 or fuelLevel() < need then visit() end
      end
      moveToStep(k, a, fleetJob.step)
      k.work(a, fleetJob.step)
      fleetJob.step = fleetJob.step + 1
      saveState()
      setDetail(k.detail(a, fleetJob.step), fleetJob.step / total)
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
      fleetJob.failed = tostring(err)
    end
    saveState()
    error(err, 0)
  end
  setDetail("Job done, unloading")
  visit()
  fleetJob = nil
  saveState()
  flyHome()
end

local function toCompass(v)
  return type(v) == "string" and COMPASS_INDEX[v] or clampInt(v, 0, 3, 0)
end

function jobs.fleetJob(a)
  local args
  if a.kind == "branchMine" then
    args = {
      kind = a.kind, x = clampInt(a.x, -3e7, 3e7, 0), z = clampInt(a.z, -3e7, 3e7, 0),
      y = clampInt(a.y, -64, 320, -58), dir = toCompass(a.dir),
      length = clampInt(a.length, 1, 1024, 64), scan = a.scan ~= false,
    }
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
  fleetJob = { kind = args.kind, args = args, step = 0, phase = "work" }
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

-- Cancel and come home. A cancelled job backs out the way it came in first:
-- a local job through its own dug corridor, a fleet job up its shaft to its lane.
function jobs.goHome()
  setDetail("Returning home")
  if pendingTrip then
    local trip = pendingTrip
    pendingTrip = nil
    trip.toBase()
    unload(trip.base, false)
  end
  if fleetJob then
    ensureCalibrated()
    local k = KINDS[fleetJob.kind]
    if k and fleet.travelY and lane then leaveWork(k, fleetJob.args) end
    fleetJob = nil
    saveState()
  end
  if fleet.travelY and lane and gpsTrusted() then
    flyHome()
  else
    goTo(home, "xzy")
    face(home.heading)
  end
end

-- Manual actions (run when no job is active) ------------------------------------
-- Each returns ok[, message] like the turtle API does.

local actions = {}

local function guardedDig(dir)
  local found, block = SIDES[dir].inspect()
  if not found then return false, "Nothing to dig here" end
  local reason = protection(dir, block)
  if reason then return false, "Won't dig: " .. reason end
  return SIDES[dir].dig()
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
    return move(dir)
  end
end
actions.back = function() return move("back") end
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
  if a.x ~= nil then
    if not gpsTrusted() then return false, "Needs GPS to set home by coordinates" end
    local w = { x = clampInt(a.x, -3e7, 3e7, 0), y = clampInt(a.y, -64, 320, 64), z = clampInt(a.z, -3e7, 3e7, 0) }
    home = fromWorld(w)
    home.heading = (toCompass(a.facing or "north") - calib.f0) % 4
    saveState()
    changed()
    return true, ("Home set to %d, %d, %d"):format(w.x, w.y, w.z)
  end
  setHome()
  local w = toWorld(home) or home
  return true, ("Home set to %d, %d, %d"):format(w.x, w.y, w.z)
end

actions.resetPosition = function()
  pos, heading, calib = { x = 0, y = 0, z = 0 }, 0, nil
  setHome()
  return true, "Position reset to 0, 0, 0"
end

actions.update = function()
  local base = (url:gsub("^ws", "http"):gsub("/ws/turtle$", ""))
  local res, err = http.get(base .. "/turtle.lua")
  if not res then return false, "Download failed: " .. tostring(err) end
  local code = res.readAll()
  res.close()
  if not (code and code:find("MinerDash", 1, true) and load(code, "minerdash")) then
    return false, "Downloaded script is invalid"
  end
  local f = fs.open(shell.getRunningProgram(), "w")
  f.write(code)
  f.close()
  log("info", "Updated, rebooting")
  sleep(0.5)
  os.reboot()
end

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
  local isJob = jobs[name] ~= nil
  local fn = jobs[name] or actions[name]
  if not fn then
    send({ type = "result", action = tostring(name), ok = false, msg = "Unknown action" })
    return
  end

  stopRequested, pauseRequested = false, false
  if isJob then
    if name ~= "goHome" then pendingTrip = nil end
    job = { name = name, detail = "Starting", progress = 0 }
    around = nil
    changed()
  end

  local ok, res, msg = pcall(fn, a)
  local success = ok and res ~= false
  if not ok then msg = res == STOP and "Cancelled" or tostring(res) end

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
local function idleRefuel()
  if fuelLevel() < 1000 then refuelFromInventory(2000) end
end

local function worker()
  while true do
    local timer = os.startTimer(20)
    while #queue == 0 do
      local event, id = os.pullEvent()
      if event == "timer" and id == timer then
        idleRefuel()
        timer = os.startTimer(20)
      end
    end
    runCommand(table.remove(queue, 1))
    changed()
  end
end

-- Connection --------------------------------------------------------------------

local function status()
  local inventory = {}
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item then inventory[#inventory + 1] = { slot = slot, name = item.name, count = item.count } end
  end
  local fj
  if fleetJob then
    local k = KINDS[fleetJob.kind]
    fj = {
      kind = fleetJob.kind, step = fleetJob.step, total = k and k.total(fleetJob.args),
      paused = fleetJob.paused, failed = fleetJob.failed, args = fleetJob.args,
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
    selected = turtle.getSelectedSlot(),
    inventory = inventory,
    job = job,
    fleetJob = fj,
    lane = lane,
    holding = leases.depot == "granted",
    fleetAt = fleet.updatedAt,
    around = around,
    queued = #queue,
  }
end

local function handleMessage(msg)
  if msg.type == "error" then
    say("error", "Server: " .. tostring(msg.msg))
    if msg.fatal then authFailed = true end
  elseif msg.type == "welcome" then
    say("info", "Connected to dashboard")
  elseif msg.type == "fleet" then
    adoptFleet(msg.fleet)
  elseif msg.type == "lane" then
    lane = tonumber(msg.lane)
    saveState()
    changed()
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
    elseif name == "goHome" and job then
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

local function receiver(sock)
  while true do
    local ok, raw = pcall(sock.receive)
    if not ok or not raw then return end
    local msg = textutils.unserializeJSON(raw)
    if type(msg) == "table" then handleMessage(msg) end
  end
end

local function hasWirelessModem()
  return peripheral.find("modem", function(_, m) return m.isWireless() end) ~= nil
end

-- Take a GPS fix every 30s to verify tracking, and after each move until the
-- compass direction is known. Runs whether or not the server is reachable.
local function updateGps(fixPos)
  local before = gpsState
  if not hasWirelessModem() then
    gpsState = "none"
  else
    local x, y, z = gps.locate(1)
    gpsState = x and "ok" or "nofix"
    -- Ignore fixes that straddled a move.
    if x and samePos(fixPos, pos) then
      onFix(fixPos, { x = math.floor(x + 0.5), y = math.floor(y + 0.5), z = math.floor(z + 0.5) })
    end
  end
  if gpsState ~= before then changed() end
end

local function gpsLoop()
  local lastFix, fixPos = -math.huge, nil
  while true do
    local now = os.clock()
    if now - lastFix >= 30 or (not gpsTrusted() and not samePos(fixPos, pos) and now - lastFix >= 1) then
      lastFix = now
      fixPos = { x = pos.x, y = pos.y, z = pos.z }
      updateGps(fixPos)
      gpsChecked = true
    end
    sleep(0.5)
  end
end

local function heartbeat()
  local lastSent = -math.huge
  while true do
    local now = os.clock()
    if dirty or now - lastSent >= 5 then
      dirty = false
      lastSent = now
      if not send(status()) then return end
    end
    sleep(0.5)
  end
end

local function connection()
  local delay = 2
  while true do
    say("info", "Connecting to " .. url)
    authFailed = false
    local sock, err = http.websocket(url)
    if sock then
      ws = sock
      send({
        type = "hello", token = token, id = os.getComputerID(), label = os.getComputerLabel(), version = VERSION,
        lane = lane, holding = leases.depot == "granted", fleet = (fleet.updatedAt or 0) > 0 and fleet or nil,
      })
      changed()
      parallel.waitForAny(function() receiver(sock) end, heartbeat)
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

-- Main --------------------------------------------------------------------------

term.clear()
term.setCursorPos(1, 1)
print(("MinerDash %s | turtle #%d %s"):format(VERSION, os.getComputerID(), os.getComputerLabel() or ""))
loadState()
loadFleet()
refreshSurroundings()
-- Pick an interrupted fleet job back up after a reboot or chunk reload.
if fleetJob and not fleetJob.paused and not fleetJob.failed then
  queue[1] = { action = "resume" }
end
parallel.waitForAny(connection, worker, gpsLoop)
