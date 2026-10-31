-- Shared in-memory CC:Tweaked world loading the real turtle implementation.
-- Tests run from the repository root.
local input = assert(io.open("turtle/minerdash.lua", "r"))
local source = input:read("*a")
input:close()
source = assert(source:match("^(.-)%-%- Main %-%-")) .. [[
return {
  init = function() loadState(); loadFleet(); remember(pos) end,
  move = move, face = face, step = stepTo,
  returnHome = function() navigate(cellGoal(home)); face(home.heading) end,
  jobs = jobs, actions = actions, row = rowRoute,
  fix = function(l, w) gpsChecked = true; gpsState = "ok"; return onFix(l, w) end,
  state = function() return { pos = here(), home = home, world = worldPos(), miningRoute = miningRoute, fleetJob = fleetJob, lastFleetResult = lastFleetResult } end,
  protection = function(areas) fleet.protect.areas = areas; gpsChecked = true; compileFleet() end,
  depot = function(value) fleet.depot = value end,
  config = function(value) fleet = value; compileFleet() end,
  save = saveState,
  lease = function(value) leases.depot = value end,
  depotVisit = function(minFuel) return depotVisit(minFuel) end,
  dockWork = function(minFuel) return dockWork(minFuel) end,
  recover = function(...) return rowRoute.recover(...) end,
  status = status,
  command = runCommand,
  message = handleMessage,
  kinds = KINDS,
  scan = function(args, veins)
    veins.allowed = function(w) return KINDS.branchMine.mayDig(args, w) end
    return KINDS.branchMine.work(args, 0, veins)
  end,
  plan = function(target, allowed)
    local goal = cellGoal(target)
    goal.allowed = allowed
    goal.bounds = { lo = {x=-6,y=0,z=-6}, hi = {x=6,y=0,z=6} }
    return findPath(goal)
  end,
}
]]

