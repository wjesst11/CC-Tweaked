-- Exercise the actual saved south-row route in a small CC:Tweaked world.
-- Run from the repository root: lua test/turtle-row-route.lua
local common = dofile("test/turtle-sim.lua")
local miner, key, same = common.miner, common.key, common.same

local count = 0
local function test(name, fn)
  local ok, err = pcall(fn)
  assert(ok, name .. ": " .. tostring(err))
  count = count + 1
  print("ok " .. count .. " - " .. name)
end

local function config()
  return {
    depot = {x=200,y=67,z=-60,junk="down",valuables="north",fuel="west"}, refuelTo=10000,
    protect = {blocks={"*chest*","*barrel*","create:*"},areas={}},
    items = {valuables={"*diamond*"},fuel={"minecraft:coal"}}, veinBlocks={"*_ore"},
  }
end

local function args(y, laneX)
  y = y or 62
  return {
    kind="branchMine",routeMode="southRow",access="southStairs",entryY=67,
    routeHome={x=100,y=67,z=-55,facing="south"},stairBottom={x=100,y=y,z=-55+67-y},
    x=laneX or 100,y=y,z=-55+67-y,dir="south",radius=32,length=8,spacing=2,band=0,scan=true,
  }
end

local function decoded(text)
  return assert(load("return " .. text, "saved test state", "t", {}))()
end

local function rowMiner(y, laneX)
  local api, sim, files = miner()
  local a, f = args(y, laneX), config()
  api.config(f)
  api.fix({x=0,y=0,z=0},{x=100,y=67,z=-55})
  for step=1,67-a.y do
    sim.blocks["0," .. (1-step) .. "," .. step] = "minecraft:stone"
    sim.blocks["0," .. (-step) .. "," .. step] = "minecraft:stone"
  end
  return api, sim, files, a, f
end

local function resume(files, physical, f)
  local saved=decoded(files[".minerdash_state"])
  local c=saved.calib
  local cx,cz={[0]=0,1,0,-1},{[0]=-1,0,1,0}
  local right=(c.f0+1)%4
  local dx,dz=physical.pos.x-c.l.x,physical.pos.z-c.l.z
  local actualWorld={
    x=c.w.x+dz*cx[c.f0]+dx*cx[right],
    y=c.w.y+physical.pos.y-c.l.y,
    z=c.w.z+dz*cz[c.f0]+dx*cz[right],
  }
  local api, sim = miner(files)
  for _,field in ipairs({"blocks","slots","items","fuel","fuelLimit","selected","chests","deposits"}) do
    sim[field] = physical[field]
  end
  sim.pos={x=physical.pos.x,y=physical.pos.y,z=physical.pos.z}
  sim.heading=physical.heading
  api.config(f)
  api.fix(api.state().pos,actualWorld)
  return api, sim
end

local function depot(api,sim,f)
  f.depot={x=108,y=67,z=-55,junk="down",valuables="north",fuel="west"}
  api.config(f)
  sim.blocks["-8,-1,0"]="minecraft:chest"
  sim.blocks["-8,0,-1"]="minecraft:chest"
  sim.blocks["-7,0,0"]="minecraft:chest"
  sim.chests["-7,0,0"]={name="minecraft:coal",count=200}
  api.lease("granted")
end

local function scannedJob(a,id)
  a.length=3
  a.radius=math.ceil(math.sqrt((a.x-a.routeHome.x)^2+(67-a.y+a.length-1)^2))
  a.queueId=id
  a.coverage="allSides"
  a.veinBounds={x1=a.x-1,x2=a.x+1,y1=a.y-1,y2=a.y+2,z1=a.z-1,z2=a.z+a.length}
  return a
end

