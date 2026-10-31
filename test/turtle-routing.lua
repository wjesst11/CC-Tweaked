-- Exercise the real turtle code with a small in-memory CC:Tweaked world.
-- Run from the repository root: lua test/turtle-routing.lua
local input = assert(io.open("turtle/minerdash.lua", "r"))
local source = input:read("*a")
input:close()
source = assert(source:match("^(.-)%-%- Main %-%-")) .. [[
return {
  init = function() loadState(); loadFleet(); loadTrail(); remember(pos) end,
  move = move, face = face, step = stepTo, returnHome = comeHome,
  jobs = jobs, actions = actions, fix = onFix,
  state = function() return { pos = here(), home = home, size = trailSize, root = trailRoot, cells = trail, fleetJob = fleetJob, lastFleetResult = lastFleetResult } end,
  protection = function(areas) fleet.protect.areas = areas; gpsChecked = true; compileFleet() end,
  depot = function(value) fleet.depot = value end,
  kinds = KINDS,
  scan = function(args, veins)
    veins.allowed = function(w) return KINDS.branchMine.mayDig(args, w) end
    return KINDS.branchMine.work(args, 0, veins)
  end,
  limit = function(n) MAX_TRAIL = n end,
  plan = function(target, allowed)
    local goal = cellGoal(target)
    goal.allowed = allowed
    goal.bounds = { lo = {x=-6,y=0,z=-6}, hi = {x=6,y=0,z=6} }
    return findPath(goal)
  end,
}
]]

