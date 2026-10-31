-- Actual fleet jobs, CC:Tweaked serialization, and shared-depot regressions.
-- Run from the repository root: lua test/turtle-depot.lua
local common=dofile("test/turtle-sim.lua")
local miner,key,same=common.miner,common.key,common.same
local count,failures=0,{}
local function test(name,fn)
  count=count+1
  local ok,why=pcall(fn)
  if ok then print("ok "..count.." - "..name)
  else
    failures[#failures+1]=name..": "..tostring(why)
    print("not ok "..count.." - "..failures[#failures])
  end
end

local function decoded(text)
  return assert(load("return "..text,"saved test state","t",{}))()
end

local function setup(radius)
  radius=radius or 7
  local api,sim,files=miner()
  local f={
    depot={x=108,y=67,z=-55,junk="down",valuables="north",fuel="west"},refuelTo=10000,
    protect={blocks={"*chest*","*barrel*","create:*"},areas={}},
    items={valuables={"*diamond*"},fuel={"minecraft:coal"}},veinBlocks={"*_ore"},
  }
  local a={
    kind="branchMine",routeMode="southRow",access="southStairs",entryY=67,
    routeHome={x=100,y=67,z=-55,facing="south"},stairBottom={x=100,y=62,z=-50},
    x=100,y=62,z=-50,dir="south",radius=radius,length=radius-4,spacing=2,band=0,scan=true,
    coverage="allSides",veinBounds={x1=99,x2=101,y1=61,y2=64,z1=-51,z2=-54+radius},
    queueId="depot:"..radius,
  }
  api.config(f)
  api.fix({x=0,y=0,z=0},{x=100,y=67,z=-55})
  for step=1,5 do
    sim.blocks["0,"..(1-step)..","..step]="minecraft:stone"
    sim.blocks["0,"..(-step)..","..step]="minecraft:stone"
  end
  sim.blocks["-8,-1,0"]="minecraft:chest"
  sim.blocks["-8,0,-1"]="minecraft:chest"
  sim.blocks["-7,0,0"]="minecraft:chest"
  sim.chests["-7,0,0"]={name="minecraft:coal",count=200}
  api.lease("granted")
  sim.beforeMove=function()
    local route=api.state().miningRoute
    if route and route.phase=="toDepot" then api.lease("granted") end
  end
  return api,sim,files,a,f
end

local function finished(api,a)
  local state=api.state()
  assert(not state.fleetJob,"fleet job stopped: "..tostring(state.fleetJob and state.fleetJob.failed))
  assert(state.lastFleetResult and state.lastFleetResult.id==a.queueId and state.lastFleetResult.ok,"job has no successful durable receipt")
  same(state.world,a.routeHome)
end

test("whole fleet jobs save upper-cell scans with the strict CC serializer",function()
  local api,sim,files,a=setup()
  local upperSaved=false
  sim.afterSave=function(text)
    local saved=decoded(text)
    if saved.miningRoute and saved.miningRoute.veinPath and #saved.miningRoute.veinPath>0 then upperSaved=true end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(upperSaved,"whole job never checkpointed its upper-cell scan")
  assert(sim.inspected["1,-4,5"] and sim.inspected["-1,-4,5"],"upper walls were skipped")
end)

test("large upper ore veins cut and resume without repeated-reference serialization failures",function()
  local api,sim,files,a=setup(50)
  for z=5,49 do sim.blocks["1,-4,"..z]="minecraft:diamond_ore" end
  local cutSaved,resumed=false,false
  sim.afterSave=function(text)
    local saved=decoded(text)
    local job=saved.fleetJob
    if job and job.vein and #job.vein>=32 and job.step==0 then cutSaved=true end
    if cutSaved and job and job.step>0 then resumed=true end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(cutSaved and resumed,"long vein never completed its checkpointed continuation")
  for z=5,49 do assert(not sim.blocks["1,-4,"..z],"unfinished upper ore at Z "..z) end
end)

test("surplus coal a full fuel chest can't take is burnt into the tank rather than carried",function()
  local api,sim,files,a,f=setup()
  api.row.ensure(a)
  api.row.surface(f.depot)
  sim.fullChests["-7,0,0"]=true
  sim.fuel=20000
  sim.items[1],sim.slots[1]="minecraft:coal",64
  local problem=api.dockWork(500)
  assert(problem==nil,"surplus fuel was reported as a problem: "..tostring(problem))
  assert((sim.slots[1] or 0)==0,"the turtle kept spare coal")
  assert(sim.fuel==20000+64*80,"surplus coal was not burnt")
end)

test("with a full tank, surplus coal is stored with the valuables rather than carried",function()
  local api,sim,files,a,f=setup()
  api.row.ensure(a)
  api.row.surface(f.depot)
  sim.fullChests["-7,0,0"]=true
  sim.items[1],sim.slots[1]="minecraft:coal",64
  local problem=api.dockWork(500)
  assert(problem==nil,"surplus fuel was reported as a problem: "..tostring(problem))
  assert((sim.slots[1] or 0)==0,"the turtle kept spare coal")
  assert(sim.deposits["-8,0,-1"]["minecraft:coal"]==64,"surplus coal was not stored")
end)

test("fuel taken from the chest beyond the refuel target goes back, leaving no spare stack",function()
  local api,sim,files,a,f=setup()
  api.row.ensure(a)
  api.row.surface(f.depot)
  sim.fuel=9960
  local problem=api.dockWork(500)
  assert(problem==nil,tostring(problem))
  for slot=1,16 do assert((sim.slots[slot] or 0)==0,"kept fuel in slot "..slot) end
  assert(sim.fuel==10040,"burnt more than the one coal it needed")
  assert(sim.deposits["-7,0,0"]["minecraft:coal"]==63,"the rest of the stack did not go back in the fuel chest")
end)

local function serviceJob()
  local api,sim,files,a=setup()
  sim.fullChests["-7,0,0"]=true
  local injected,resumeDetail,visits=false,nil,0
  sim.afterSave=function(text)
    local saved=decoded(text)
    if not injected and saved.fleetJob and saved.fleetJob.step==1 then
      injected=true
      for slot=1,14 do sim.items[slot],sim.slots[slot]="minecraft:cobblestone",64 end
      sim.items[15],sim.slots[15]="minecraft:coal",64
    end
  end
  sim.beforeMove=function(target)
    local route=api.state().miningRoute
    if route and route.phase=="toDepot" then api.lease("granted") end
    if key(target)=="-8,0,0" then visits=visits+1 end
    if not resumeDetail and visits>0 and target.y<0 and route and route.phase=="descending" then
      resumeDetail=api.status().job and api.status().job.detail
    end
  end
  sim.onSleep=function()
    local status=api.status()
    if status.job and status.job.detail:find("Waiting:",1,true) then error("a full fuel chest blocked a sufficiently fueled job") end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(injected and visits==2,"job did not service inventory and then finish mining")
  assert((sim.slots[15] or 0)==0,"the job kept spare coal")
  assert(sim.deposits["-8,0,-1"]["minecraft:coal"]==64,"surplus coal was not stored with the valuables")
  assert(sim.deposits["-8,-1,0"]["minecraft:cobblestone"]==14*64)
  return api,sim,resumeDetail
end

test("a job resumes work and finishes when the fuel chest cannot accept its surplus coal",function()
  local api,sim=serviceJob()
  local logs=table.concat(sim.prints,"\n")
  assert(not logs:find("fuel chest is full",1,true),"the full fuel chest produced a false warning: "..logs)
end)

test("job detail advances past unloading before descending back to its mining level",function()
  local api,sim,detail=serviceJob()
  assert(type(detail)=="string","did not observe the resumed descent")
  assert(not detail:lower():find("unload",1,true),"resumed descent still displayed: "..detail)
  assert(not detail:find("Waiting for a turn",1,true),"resumed descent still displayed a dock wait")
end)

test("empty or missing fuel supplies still warn and wait when actual fuel is insufficient",function()
  for _,missing in ipairs({false,true}) do
    local api,sim,files,a=setup()
    sim.fuel=80
    if missing then sim.blocks["-7,0,0"]=nil else sim.chests["-7,0,0"].count=0 end
    local waited=false
    sim.onSleep=function()
      local job=api.status().job
      if job and job.detail:find("Waiting:",1,true) then
        waited=true
        assert(job.detail:find("fuel",1,true),"low fuel wait has no useful reason")
        api.message({type="cmd",action="stop"})
      end
    end
    api.command({action="fleetJob",args=a})
    local state=api.state()
    assert(waited and state.fleetJob and state.fleetJob.paused,"low fuel did not leave resumable work waiting for supply")
    assert(sim.fuel==80 and not (state.lastFleetResult and state.lastFleetResult.ok))
    assert(table.concat(sim.prints,"\n"):find("fuel chest",1,true),"low fuel supply warning was hidden")
  end
end)

test("a full valuables chest remains a real unload problem",function()
  local api,sim,files,a,f=setup()
  api.row.ensure(a)
  api.row.surface(f.depot)
  sim.fullChests["-8,0,-1"]=true
  sim.items[1],sim.slots[1]="minecraft:diamond",3
  local problem=api.dockWork(500)
  assert(problem and problem:find("valuables chest is full",1,true),"the actual valuable unload failure was hidden")
  assert(sim.slots[1]==3,"undeposited valuables were lost")
end)

test("shared state references save on strict CC serializers while a real cycle fails before touching the previous file",function()
  local api,sim,files,a=setup()
  api.row.enter(a)
  local route=api.state().miningRoute
  local shared={x=100,y=62,z=-50}
  route.firstReference,route.secondReference=shared,shared
  api.save()
  local before=files[".minerdash_state"]
  local saved=decoded(before)
  same(saved.miningRoute.firstReference,shared)
  same(saved.miningRoute.secondReference,shared)
  route.realCycle=route
  local ok,why=pcall(api.save)
  assert(not ok and tostring(why):find("Cannot serialize table with recursive entries",1,true),"a real state cycle was not rejected")
  assert(files[".minerdash_state"]==before,"failed serialization truncated the last durable position and route")
  route.realCycle=nil
  api.save()
  api.recover()
  same(api.state().world,a.routeHome)
  local recovered=decoded(files[".minerdash_state"])
  same(recovered.miningRoute.home,a.routeHome)
  assert(recovered.miningRoute.phase=="home" and recovered.miningRoute.realCycle==nil)
end)

assert(#failures==0,table.concat(failures,"\n"))
print("Passed "..count.." depot scenarios")