local function pausedVein()
  local api,sim,files,a,f=rowMiner()
  scannedJob(a,"row:paused")
  sim.blocks["1,-4,5"]="minecraft:diamond_ore"
  local stopped=false
  sim.afterSave=function(text)
    if key(decoded(text).pos)=="1,-4,5" and not stopped then
      stopped=true
      api.message({type="cmd",action="stop"})
    end
  end
  api.command({action="fleetJob",args=a})
  assert(stopped and api.state().fleetJob and api.state().fleetJob.paused,"job did not pause in its upper ore vein")
  same(api.state().world,{x=99,y=63,z=-50})
  local r=api.state().miningRoute
  assert(r.work and r.veinPath and #r.veinPath>0,"paused job lost its independent opened vein exit")
  return api,sim,files,a,f
end

test("captures the initial home before moving and descends south forward/down at every step", function()
  local api, sim, files, a = rowMiner()
  api.row.ensure(a)
  local saved = decoded(files[".minerdash_state"])
  same(saved.miningRoute.home,a.routeHome)
  assert(not saved.miningRoute.bottomSaved and saved.miningRoute.stair.completed==0)
  assert(sim.moves==0)
  sim.beforeMove=function()
    same(decoded(files[".minerdash_state"]).miningRoute.home,a.routeHome)
  end
  api.row.enter(a)
  assert(sim.moves==10 and sim.digs==10)
  for i,p in ipairs(sim.history) do
    local step=math.floor((i+1)/2)
    same(p,{x=0,y=i%2==1 and 1-step or -step,z=step})
    assert(p.dir==(i%2==1 and "forward" or "down"))
  end
  local route=api.state().miningRoute
  same(api.state().world,a.stairBottom)
  same(route.home,a.routeHome); same(route.bottom,a.stairBottom)
  assert(route.bottomSaved and route.stair.complete and route.stair.completed==5)
  assert(files[".minerdash_route"]==nil,"the removed breadcrumb journal was recreated")
end)

test("initial staircase excavation alone may cross protected coordinates", function()
  local api, sim, files, a, f = rowMiner()
  f.protect.areas={{name="Protected upper levels",x1=90,x2=110,y1=63,y2=70,z1=-60,z2=0}}
  api.config(f)
  api.row.enter(a)
  same(api.state().world,a.stairBottom)
  assert(sim.digs==10 and api.state().miningRoute.bottomSaved)
end)

test("initial staircase excavation never mines protected block types", function()
  for _,block in ipairs({"minecraft:chest","minecraft:barrel","create:gearbox","computercraft:computer_normal"}) do
    local api,sim,files,a,f=rowMiner()
    f.protect.areas={{name="Initial exception",x1=90,x2=110,y1=60,y2=70,z1=-60,z2=0}}
    api.config(f)
    sim.blocks["0,0,1"]=block
    local ok,why=pcall(api.row.enter,a)
    assert(not ok and tostring(why):find("protected"),"did not reject "..block..": "..tostring(why))
    assert(sim.blocks["0,0,1"]==block and sim.digs==0 and sim.moves==0,"dug "..block)
  end
end)

test("assembly reaches the assigned lane only after saving the own staircase bottom", function()
  local api,sim,files,a=rowMiner(62,96)
  for x=1,4 do
    sim.blocks[x..",-5,5"]="minecraft:stone"
    sim.blocks[x..",-4,5"]="minecraft:stone"
  end
  sim.beforeMove=function(target)
    if target.x~=0 then
      local saved=decoded(files[".minerdash_state"]).miningRoute
      assert(saved.bottomSaved and saved.stair.complete)
      same(saved.bottom,a.stairBottom)
    end
  end
  api.row.enter(a)
  same(api.state().world,{x=96,y=62,z=-50})
  same(api.state().miningRoute.bottom,{x=100,y=62,z=-50})
  assert(sim.moves==14)
end)

test("assembly mining retains normal protected-area checks", function()
  local api,sim,files,a,f=rowMiner(62,96)
  f.protect.areas={{name="Assembly vault",x1=99,x2=99,y1=62,y2=62,z1=-50,z2=-50}}
  api.config(f)
  sim.blocks["1,-5,5"]="minecraft:stone"
  api.row.enter(a)
  same(api.state().world,{x=96,y=62,z=-50})
  assert(api.state().miningRoute.bottomSaved and sim.blocks["1,-5,5"])
  for _,p in ipairs(sim.history) do assert(key(p)~="1,-5,5","entered the protected assembly cell") end
end)

test("return climbs the exact saved staircase in reverse without digging", function()
  local api,sim,files,a=rowMiner()
  api.row.enter(a)
  local first,digs=#sim.history,sim.digs
  api.row.exit("recall")
  same(api.state().world,a.routeHome)
  assert(#sim.history==2*first and sim.digs==digs)
  for index=1,first do
    local expected=index==first and {x=0,y=0,z=0} or sim.history[first-index]
    same(sim.history[first+index],expected)
  end
  assert(sim.heading==0 and api.state().miningRoute.phase=="home")
end)

test("return mines at the safe level to the own bottom before climbing", function()
  local api,sim,files,a=rowMiner(62,96)
  api.row.enter(a)
  api.face(0); api.move("forward"); api.move("forward")
  sim.blocks["4,-5,6"]="minecraft:stone"
  sim.blocks["2,-5,5"]="minecraft:stone"
  local first=#sim.history
  api.row.exit("recall")
  local reachedBottom=false
  for index=first+1,#sim.history do
    local p=sim.history[index]
    if not reachedBottom then
      assert(p.y==-5,"left safe mining level before the staircase bottom")
      if p.x==0 and p.z==5 then reachedBottom=true end
    end
  end
  assert(reachedBottom and sim.digs==12)
  same(api.state().world,a.routeHome)
end)

test("return refuses new stone in an opened stair cell", function()
  local api,sim,files,a=rowMiner()
  api.row.enter(a)
  sim.blocks["0,-4,5"]="minecraft:stone"
  local digs,moves=sim.digs,sim.moves
  local ok,why=pcall(api.row.exit,"recall")
  assert(not ok and tostring(why):find("will not dig a new stair route"))
  assert(sim.digs==digs and sim.moves==moves and sim.blocks["0,-4,5"])
end)

test("opened stairs clear fallen sand and gravel while preserving block protection", function()
  for _,block in ipairs({"minecraft:sand","minecraft:gravel"}) do
    local api,sim,files,a=rowMiner()
    api.row.enter(a)
    sim.blocks["0,-4,5"]=block
    local digs=sim.digs
    api.row.exit("recall")
    assert(sim.digs==digs+1 and not sim.blocks["0,-4,5"])
    same(api.state().world,a.routeHome)
  end
  local api,sim,files,a,f=rowMiner()
  api.row.enter(a)
  f.protect.blocks[#f.protect.blocks+1]="minecraft:gravel"
  api.config(f)
  sim.blocks["0,-4,5"]="minecraft:gravel"
  local digs=sim.digs
  local ok,why=pcall(api.row.exit,"recall")
  assert(not ok and tostring(why):find("protected block"))
  assert(sim.digs==digs and sim.blocks["0,-4,5"])
end)

test("a later descent reuses opened cells and never receives initial excavation permission", function()
  local api,sim,files,a=rowMiner()
  api.row.enter(a); api.row.exit("recall")
  local digs=sim.digs
  api.row.enter(a); api.row.exit("recall")
  assert(sim.digs==digs)
  sim.blocks["0,0,1"]="minecraft:stone"
  local moves=sim.moves
  local ok,why=pcall(api.row.enter,a)
  assert(not ok and tostring(why):find("will not dig a new stair route"))
  assert(sim.moves==moves and sim.digs==digs and sim.blocks["0,0,1"])
end)

test("later stair travel does not reuse the protected-area exception for fallen blocks", function()
  local api,sim,files,a,f=rowMiner()
  api.row.enter(a); api.row.exit("recall")
  f.protect.areas={{name="Restricted surface",x1=100,x2=100,y1=67,y2=67,z1=-54,z2=-54}}
  api.config(f)
  sim.blocks["0,0,1"]="minecraft:gravel"
  local digs=sim.digs
  local ok,why=pcall(api.row.enter,a)
  assert(not ok and tostring(why):find("Restricted surface"))
  assert(sim.digs==digs and sim.blocks["0,0,1"])
end)

test("a later job cannot overwrite the saved home or change depth away from home", function()
  local api,sim,files,a=rowMiner()
  api.row.enter(a)
  local another=args()
  another.routeHome.x=101
  another.stairBottom.x=101
  local ok,why=pcall(api.row.ensure,another)
  assert(not ok and tostring(why):find("cannot replace"))
  same(api.state().miningRoute.home,a.routeHome)
  ok,why=pcall(api.row.ensure,args(61))
  assert(not ok and tostring(why):find("Return to the saved home"))
  same(api.state().miningRoute.bottom,a.stairBottom)
end)

test("saved home and bottom survive reboot away from the home row", function()
  local api,sim,files,a,f=rowMiner()
  api.row.enter(a)
  local reboot,after=resume(files,sim,f)
  same(reboot.state().miningRoute.home,a.routeHome)
  same(reboot.state().miningRoute.bottom,a.stairBottom)
  local digs=after.digs
  reboot.row.exit("recall")
  same(reboot.state().world,a.routeHome)
  assert(after.digs==digs and after.moves==10)
  assert(files[".minerdash_route"]==nil)
end)

test("power loss before or after a saved stair leg resumes the exact unfinished leg", function()
  for _,scenario in ipairs({{leg="forward",moved=false},{leg="forward",moved=true},{leg="down",moved=true}}) do
    local api,sim,files,a,f=rowMiner()
    local crashed=false
    sim.afterSave=function(text)
      local saved=decoded(text)
      local r=saved.miningRoute
      local pending=r and r.stair.pending
      if not pending or pending.leg~=scenario.leg or pending.step~=2 then return end
      local atTo=saved.pos.y==pending.to.y-67 and saved.pos.z==pending.to.z+55
      if atTo==scenario.moved then crashed=true; error("simulated power loss") end
    end
    local ok,why=pcall(api.row.enter,a)
    assert(not ok and crashed and tostring(why):find("simulated power loss"))
    local reboot,after=resume(files,sim,f)
    reboot.row.enter(a)
    same(reboot.state().world,a.stairBottom)
    local expected=scenario.leg=="forward" and scenario.moved and "down" or "forward"
    assert(after.history[1].dir==expected,"repeated or skipped an unfinished stair leg")
    assert(reboot.state().miningRoute.stair.completed==5 and reboot.state().miningRoute.bottomSaved)
    same(reboot.state().miningRoute.home,a.routeHome)
  end
end)

test("surface navigation stays at Y67 around torches and other turtles", function()
  local api,sim,files,a=rowMiner()
  api.row.ensure(a)
  sim.blocks["1,0,0"]="minecraft:torch"
  sim.blocks["0,0,1"]="computercraft:turtle_normal"
  api.row.surface({x=97,y=67,z=-55})
  same(api.state().world,{x=97,y=67,z=-55})
  for _,p in ipairs(sim.history) do assert(p.y==0,"surface navigation changed its Y") end
  assert(sim.digs==0 and sim.blocks["1,0,0"]=="minecraft:torch" and sim.blocks["0,0,1"])
  local ok,why=pcall(api.row.surface,{x=97,y=66,z=-55})
  assert(not ok and tostring(why):find("remain at Y 67"))
end)

test("an actual fleet job finishes through its saved stairs and visits the shared depot at Y67", function()
  local api,sim,files,a,f=rowMiner()
  depot(api,sim,f)
  scannedJob(a,"row:finished")
  local visited=false
  sim.beforeMove=function(target)
    local r=api.state().miningRoute
    if r and (r.phase=="toDepot" or r.phase=="fromDepot" or r.phase=="toStairHome") then
      assert(target.y==0,"shared-depot trip left Y67")
    end
    if key(target)=="-8,0,0" then visited=true end
  end
  api.command({action="fleetJob",args=a})
  local state=api.state()
  assert(not state.fleetJob and state.lastFleetResult and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok)
  assert(visited,"completed fleet job skipped the shared depot")
  same(state.world,a.routeHome)
  same(state.miningRoute.home,a.routeHome); same(state.miningRoute.bottom,a.stairBottom)
  assert(state.miningRoute.phase=="home" and not api.status().holding)
  local moves=sim.moves
  api.jobs.fleetJob(a)
  assert(sim.moves==moves,"replayed queue assignment ran a completed job twice")
end)

test("shared depot unloads and refuels before returning to the saved home on Y67", function()
  local api,sim,files,a,f=rowMiner()
  api.row.enter(a)
  depot(api,sim,f)
  sim.fuel=80
  sim.items[1],sim.slots[1]="minecraft:cobblestone",12
  sim.items[2],sim.slots[2]="minecraft:diamond",3
  local digs=sim.digs
  sim.beforeMove=function(target)
    local r=api.state().miningRoute
    if r.phase=="toDepot" or r.phase=="fromDepot" or r.phase=="toStairHome" then assert(target.y==0,"depot servicing changed surface height") end
  end
  api.depotVisit(500)
  same(api.state().world,a.routeHome)
  assert(sim.fuel>=10000 and sim.digs==digs)
  assert(sim.deposits["-8,-1,0"]["minecraft:cobblestone"]==12)
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==3)
  for slot=1,16 do assert((sim.slots[slot] or 0)==0) end
end)

test("Force Home cancels an actual paused job and unwinds its saved upper vein before ascending", function()
  local api,sim,files,a=pausedVein()
  local first,digs=#sim.history,sim.digs
  api.command({action="forceHome"})
  local state=api.state()
  assert(not state.fleetJob and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok==false)
  same(state.world,a.routeHome)
  same(sim.history[first+1],{x=0,y=-4,z=5})
  same(sim.history[first+2],{x=0,y=-5,z=5})
  assert(sim.digs==digs and not state.miningRoute.intent)
end)

test("clearing the job and rebooting preserves the work and vein path needed by Force Home", function()
  local api,sim,files,a,f=pausedVein()
  api.actions.forgetJob()
  local saved=decoded(files[".minerdash_state"])
  assert(not saved.fleetJob and saved.miningRoute.work and #saved.miningRoute.veinPath>0)
  local reboot,after=resume(files,sim,f)
  reboot.jobs.forceHome()
  same(reboot.state().world,a.routeHome)
  assert(after.digs==0)
  same(after.history[1],{x=0,y=-4,z=5})
  same(after.history[2],{x=0,y=-5,z=5})
end)

test("automatic recovery completes an interrupted return after its cancellation receipt was saved", function()
  local api,sim,files,a,f=pausedVein()
  local interrupted=false
  sim.afterSave=function(text)
    local saved=decoded(text)
    if not saved.fleetJob and saved.lastFleetResult and saved.lastFleetResult.id==a.queueId
      and saved.miningRoute.intent=="home" then
      interrupted=true
      error("power loss after cancellation receipt")
    end
  end
  api.command({action="goHome"})
  assert(interrupted)
  local saved=decoded(files[".minerdash_state"])
  assert(not saved.fleetJob and saved.lastFleetResult.ok==false and saved.miningRoute.veinPath)
  local reboot,after=resume(files,sim,f)
  reboot.recover()
  local state=reboot.state()
  same(state.world,a.routeHome)
  assert(state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok==false and after.digs==0)
end)

test("an actual paused upper-vein job resumes to completion with its original receipt and home", function()
  local api,sim,files,a=pausedVein()
  api.lease("granted")
  api.command({action="resume"})
  local state=api.state()
  assert(not state.fleetJob and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok)
  same(state.world,a.routeHome)
  same(state.miningRoute.home,a.routeHome)
  assert(not sim.blocks["1,-4,5"] and not state.miningRoute.veinPath)
end)

test("a second actual job changes depth at home by extending only unopened stairs", function()
  local api,sim,files,a,f=rowMiner(65)
  depot(api,sim,f)
  scannedJob(a,"row:shallow"); a.length=1
  api.command({action="fleetJob",args=a})
  assert(not api.state().fleetJob and api.state().lastFleetResult.ok)
  same(api.state().world,a.routeHome)
  assert(api.state().miningRoute.stair.completed==2 and sim.digs==4)
  local nextJob=scannedJob(args(62),"row:deeper")
  nextJob.length=1
  for step=3,5 do
    sim.blocks["0,"..(1-step)..","..step]="minecraft:stone"
    sim.blocks["0,"..(-step)..","..step]="minecraft:stone"
  end
  f.protect.areas={{name="Only the new third step",x1=100,x2=100,y1=64,y2=65,z1=-52,z2=-52}}
  api.config(f)
  api.lease("granted")
  api.command({action="fleetJob",args=nextJob})
  local state=api.state()
  assert(not state.fleetJob and state.lastFleetResult.id==nextJob.queueId and state.lastFleetResult.ok)
  same(state.world,a.routeHome)
  same(state.miningRoute.home,a.routeHome)
  same(state.miningRoute.bottom,nextJob.stairBottom)
  assert(state.miningRoute.stair.completed==5 and state.miningRoute.bottomSaved and sim.digs==10)
end)

test("Force Home detours around protected blocks without leaving the safe return level", function()
  for _,block in ipairs({"minecraft:chest","computercraft:turtle_normal","create:gearbox"}) do
    local api,sim,files,a=rowMiner(62,96)
    api.row.enter(a)
    api.face(0); api.move("forward"); api.move("forward")
    sim.blocks["4,-5,6"]=block
    local first=#sim.history
    api.jobs.forceHome()
    local reachedBottom=false
    for index=first+1,#sim.history do
      local p=sim.history[index]
      if not reachedBottom then
        assert(p.y==-5,"protected obstacle caused a return at an unsafe level")
        if key(p)=="0,-5,5" then reachedBottom=true end
      end
    end
    assert(reachedBottom and sim.blocks["4,-5,6"]==block,"Force Home dug "..block)
    same(api.state().world,a.routeHome)
  end
end)

test("Force Home without a saved staircase refuses to invent a route", function()
  local api,sim=miner()
  local ok,why=pcall(api.jobs.forceHome)
  assert(not ok and tostring(why):find("No saved south staircase") and sim.moves==0 and sim.digs==0)
end)

test("a crash during the pre-depot surface return still unloads and refuels before completing", function()
  local api,sim,files,a,f=rowMiner(67)
  depot(api,sim,f)
  scannedJob(a,"row:surface-service")
  local interrupted=false
  sim.afterSave=function(text)
    local saved=decoded(text)
    local route=saved.miningRoute
    if route and route.phase=="toBottom" and route.intent=="service" and saved.pos.z>0 then
      interrupted=true
      sim.fuel=80
      sim.items[1],sim.slots[1]="minecraft:cobblestone",9
      sim.items[2],sim.slots[2]="minecraft:diamond",2
      error("power loss before reaching the shared depot")
    end
  end
  local ok,why=pcall(api.jobs.fleetJob,a)
  assert(not ok and interrupted and tostring(why):find("power loss before reaching"))
  local saved=decoded(files[".minerdash_state"])
  assert(saved.fleetJob and saved.fleetJob.phase=="depot" and not saved.lastFleetResult)
  local reboot,after=resume(files,sim,f)
  reboot.recover()
  assert(after.fuel>=10000,"recovery skipped refueling at the shared depot")
  assert(after.deposits["-8,-1,0"]["minecraft:cobblestone"]==9,"recovery skipped unloading junk")
  assert(after.deposits["-8,0,-1"]["minecraft:diamond"]==2,"recovery skipped unloading valuables")
  same(reboot.state().world,a.routeHome)
  assert(not reboot.state().lastFleetResult,"a success receipt was recorded before service completed")
  after.beforeMove=function(target)
    assert(target.y==0,"resumed surface job changed its Y")
    if reboot.state().miningRoute.phase=="toDepot" then reboot.lease("granted") end
  end
  after.afterSave=function(text)
    if decoded(text).lastFleetResult then
      assert(after.fuel>=10000 and after.deposits["-8,-1,0"]["minecraft:cobblestone"]==9)
    end
  end
  reboot.command({action="resume"})
  local state=reboot.state()
  assert(not state.fleetJob and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok)
  same(state.world,a.routeHome)
end)

test("inventory servicing during the first descent returns through opened stairs and resumes excavation", function()
  local api,sim,files,a,f=rowMiner()
  depot(api,sim,f)
  scannedJob(a,"row:mid-descent")
  local filled,visits=false,0
  sim.afterSave=function(text)
    local saved=decoded(text)
    if not filled and saved.miningRoute and saved.miningRoute.stair.completed==2 and saved.pos.y==-2 then
      filled=true
      for slot=1,14 do sim.items[slot],sim.slots[slot]="minecraft:cobblestone",64 end
    end
  end
  sim.beforeMove=function(target)
    local route=api.state().miningRoute
    if route and route.phase=="toDepot" then api.lease("granted") end
    if key(target)=="-8,0,0" then visits=visits+1 end
  end
  api.command({action="fleetJob",args=a})
  local state=api.state()
  assert(filled and visits==2,"did not service inventory during the initial descent and at completion")
  assert(not state.fleetJob and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok)
  assert(sim.deposits["-8,-1,0"]["minecraft:cobblestone"]==14*64)
  same(state.world,a.routeHome)
  same(state.miningRoute.home,a.routeHome)
  assert(state.miningRoute.stair.completed==5 and state.miningRoute.bottomSaved and sim.digs==10)
end)

test("GPS reconciles power loss between physical movement and saving the tracked position", function()
  local cases={
    {name="initial first forward",target={x=0,y=0,z=1},next={x=0,y=-1,z=1},direction="forward"},
    {name="initial forward",target={x=0,y=-1,z=2},next={x=0,y=-2,z=2},direction="forward"},
    {name="initial down",target={x=0,y=-2,z=2},next={x=0,y=-2,z=3},direction="down"},
    {name="opened ascent",target={x=0,y=-4,z=5},next={x=0,y=-4,z=4},direction="up",opened=true,ascent=true},
    {name="opened descent",target={x=0,y=0,z=1},next={x=0,y=-1,z=1},direction="forward",opened=true},
  }
  for _,case in ipairs(cases) do
    local api,sim,files,a,f=rowMiner()
    if case.opened then
      api.row.enter(a)
      if not case.ascent then api.row.exit("recall") end
    end
    local interrupted=false
    sim.afterPhysicalMove=function(target,direction)
      if key(target)==key(case.target) then
        assert(direction==case.direction)
        interrupted=true
        error("power loss after physical movement")
      end
    end
    local ok,why
    if case.ascent then ok,why=pcall(api.row.exit,"recall") else ok,why=pcall(api.row.enter,a) end
    assert(not ok and interrupted and tostring(why):find("power loss after physical"),case.name)
    local saved=decoded(files[".minerdash_state"])
    assert(key(saved.pos)~=key(sim.pos),"the crash happened after the tracked position was saved")
    assert(saved.miningRoute.pendingMove,"the physical move had no durable intent")
    same(saved.miningRoute.pendingMove.to,{x=100-sim.pos.x,y=67+sim.pos.y,z=-55+sim.pos.z})
    local reboot,after=resume(files,sim,f)
    assert(reboot.status().gpsTrusted and not reboot.state().miningRoute.pendingMove,case.name.." needed a manual calibration step")
    if case.ascent then reboot.row.exit("recall") else reboot.row.enter(a) end
    same(after.history[1],case.next)
    same(reboot.state().world,case.ascent and a.routeHome or a.stairBottom)
    same(reboot.state().miningRoute.home,a.routeHome)
  end
end)

test("Force Home unwinds Y67 ore cells above a lower mining level before using the staircase", function()
  for _,y in ipairs({65,66}) do
    local api,sim,files,a=rowMiner(y)
    scannedJob(a,"row:upper-at-67:"..y)
    local depth=67-y
    if y==65 then sim.blocks["1,-1,2"]="minecraft:diamond_ore" end
    local upperKey="1,0,"..depth
    sim.blocks[upperKey]="minecraft:diamond_ore"
    local stopped=false
    sim.afterSave=function(text)
      if key(decoded(text).pos)==upperKey and not stopped then
        stopped=true
        api.message({type="cmd",action="stop"})
      end
    end
    api.command({action="fleetJob",args=a})
    assert(stopped and api.state().fleetJob and api.state().fleetJob.paused)
    same(api.state().world,{x=99,y=67,z=-55+depth})
    local first,digs=#sim.history,sim.digs
    api.command({action="forceHome"})
    local state=api.state()
    same(state.world,a.routeHome)
    assert(not state.fleetJob and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok==false)
    local expected=y==65 and {{x=1,y=-1,z=2},{x=0,y=-1,z=2},{x=0,y=-2,z=2}}
      or {{x=0,y=0,z=1},{x=0,y=-1,z=1}}
    for index,p in ipairs(expected) do same(sim.history[first+index],p) end
    assert(sim.digs==digs,"return from the Y67 ore vein dug a new route")
  end
end)

test("target-Y67 mining returns may dig but surface depot navigation does not", function()
  local api,sim,files,a=rowMiner(67,96)
  api.row.enter(a)
  api.face(0); api.move("forward"); api.move("forward")
  sim.blocks["4,0,1"]="minecraft:stone"
  api.jobs.forceHome()
  same(api.state().world,a.routeHome)
  assert(sim.digs==1 and not sim.blocks["4,0,1"],"safe Y67 mining return did not clear its ordinary obstruction")
  for _,p in ipairs(sim.history) do assert(p.y==0,"target-Y67 return changed its height") end
  sim.blocks["1,0,0"]="minecraft:stone"
  api.row.surface({x=97,y=67,z=-55})
  assert(sim.digs==1 and sim.blocks["1,0,0"],"surface depot navigation mined an ordinary block")
  same(api.state().world,{x=97,y=67,z=-55})
end)

print("Passed " .. count .. " south-row route scenarios")