local function key(p) return p.x .. "," .. p.y .. "," .. p.z end
local function serialize(value)
  if type(value) ~= "table" then
    if type(value) == "string" then return string.format("%q", value) end
    return tostring(value)
  end
  local parts = {}
  for k, v in pairs(value) do parts[#parts + 1] = "[" .. serialize(k) .. "]=" .. serialize(v) end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function miner(files, initial)
  files = files or {}
  local sim = { pos = {x=0,y=0,z=0}, heading = 0, moves = 0, turns = 0, digs = 0, blocks = {}, time = 0, history = {}, slots = {}, inspected = {} }
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
    sim.blocks[target], sim.digs = nil, sim.digs+1
    return true
  end
  local turtle = {
    getFuelLevel=function() return 100000 end, getFuelLimit=function() return 100000 end,
    getItemDetail=function() end, getItemCount=function(slot) return sim.slots[slot] or 0 end,
    getSelectedSlot=function() return 1 end, select=function() return true end,
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
  end
  local env = setmetatable({
    turtle=turtle, http={websocket=function() end},
    settings={define=function() end,get=function(k) return k == "minerdash.url" and "ws://localhost/ws/turtle" or "test" end},
    textutils={serialize=serialize,unserialize=function(text) return assert(load("return "..text, "saved", "t", {}))() end},
    sleep=function(seconds) sim.time=sim.time+math.max(seconds,0.01) end,
    print=function() end,
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
        close=function() end,
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

local count = 0
local function test(name, fn)
  local ok, err = pcall(fn)
  assert(ok, name .. ": " .. tostring(err))
  count = count+1
  print("ok " .. count .. " - " .. name)
end
local function same(a,b) assert(a.x==b.x and a.y==b.y and a.z==b.z, "positions differ") end

test("a new job away from home preserves the complete home route", function()
  local api, sim, files = miner()
  api.face(1); api.move("forward"); api.move("forward")
  api.face(0); api.move("forward"); api.move("forward")
  local journal, before = files[".minerdash_route"], api.state()
  local ok, err = pcall(api.jobs.fleetJob, {kind="branchMine",x=2,z=2,y=0,dir="east",length=3})
  assert(not ok and tostring(err):find("depot"), "job should be saved before waiting for depot setup: " .. tostring(err))
  local after = api.state()
  same(after.home, {x=0,y=0,z=0}); same(after.root, {x=0,y=0,z=0})
  assert(after.size==before.size and after.cells["1,0,0"] and after.cells["2,0,2"])
  assert(files[".minerdash_route"]==journal, "job start rewrote the route")
  api.actions.forgetJob()
  assert(files[".minerdash_route"]==journal, "clearing a job rewrote the route")
end)

test("a reboot away from home restores old breadcrumbs and appends new travel", function()
  local api, sim, files = miner()
  api.face(1); api.move("forward"); api.move("forward")
  local journal = files[".minerdash_route"]
  local reboot, world = miner(files)
  assert(files[".minerdash_route"]==journal and reboot.state().size==3)
  same(reboot.state().root,{x=0,y=0,z=0})
  reboot.face(0); reboot.move("forward")
  assert(reboot.state().cells["0,0,0"] and reboot.state().cells["2,0,1"])
  reboot.returnHome(); same(world.pos,{x=0,y=0,z=0})
end)

test("home arrival clears only the completed route", function()
  local api, sim, files = miner()
  api.move("forward"); api.move("forward"); api.returnHome()
  assert(api.state().size==1 and api.state().cells["0,0,0"])
  assert(not files[".minerdash_route"]:find("0,0,2",1,true))
end)

test("a GPS position correction keeps the old route in the same coordinate frame", function()
  local api, sim, files = miner()
  api.fix({x=0,y=0,z=0},{x=100,y=64,z=100})
  api.move("forward")
  api.fix({x=0,y=0,z=1},{x=100,y=64,z=101})
  local journal = files[".minerdash_route"]
  api.fix({x=0,y=0,z=1},{x=100,y=64,z=102})
  local state = api.state()
  assert(state.cells["0,0,0"] and state.cells["0,0,1"] and state.cells["0,0,2"])
  assert(files[".minerdash_route"]:sub(1,#journal)==journal)
  same(state.home,{x=0,y=0,z=0})
end)

test("explicitly changing home starts a new home route", function()
  local api, sim, files = miner()
  api.move("forward"); api.move("forward")
  api.actions.setHome({})
  same(api.state().home,{x=0,y=0,z=2})
  assert(api.state().size==1 and api.state().cells["0,0,2"] and not api.state().cells["0,0,0"])
  assert(files[".minerdash_route"]:find("v1 0 0 2 0",1,true)==1)
end)

test("a full route refuses new travel without erasing the way home", function()
  local api, sim, files = miner()
  api.limit(3); api.move("forward"); api.move("forward")
  local journal, moves = files[".minerdash_route"], sim.moves
  local ok, err = pcall(api.move,"forward")
  assert(not ok and tostring(err):find("route memory full"))
  assert(sim.moves==moves and files[".minerdash_route"]==journal and api.state().size==3)
  api.returnHome(); same(sim.pos,{x=0,y=0,z=0})
end)

test("home uses an open shortcut instead of a U-shaped mining trail", function()
  local api, sim = miner()
  api.face(1); for i=1,3 do api.move("forward") end
  api.face(0); for i=1,3 do api.move("forward") end
  api.face(3); for i=1,3 do api.move("forward") end
  local moves = sim.moves
  api.returnHome()
  same(sim.pos,{x=0,y=0,z=0})
  assert(sim.moves-moves==3, "return followed the long trail")
  assert(sim.digs==0)
end)

test("returning down a straight corridor backs up without turning", function()
  local api, sim = miner()
  for i=1,5 do api.move("forward") end
  api.returnHome()
  same(sim.pos,{x=0,y=0,z=0})
  assert(sim.turns==0 and sim.moves==10)
end)

test("blocked shortcuts do not destroy the recorded route", function()
  local api, sim = miner()
  api.face(1); for i=1,3 do api.move("forward") end
  api.face(0); for i=1,3 do api.move("forward") end
  api.face(3); for i=1,3 do api.move("forward") end
  sim.blocks["0,0,2"]="minecraft:chest"
  api.returnHome(); same(sim.pos,{x=0,y=0,z=0})
  assert(sim.digs==0 and sim.blocks["0,0,2"]=="minecraft:chest")
end)

test("a blocked backward step inspects without digging a protected block", function()
  local api, sim = miner()
  api.move("forward")
  sim.blocks["0,0,0"]="minecraft:chest"
  local ok, why = api.step({x=0,y=0,z=0,h=0,back=true})
  assert(not ok and why=="block" and sim.digs==0)
end)

test("only fallen blocks in already visited cells can be cleared", function()
  local api, sim = miner()
  sim.blocks["0,0,-1"]="minecraft:sand"
  assert(not api.step({x=0,y=0,z=-1,h=0,back=true}))
  assert(sim.digs==0)
  api.face(0); api.move("forward")
  sim.blocks["0,0,0"]="minecraft:sand"
  assert(api.step({x=0,y=0,z=0,h=0,back=true}))
  assert(sim.digs==1)
end)

test("Force home mines ordinary obstacles and preserves the original home", function()
  local api, sim = miner()
  for i=1,3 do api.move("forward") end
  sim.blocks["0,0,1"], sim.blocks["0,0,2"] = "minecraft:stone", "minecraft:stone"
  api.jobs.forceHome()
  same(sim.pos,{x=0,y=0,z=0}); same(api.state().home,{x=0,y=0,z=0})
  assert(sim.digs==2 and sim.turns<=4)
end)

test("Force home detours around protected storage and ComputerCraft blocks", function()
  for _, block in ipairs({"minecraft:chest","computercraft:turtle_normal","create:gearbox"}) do
    local api, sim = miner()
    for i=1,3 do api.move("forward") end
    sim.blocks["0,0,1"] = block
    api.jobs.forceHome()
    same(sim.pos,{x=0,y=0,z=0})
    assert(sim.blocks["0,0,1"]==block and sim.digs==0, "dug "..block)
  end
end)

test("Force home refuses to mine in restricted areas", function()
  local api, sim = miner()
  api.fix({x=0,y=0,z=0},{x=100,y=64,z=100})
  api.move("forward")
  api.fix({x=0,y=0,z=1},{x=100,y=64,z=101})
  api.protection({{name="Home vault",x1=100,x2=100,y1=64,y2=64,z1=100,z2=100}})
  sim.blocks["0,0,0"]="minecraft:stone"
  local ok = pcall(api.jobs.forceHome)
  assert(not ok and sim.digs==0 and sim.blocks["0,0,0"]=="minecraft:stone")
end)

local function stairMiner()
  local api, sim, files = miner()
  api.fix({x=0,y=0,z=0},{x=0,y=0,z=0})
  api.move("forward"); api.fix({x=0,y=0,z=1},{x=0,y=0,z=1})
  api.move("back"); api.move("forward"); api.move("forward")
  local args = {kind="branchMine",x=0,z=5,y=-3,dir=2,entryY=0,access="stairs",length=8,band=0,spacing=3}
  for j=1,3 do
    sim.blocks["0,"..(-j)..","..(2+j)]="minecraft:stone"
    sim.blocks["0,"..(1-j)..","..(2+j)]="minecraft:stone"
  end
  return api, sim, files, args
end

test("mine access alternates forward and down with two-block clearance", function()
  local api, sim, files, args = stairMiner()
  sim.blocks["0,1,2"]="minecraft:stone"
  local first = #sim.history+1
  api.kinds.branchMine.enter(args)
  same(sim.pos,{x=0,y=-3,z=5})
  assert(sim.digs==7)
  for i=first,#sim.history do
    assert(sim.history[i].dir==((i-first)%2==0 and "forward" or "down"), "straight shaft instead of stairs")
  end
  local digs = sim.digs
  api.kinds.branchMine.exit(args)
  same(sim.pos,{x=0,y=0,z=2})
  assert(sim.digs==digs and api.state().cells["0,0,0"], "exit changed home route or dug new blocks")
end)

test("reboot between stair forward/down steps resumes at the saved stair cell", function()
  local api, sim, files, args = stairMiner()
  sim.blocks["0,0,3"]=nil
  api.move("forward")
  local reboot, after = miner(files)
  after.blocks = sim.blocks
  reboot.kinds.branchMine.enter(args)
  same(after.pos,{x=0,y=-3,z=5})
  assert(after.history[1].dir=="down" and after.moves==5)
  assert(reboot.state().cells["0,0,0"], "reboot overwrote home route")
end)

test("protected stair headroom stops before any descent", function()
  local api, sim, files, args = stairMiner()
  sim.blocks["0,1,2"]="minecraft:chest"
  local ok, err = pcall(api.kinds.branchMine.enter,args)
  assert(not ok and tostring(err):find("protected"))
  same(sim.pos,{x=0,y=0,z=2})
  assert(sim.digs==0 and sim.blocks["0,1,2"]=="minecraft:chest")
end)

test("a long stair descent can service inventory without replacing the home route", function()
  local api, sim, files, args = stairMiner()
  api.depot({x=20,y=0,z=0})
  for slot=1,14 do sim.slots[slot]=64 end
  local visits = 0
  api.kinds.branchMine.enter(args,function()
    visits = visits+1
    api.kinds.branchMine.exit(args)
    sim.slots = {}
  end)
  assert(visits==1 and api.state().cells["0,0,0"])
  same(sim.pos,{x=0,y=-3,z=5})
end)

local function scanMiner(length)
  local api, sim, files = miner()
  api.fix({x=0,y=0,z=0},{x=0,y=0,z=0})
  api.move("forward"); api.fix({x=0,y=0,z=1},{x=0,y=0,z=1})
  api.move("back")
  local args = {
    kind="branchMine",x=0,y=0,z=0,dir=2,length=length or 5,spacing=2,band=0,scan=true,coverage="allSides",
    veinBounds={x1=-1,x2=1,y1=-1,y2=2,z1=-1,z2=length or 5},
  }
  return api, sim, files, args
end

local function scanPass(api,args,resume,full)
  local veins={left=32,path={},resume=resume,full=full or function() return false end}
  local done=api.scan(args,veins)
  return done,veins.cut
end

test("all-side scans inspect every face at both tunnel heights and restore position/facing", function()
  local api,sim,files,args=scanMiner()
  api.face(1)
  local heading=sim.heading
  local done=scanPass(api,args)
  assert(done)
  for y=0,1 do
    for _,d in ipairs({{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}}) do
      assert(sim.inspected[d[1]..","..(y+d[2])..","..d[3]], "missed exposed face")
    end
  end
  same(sim.pos,{x=0,y=0,z=0})
  assert(sim.heading==heading)
end)

test("single-level scans collect isolated floor, ceiling, upper-wall and end-wall ores", function()
  local api,sim,files,args=scanMiner(1)
  local targets={"0,-1,0","0,2,0","1,1,0","-1,1,0","0,0,-1","0,1,1"}
  sim.blocks["0,1,0"]="minecraft:stone"
  for _,cell in ipairs(targets) do sim.blocks[cell]="minecraft:diamond_ore" end
  assert(scanPass(api,args))
  for _,cell in ipairs(targets) do assert(not sim.blocks[cell], "missed ore at "..cell) end
  same(sim.pos,{x=0,y=0,z=0})
end)

test("headroom ore is followed before it is cleared", function()
  local api,sim,files,args=scanMiner()
  sim.blocks["0,1,0"]="minecraft:diamond_ore"
  sim.blocks["1,1,0"]="minecraft:diamond_ore"
  assert(scanPass(api,args))
  assert(not sim.blocks["0,1,0"] and not sim.blocks["1,1,0"])
  same(sim.pos,{x=0,y=0,z=0})
end)

test("side scanning respects restricted areas and the neighboring turtle's slice", function()
  local api,sim,files,args=scanMiner()
  api.protection({{name="Protected ore",x1=-1,x2=-1,y1=1,y2=1,z1=0,z2=0}})
  sim.blocks["1,1,0"]="minecraft:diamond_ore" -- local +X is world -X
  sim.blocks["-1,1,0"]="minecraft:diamond_ore"
  args.veinBounds.x2=0 -- world +X belongs to the adjacent lane
  assert(scanPass(api,args))
  assert(sim.blocks["1,1,0"] and sim.blocks["-1,1,0"])
  assert(sim.inspected["1,1,0"] and sim.inspected["-1,1,0"])
end)

test("large ore veins continue across bounded passes instead of silently stopping at 32 blocks", function()
  local api,sim,files,args=scanMiner(60)
  for z=1,45 do sim.blocks["0,0,"..z]="minecraft:diamond_ore" end
  local resume,passes
  for pass=1,8 do
    local done,cut=scanPass(api,args,resume)
    passes=pass
    same(sim.pos,{x=0,y=0,z=0})
    if done then break end
    assert(cut,"unfinished scan lost its continuation")
    resume=cut
  end
  assert(passes>1 and passes<8)
  for z=1,45 do assert(not sim.blocks["0,0,"..z],"left ore past the per-pass cap") end
end)

test("a cut upper-level vein retains the upper step when resumed from the lower cell", function()
  local api,sim,files,args=scanMiner(60)
  for z=0,44 do sim.blocks["1,1,"..z]="minecraft:diamond_ore" end
  local done,resume=scanPass(api,args)
  assert(not done and resume and resume[1].y==1,"lost the upper scan origin")
  same(sim.pos,{x=0,y=0,z=0})
  for pass=1,8 do
    done,resume=scanPass(api,args,resume)
    same(sim.pos,{x=0,y=0,z=0})
    if done then break end
  end
  assert(done)
  for z=0,44 do assert(not sim.blocks["1,1,"..z],"missed resumed upper ore") end
end)

test("ore and upper-cell paths are checkpointed before physical movement", function()
  local api,sim,files,args=scanMiner()
  sim.blocks["0,0,1"]="minecraft:diamond_ore"
  local saved,checked={},{}
  local veins={left=32,path={},full=function() return false end}
  veins.checkpoint=function()
    saved={}
    for i,p in ipairs(veins.cut or veins.resume or veins.path) do saved[i]=p end
  end
  sim.beforeMove=function(target)
    local k=key(target)
    if (k=="0,0,1" or k=="0,1,0") and not checked[k] then
      assert(saved[#saved] and key(saved[#saved])==k,"movement could save an incomplete vein route")
      checked[k]=true
    end
  end
  assert(api.scan(args,veins))
  assert(checked["0,0,1"] and checked["0,1,0"])
end)

test("inventory cuts resume upper-wall ore without advancing or leaving the lower origin", function()
  local api,sim,files,args=scanMiner(15)
  for z=0,9 do sim.blocks["1,1,"..z]="minecraft:diamond_ore" end
  local done,resume=scanPass(api,args,nil,function() return sim.digs>=3 end)
  assert(not done and resume and resume[1].y==1)
  same(sim.pos,{x=0,y=0,z=0})
  done=scanPass(api,args,resume)
  assert(done)
  same(sim.pos,{x=0,y=0,z=0})
  for z=0,9 do assert(not sim.blocks["1,1,"..z]) end
end)

-- Independent breadth-first search over primitive turtle actions (including
-- turns without movement) checks that turn-aware A* returns optimal costs.
local function minimumActions(allowed, target, heading)
  local pending, seen = {{x=0,z=0,h=heading,cost=0}}, {}
  local front = 1
  local dx, dz = {[0]=0,1,0,-1}, {[0]=1,0,-1,0}
  while pending[front] do
    local cur = pending[front]; front=front+1
    local k = cur.x..","..cur.z..":"..cur.h
    if not seen[k] then
      seen[k] = true
      if cur.x==target.x and cur.z==target.z then return cur.cost end
      pending[#pending+1]={x=cur.x,z=cur.z,h=(cur.h+1)%4,cost=cur.cost+1}
      pending[#pending+1]={x=cur.x,z=cur.z,h=(cur.h+3)%4,cost=cur.cost+1}
      for _, sign in ipairs({1,-1}) do
        local x,z=cur.x+sign*dx[cur.h],cur.z+sign*dz[cur.h]
        if allowed(x,0,z) then pending[#pending+1]={x=x,z=z,h=cur.h,cost=cur.cost+1} end
      end
    end
  end
end

test("heading-aware routes match primitive-action optima through winding spaces", function()
  for seed=1,20 do
    local api, sim = miner()
    local heading=seed%4
    api.face(heading)
    local function allowed(x,y,z)
      if y~=0 or x<0 or x>4 or z<0 or z>4 then return false end
      return x==0 or z==4 or (x*11+z*7+seed*3)%5>1
    end
    local target={x=4,y=0,z=4}
    local route=assert(api.plan(target,allowed))
    assert(route[#route].cost==minimumActions(allowed,target,heading), "suboptimal route for seed "..seed)
    for i=2,#route do assert(api.step(route[i])) end
    same(sim.pos,target)
    assert(sim.digs==0)
  end
end)

print("Passed "..count.." turtle routing scenarios")