local function key(p) return p.x .. "," .. p.y .. "," .. p.z end
-- The strictest CC:Tweaked serializer: versions without allow_repetitions
-- ignore that option and reject any table that appears twice.
local function serialize(value)
  local seen, active = {}, {}
  local function encode(v)
    if type(v) ~= "table" then
      if type(v) == "string" then return string.format("%q", v) end
      if type(v) == "number" or type(v) == "boolean" or type(v) == "nil" then return tostring(v) end
      error("Cannot serialize type " .. type(v), 0)
    end
    if active[v] then error("Cannot serialize table with recursive entries", 0) end
    if seen[v] then error("Cannot serialize table with repeated entries", 0) end
    seen[v], active[v] = true, true
    local parts = {}
    for k, item in pairs(v) do parts[#parts + 1] = "[" .. encode(k) .. "]=" .. encode(item) end
    active[v] = nil
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return encode(value)
end

local function miner(files, initial)
  files = files or {}
  local sim = {
    pos = {x=0,y=0,z=0}, heading = 0, moves = 0, turns = 0, digs = 0,
    blocks = {}, time = 0, history = {}, slots = {}, items = {}, inspected = {},
    fuel = 100000, fuelLimit = 100000, selected = 1, chests = {}, deposits = {}, fullChests = {}, prints = {}, refuse = {},
  }
  local dx, dz = {[0]=0,1,0,-1}, {[0]=1,0,-1,0}
  local function nextCell(direction)
    local p = sim.pos
    if direction == "up" then return {x=p.x,y=p.y+1,z=p.z} end
    if direction == "down" then return {x=p.x,y=p.y-1,z=p.z} end
    local sign = direction == "back" and -1 or 1
    return {x=p.x+sign*dx[sim.heading],y=p.y,z=p.z+sign*dz[sim.heading]}
  end
  local function move(direction)
    local target = nextCell(direction)
    if sim.beforeMove then sim.beforeMove(target,direction) end
    if sim.blocks[key(target)] then return false, "Movement obstructed" end
    sim.pos, sim.moves = target, sim.moves+1
    sim.history[#sim.history+1] = {dir=direction,x=target.x,y=target.y,z=target.z}
    if sim.afterPhysicalMove then sim.afterPhysicalMove(target,direction) end
    return true
  end
  local function inspect(direction)
    local target = key(nextCell(direction))
    sim.inspected[target] = true
    local name = sim.blocks[target]
    return name ~= nil, name and {name=name} or nil
  end
  local function dig(direction)
    local target = key(nextCell(direction))
    if not sim.blocks[target] then return false end
    -- Blocks the game refuses to break, such as under spawn protection.
    if sim.refuse[target] then return false, sim.refuse[target] end
    sim.blocks[target], sim.digs = nil, sim.digs+1
    return true
  end
  local function inventory(direction)
    local cell = key(nextCell(direction))
    local block = sim.blocks[cell] or ""
    return (block:find("chest") or block:find("barrel") or block:find("shulker")) and cell or nil
  end
  local function drop(direction)
    local cell = inventory(direction)
    local slot = sim.selected
    if not cell or sim.fullChests[cell] or (sim.slots[slot] or 0) == 0 then return false end
    local name = sim.items[slot] or "minecraft:cobblestone"
    sim.deposits[cell] = sim.deposits[cell] or {}
    sim.deposits[cell][name] = (sim.deposits[cell][name] or 0) + sim.slots[slot]
    sim.slots[slot], sim.items[slot] = nil, nil
    return true
  end
  local function suck(direction, count)
    local cell = inventory(direction)
    local supply = cell and sim.chests[cell]
    local slot = sim.selected
    if not supply or supply.count <= 0 or (sim.items[slot] and sim.items[slot] ~= supply.name) then return false end
    local amount = math.min(count or 64, supply.count, 64 - (sim.slots[slot] or 0))
    sim.slots[slot], sim.items[slot] = (sim.slots[slot] or 0) + amount, supply.name
    supply.count = supply.count - amount
    return amount > 0
  end
  local turtle = {
    getFuelLevel=function() return sim.fuel end, getFuelLimit=function() return sim.fuelLimit end,
    getItemDetail=function(slot)
      slot = slot or sim.selected
      if sim.items[slot] and (sim.slots[slot] or 0) > 0 then return {name=sim.items[slot],count=sim.slots[slot]} end
    end,
    getItemCount=function(slot) return sim.slots[slot or sim.selected] or 0 end,
    getSelectedSlot=function() return sim.selected end,
    select=function(slot) sim.selected=slot; return true end,
    refuel=function(count)
      local slot = sim.selected
      local power = ({["minecraft:coal"]=80,["minecraft:charcoal"]=80,["minecraft:coal_block"]=800})[sim.items[slot]]
      if not power or (sim.slots[slot] or 0) == 0 then return false end
      if count == 0 then return true end
      local used = math.min(count or sim.slots[slot],sim.slots[slot])
      sim.slots[slot] = sim.slots[slot] - used
      sim.fuel = math.min(sim.fuelLimit,sim.fuel+used*power)
      return true
    end,
    getLabel=function() return "Test" end,
    turnRight=function() sim.heading=(sim.heading+1)%4; sim.turns=sim.turns+1; return true end,
    turnLeft=function() sim.heading=(sim.heading+3)%4; sim.turns=sim.turns+1; return true end,
    attack=function() return false end, attackUp=function() return false end, attackDown=function() return false end,
  }
  for _, dir in ipairs({"forward","back","up","down"}) do
    turtle[dir] = function() return move(dir) end
  end
  for _, pair in ipairs({{"forward",""},{"up","Up"},{"down","Down"}}) do
    local dir, suffix = pair[1], pair[2]
    turtle["inspect"..suffix] = function() return inspect(dir) end
    turtle["dig"..suffix] = function() return dig(dir) end
    turtle["drop"..suffix] = function() return drop(dir) end
    turtle["suck"..suffix] = function(count) return suck(dir,count) end
  end
  sim.turtle = turtle
  local env = setmetatable({
    turtle=turtle, http={websocket=function() end},
    peripheral={getType=function(side)
      local direction = side == "top" and "up" or side == "bottom" and "down" or "forward"
      return inventory(direction) and "inventory" or nil
    end},
    settings={define=function() end,get=function(k) return k == "minerdash.url" and "ws://localhost/ws/turtle" or "test" end},
    textutils={serialize=serialize,unserialize=function(text) return assert(load("return "..text, "saved", "t", {}))() end},
    sleep=function(seconds)
      sim.time=sim.time+math.max(seconds,0.01)
      if sim.onSleep then sim.onSleep(seconds) end
    end,
    print=function(...)
      local parts={}
      for i=1,select("#",...) do parts[i]=tostring(select(i,...)) end
      sim.prints[#sim.prints+1]=table.concat(parts," ")
    end,
    term={isColor=function() return false end,setTextColor=function() end},
    colors={white=1,red=2,yellow=3},
    os=setmetatable({clock=function() return sim.time end,queueEvent=function() end,pullEvent=function() end,getComputerLabel=function() return "Test" end}, {__index=os}),
    fs={exists=function(name) return files[name] ~= nil end, open=function(name, mode)
      if mode == "r" and not files[name] then return nil, "missing file" end
      if mode == "w" then files[name] = "" end
      if mode == "a" and not files[name] then files[name] = "" end
      local cursor = 1
      return {
        write=function(s) files[name] = files[name] .. s end,
        writeLine=function(s) files[name] = files[name] .. s .. "\n" end,
        readAll=function() return files[name] end,
        readLine=function()
          if cursor > #files[name] then return nil end
          local finish = files[name]:find("\n", cursor, true)
          local line = files[name]:sub(cursor, finish and finish-1 or -1)
          cursor = finish and finish+1 or #files[name]+1
          return line
        end,
        close=function()
          if name == ".minerdash_state" and mode ~= "r" and sim.afterSave then sim.afterSave(files[name]) end
        end,
      }
    end},
  }, {__index=_G})
  local api = assert(load(source, "minerdash", "t", env))()
  api.init()
  local p = api.state().pos
  sim.pos, sim.heading = {x=p.x,y=p.y,z=p.z}, p.heading
  if initial then initial(api, sim) end
  return api, sim, files
end


local function same(a,b)
  assert(a and b and a.x==b.x and a.y==b.y and a.z==b.z,
    "positions differ: " .. (a and key(a) or "nil") .. " instead of " .. (b and key(b) or "nil"))
end
return {miner=miner,key=key,same=same,serialize=serialize}
