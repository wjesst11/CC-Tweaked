-- MinerDash turtle client for CC:Tweaked.
--
-- Install (in game):  wget https://<your-app>/turtle.lua startup.lua
-- Then run "startup" (or reboot). Run "startup setup" to change the URL or token.
--
-- Movement is tracked in local coordinates: x/y/z start at 0,0,0 where the
-- turtle first ran, and heading 0 is the direction it was facing then. With a
-- wireless/ender modem and a GPS network, the turtle also works out its world
-- coordinates and compass facing. Jobs set "home" to where they start and
-- unload into a chest placed directly behind home.

local VERSION = "1.1.1"
local DEFAULT_URL = "__WS_URL__"
local STATE_FILE = ".minerdash_state"
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
local job         -- { name, detail, progress } while a job runs
local stopRequested = false
local dirty = true
local around      -- block names next to the turtle (refreshed when idle)
local calib       -- GPS anchor { l = local pos, w = world pos, f0 = compass of heading 0 }
local gpsState = "none" -- "none" (no wireless modem), "nofix" or "ok"

local function loadState()
  if not fs.exists(STATE_FILE) then return end
  local f = fs.open(STATE_FILE, "r")
  local data = textutils.unserialize(f.readAll())
  f.close()
  if type(data) == "table" and data.pos then
    pos, heading, home, calib = data.pos, data.heading, data.home, data.calib
  end
end

local function saveState()
  local f = fs.open(STATE_FILE, "w")
  f.write(textutils.serialize({ pos = pos, heading = heading, home = home, calib = calib }))
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

local function checkStop()
  if stopRequested then error(STOP, 0) end
end

-- Sleep in short steps so a stop request is noticed quickly.
local function pause(seconds)
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
local CX = { [0] = 0, [1] = 1, [2] = 0, [3] = -1 } -- world X/Z step per compass direction
local CZ = { [0] = -1, [1] = 0, [2] = 1, [3] = 0 }

local function samePos(a, b)
  return a.x == b.x and a.y == b.y and a.z == b.z
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
      end
      return
    end
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

-- Movement ------------------------------------------------------------------

local SIDES = {
  forward = { move = turtle.forward, dig = turtle.dig, detect = turtle.detect, attack = turtle.attack, inspect = turtle.inspect },
  up = { move = turtle.up, dig = turtle.digUp, detect = turtle.detectUp, attack = turtle.attackUp, inspect = turtle.inspectUp },
  down = { move = turtle.down, dig = turtle.digDown, detect = turtle.detectDown, attack = turtle.attackDown, inspect = turtle.inspectDown },
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

-- Dig until the space is empty. Returns false (and a reason) if it can't be.
local function clear(dir)
  local side = SIDES[dir]
  for _ = 1, 64 do
    if not side.detect() then return true end
    local block
    if dir == "up" then block = select(2, side.inspect()) end
    local ok, err = side.dig()
    if not ok then return false, err end
    -- Let gravel/sand above us land so it gets dug on the next pass.
    if type(block) == "table" and (block.name:find("gravel") or block.name:find("sand") or block.name:find("powder")) then
      sleep(0.4)
    end
  end
  return false, "Too many falling blocks"
end

-- Move one block, digging or attacking whatever is in the way.
local function digMove(dir)
  local side = SIDES[dir]
  for _ = 1, 64 do
    checkStop()
    local ok, err = move(dir)
    if ok then return end
    if err == "Out of fuel" then error("Out of fuel", 0) end
    if side.detect() then
      local cleared, why = clear(dir)
      if not cleared then
        local _, block = side.inspect()
        local name = type(block) == "table" and block.name or "block"
        error(("Blocked by %s (%s)"):format(name, why or "can't dig"), 0)
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

-- Inventory & fuel ----------------------------------------------------------

local function fuelLevel()
  local fuel = turtle.getFuelLevel()
  return fuel == "unlimited" and math.huge or fuel
end

-- Burn fuel items from the inventory until fuel >= target. Returns success.
local function refuelFromInventory(target)
  local limit = turtle.getFuelLimit()
  target = math.min(target, limit == "unlimited" and math.huge or limit)
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
    pause(5)
  end
end

local function emptySlots()
  local n = 0
  for slot = 1, 16 do
    if turtle.getItemCount(slot) == 0 then n = n + 1 end
  end
  return n
end

local function isInventory(side)
  for _, t in ipairs({ peripheral.getType(side) }) do
    if t == "inventory" or t:find("chest") or t:find("barrel") or t:find("shulker") then return true end
  end
  return false
end

-- At home: drop everything into the chest behind, keeping one stack of fuel.
-- Without a chest it either waits for one or (needChest = false) skips unloading.
local function unload(needChest)
  face((home.heading + 2) % 4)
  if not needChest and not isInventory("front") then
    face(home.heading)
    return
  end
  local warned = false
  while not isInventory("front") do
    if not warned then log("warn", "No chest behind home. Place one to continue."); warned = true end
    setDetail("Waiting for a chest behind home")
    pause(5)
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
          pause(5)
        end
      end
    end
  end
  turtle.select(1)
  face(home.heading)
  changed()
end

-- A trip describes how a job travels between its work area and home:
-- horizontally at corridorY (a level it has already dug), then vertically.
local function newTrip(corridorY)
  local trip = {}
  function trip.cost(from)
    from = from or pos
    return math.abs(from.y - corridorY) + math.abs(from.x - home.x) + math.abs(from.z - home.z)
      + math.abs(corridorY - home.y)
  end
  function trip.home()
    goTo({ y = corridorY }, "y")
    goTo(home, "xz")
    goTo(home, "y")
    face(home.heading)
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
  log("warn", "Low on fuel, heading home")
  setDetail("Low on fuel, heading home")
  trip.home()
  unload(false)
  waitForFuel(trip.cost(spot) * 2 + 64)
  trip.back(spot)
end

local function ensureSpace(trip)
  if emptySlots() > 1 then return end
  local spot = here()
  setDetail("Inventory full, unloading")
  trip.home()
  unload(true)
  waitForFuel(trip.cost(spot) * 2 + 64)
  trip.back(spot)
end

-- Always head home and unload after a job, unless the user pressed stop.
local function finishJob(trip, ok, err)
  if not ok and err == STOP then error(STOP, 0) end
  setDetail("Returning home")
  trip.home()
  unload(false)
  if not ok then error(err, 0) end
end

-- Jobs (long-running, cancellable with "stop") ----------------------------------

local jobs = {}

function jobs.tunnel(a)
  local length = clampInt(a.length, 1, 1024, 32)
  local height = clampInt(a.height, 1, 3, 2)
  setHome()
  local forward = heading
  local trip = newTrip(home.y + (height == 3 and 1 or 0))
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
  setHome()
  local origin, f = here(), heading
  local r = (f + 1) % 4
  local trip = newTrip(origin.y - 1)
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

function jobs.goHome()
  setDetail("Returning home")
  goTo(home, "xzy")
  face(home.heading)
end

-- Manual actions (run when no job is active) ------------------------------------
-- Each returns ok[, message] like the turtle API does.

local actions = {}

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
actions.dig = function() return turtle.dig() end
actions.digUp = function() return turtle.digUp() end
actions.digDown = function() return turtle.digDown() end
actions.place = function() return turtle.place() end
actions.placeUp = function() return turtle.placeUp() end
actions.placeDown = function() return turtle.placeDown() end
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

actions.setHome = function()
  setHome()
  return true, ("Home set to %d, %d, %d"):format(pos.x, pos.y, pos.z)
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

  stopRequested = false
  if isJob then
    job = { name = name, detail = "Starting", progress = 0 }
    around = nil
    changed()
  end

  local ok, res, msg = pcall(fn, a)
  local success = ok and res ~= false
  if not ok then msg = res == STOP and "Stopped" or tostring(res) end

  if isJob then
    job = nil
    log(success and "info" or res == STOP and "warn" or "error", name .. ": " .. (success and "done" or msg))
  else
    if not success then say("error", name .. ": " .. tostring(msg or "failed")) end
    send({ type = "result", action = name, ok = success, msg = msg })
  end
  refreshSurroundings()
end

local function worker()
  while true do
    while #queue == 0 do os.pullEvent("minerdash_cmd") end
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
    facing = calib and calib.f0 and COMPASS[(calib.f0 + heading) % 4] or nil,
    gpsState = gpsState,
    selected = turtle.getSelectedSlot(),
    inventory = inventory,
    job = job,
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
  elseif msg.type == "cmd" then
    local name = msg.action
    if name == "stop" then
      queue = {}
      stopRequested = true
      changed()
    elseif name == "setLabel" then
      local label = type(msg.args) == "table" and tostring(msg.args.label or "") or ""
      os.setComputerLabel(label ~= "" and label:sub(1, 32) or nil)
      changed()
    elseif name == "goHome" and job then
      -- Going home preempts whatever job is running.
      queue = { msg }
      stopRequested = true
      os.queueEvent("minerdash_cmd")
    elseif job then
      send({ type = "result", action = name, ok = false, msg = "Busy with " .. job.name .. ". Stop it first." })
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
-- compass direction is known.
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

local function heartbeat()
  local lastSent, lastFix, fixPos = -math.huge, -math.huge, nil
  while true do
    local now = os.clock()
    local calibrating = not (calib and calib.f0) or calib.slip ~= nil
    if now - lastFix >= 30 or (calibrating and not samePos(fixPos, pos) and now - lastFix >= 1) then
      lastFix = now
      fixPos = { x = pos.x, y = pos.y, z = pos.z }
      updateGps(fixPos)
    end
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
      send({ type = "hello", token = token, id = os.getComputerID(), label = os.getComputerLabel(), version = VERSION })
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
refreshSurroundings()
parallel.waitForAny(connection, worker)
