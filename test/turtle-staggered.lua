-- Staggered tunnels through a whole cylinder, and switchback staircases.
-- Run from the repository root: lua test/turtle-staggered.lua
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

-- Home (100, 67, -55) is local (0, 0, 0) facing south: local +Z is south and
-- local +X is west.
local HOME={x=100,y=67,z=-55}
local function lkey(w) return key({x=HOME.x-w.x,y=w.y-HOME.y,z=w.z-HOME.z}) end
local function tunnel(x,y) return (x+2*y)%5==0 end
local function inside(x,z,r) return (x-HOME.x)^2+(z-HOME.z)^2<=r*r end

local function stairZ(step,r)
  local p=step%(2*r)
  return -55+(p<=r and p or 2*r-p)
end

local function fleetConfig()
  return {
    depot={x=108,y=67,z=-55,junk="down",valuables="north",fuel="west"},refuelTo=10000,
    protect={blocks={"*chest*","*barrel*","create:*","!create:*_ore"},areas={}},
    items={valuables={"*diamond*","*_ore"},fuel={"minecraft:coal"}},veinBlocks={"*_ore"},
  }
end

local function setup(r,yTop,yBottom,first,last)
  local api,sim,files=miner()
  local A,low=yTop+2,math.max(yBottom-1,-59)
  api.config(fleetConfig())
  api.fix({x=0,y=0,z=0},HOME)
  -- Solid stone under the surface, so every tunnel and stair block is dug.
  for x=HOME.x-r-1,HOME.x+r+1 do
    for y=low-2,66 do
      for z=HOME.z-r-1,HOME.z+r+1 do sim.blocks[lkey({x=x,y=y,z=z})]="minecraft:stone" end
    end
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
  local zb=stairZ(67-A,r)
  local a={
    kind="branchMine",pattern="staggered",routeMode="southRow",access="southStairs",entryY=67,
    routeHome={x=HOME.x,y=67,z=-55,facing="south"},stairBottom={x=HOME.x,y=A,z=zb},
    x=first,z=-55,y=A,dir="south",radius=r,first=first,last=last,low=low,yTop=yTop,yBottom=yBottom,
    scan=true,band=0,spacing=5,goal=0,goalItem="valuables",coverage="allSides",
    veinBounds={x1=math.min(first,last)-1,x2=math.max(first,last)+1,y1=low-1,y2=A,z1=-55-r-1,z2=-55+r+1},
    queueId="staggered:"..r,
  }
  return api,sim,files,a
end

local function finished(api,a)
  local state=api.state()
  assert(not state.fleetJob,"fleet job stopped: "..tostring(state.fleetJob and state.fleetJob.failed))
  assert(state.lastFleetResult and state.lastFleetResult.ok,"job has no successful durable receipt")
  same(state.world,a.routeHome)
end

test("staggered tunnels check every block between them through the whole cylinder",function()
  local r,yTop,yBottom=4,60,58
  local api,sim,files,a=setup(r,yTop,yBottom,96,104)
  -- Ore in every block that is not a tunnel, at the covered levels.
  local ores={}
  for x=97,103 do
    for y=yBottom,yTop do
      for z=-55-r,-55+r do
        if not tunnel(x,y) and inside(x,z,r) and inside(x-1,z,r) and inside(x+1,z,r) then
          ores[#ores+1]={x=x,y=y,z=z}
        end
      end
    end
  end
  local firstOre=ores[1]
  sim.blocks[lkey(firstOre)]="minecraft:diamond_ore"
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(not sim.blocks[lkey(firstOre)],"ore beside a tunnel was not mined")
  for _,w in ipairs(ores) do
    assert(sim.inspected[lkey(w)] or not sim.blocks[lkey(w)],"never checked "..w.x..","..w.y..","..w.z)
  end
  -- Only tunnels, shafts, the corridor, stairs and the one ore were dug: a
  -- block between tunnels is left standing unless it was ore.
  for _,w in ipairs(ores) do
    if w~=firstOre and w.z~=-55 then assert(sim.blocks[lkey(w)],"dug a block between tunnels at "..w.x..","..w.y..","..w.z) end
  end
  for x=96,104 do
    for y=a.low,a.y-1 do
      if tunnel(x,y) then
        for z=-55-r,-55+r do
          if inside(x,z,r) then assert(not sim.blocks[lkey({x=x,y=y,z=z})],"tunnel block left at "..x..","..y..","..z) end
        end
      end
    end
  end
end)

test("a radius smaller than the depth switches the staircase back instead of leaving the circle",function()
  local r=3
  -- Column 100 has its tunnels at every level divisible by five.
  local api,sim,files,a=setup(r,55,55,100,100)
  local depth=67-a.y
  assert(depth>2*r,"the test needs at least two switchbacks")
  local farthest=0
  local before=sim.beforeMove
  sim.beforeMove=function(target,direction)
    farthest=math.max(farthest,math.abs(target.z))
    before(target,direction)
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(farthest<=r,"the staircase or tunnels left the radius")
  for step=1,depth do
    local foot={x=HOME.x,y=67-step,z=stairZ(step,r)}
    assert(not sim.blocks[lkey(foot)] and not sim.blocks[lkey({x=foot.x,y=foot.y+1,z=foot.z})],"stair step "..step.." was not opened")
  end
  local route=api.state().miningRoute
  assert(route.stair.completed==depth and route.bottom.z==stairZ(depth,r))
end)

test("a cancelled staggered job climbs out of a deep tunnel the way it came",function()
  local api,sim,files,a=setup(4,60,56,100,104)
  local stopped=false
  sim.afterSave=function()
    local state=api.state()
    local w=state.world
    if not stopped and w and w.y<a.y-3 and w.z>-53 then
      stopped=true
      api.message({type="cmd",action="stop"})
    end
  end
  api.command({action="fleetJob",args=a})
  assert(stopped,"never reached a deep south tunnel")
  local digs=sim.digs
  sim.afterSave=nil
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(sim.digs==digs,"the way out dug new blocks")
end)

test("a later job with a larger radius only reuses the stair steps both radii share",function()
  local api,sim,files,a=setup(3,55,55,100,100)
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(api.state().miningRoute.stair.completed==67-a.y)
  local _,_,_,wider=setup(5,55,55,100,100)
  wider.queueId="wider"
  local digs=sim.digs
  api.command({action="fleetJob",args=wider})
  finished(api,wider)
  local route=api.state().miningRoute
  assert(route.radius==5 and route.bottom.z==stairZ(67-wider.y,5) and route.stair.completed==67-wider.y)
  -- Steps 1 to 3 are shared; from step 4 the wider stairs carry on south.
  for step=4,67-wider.y do
    local foot={x=HOME.x,y=67-step,z=stairZ(step,5)}
    assert(not sim.blocks[lkey(foot)],"wider stair step "..step.." was not opened")
  end
  assert(sim.digs>digs)
end)

test("levels are mined outward from the ore's peak, crossing at depth, with nothing unplanned dug",function()
  local r,yTop,yBottom=4,60,50
  local api,sim,files,a=setup(r,yTop,yBottom,96,104)
  a.peak=55
  local stone={}
  for cell,name in pairs(sim.blocks) do if name=="minecraft:stone" then stone[cell]=true end end
  local levels,moves={},{}
  sim.afterPhysicalMove=function(target)
    local w={x=HOME.x-target.x,y=target.y+HOME.y,z=target.z+HOME.z}
    local inTunnel=w.z~=-55 and w.y<a.y and tunnel(w.x,w.y)
    if inTunnel and levels[#levels]~=w.y then levels[#levels+1]=w.y end
    moves[#moves+1]={tunnel=inTunnel and w.y or nil,corridor=w.y==a.y}
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  -- Band 53-57 first, then 58-61 above it, then 49-52 below.
  local band=function(y) return y>=58 and 2 or y>=53 and 1 or 3 end
  for i=2,#levels do assert(band(levels[i])>=band(levels[i-1]),"band order broke at level "..levels[i]) end
  assert(band(levels[1])==1 and band(levels[#levels])==3)
  -- Only the first pass climbed to the corridor between columns.
  local secondPass,lastTunnel
  for i,m in ipairs(moves) do
    if m.tunnel and not secondPass and band(m.tunnel)==2 then secondPass=i end
    if m.tunnel then lastTunnel=i end
  end
  for i=secondPass,lastTunnel do assert(not moves[i].corridor,"a later pass climbed back to the corridor") end
  local lowestTunnel={}
  for x=96,104 do
    for y=a.y-1,a.low,-1 do if tunnel(x,y) then lowestTunnel[x]=y end end
  end
  local depth=67-a.y
  for cell in pairs(stone) do
    if not sim.blocks[cell] then
      local x,y,z=cell:match("^(-?%d+),(-?%d+),(-?%d+)$")
      local w={x=HOME.x-tonumber(x),y=tonumber(y)+HOME.y,z=tonumber(z)+HOME.z}
      local step=67-w.y
      local stair=w.x==HOME.x and ((step>=1 and step<=depth and w.z==stairZ(step,r)) or (step+1<=depth and w.z==stairZ(step+1,r)))
      local corridor=w.y==a.y and (w.z==-55 or w.x==HOME.x)
      local shaft=w.z==-55 and w.y<a.y and lowestTunnel[w.x] and w.y>=lowestTunnel[w.x]
      local tunnelBlock=tunnel(w.x,w.y) and w.y>=a.low and w.y<a.y and inside(w.x,w.z,r)
      assert(stair or corridor or shaft or tunnelBlock,"dug an unplanned block at "..w.x..","..w.y..","..w.z)
    end
  end
end)

test("a job cancelled after crossing between shafts at depth still climbs out without digging",function()
  local api,sim,files,a=setup(4,60,50,96,104)
  a.peak=50
  local seen,stopped=0,false
  sim.afterSave=function()
    local w=api.state().world
    local job=api.state().fleetJob
    if not stopped and job and job.step>0 and w and w.y<a.y-6 and w.x>98 and w.z>-53 then
      seen=seen+1
      if seen>40 then stopped=true; api.message({type="cmd",action="stop"}) end
    end
  end
  api.command({action="fleetJob",args=a})
  assert(stopped,"never reached deep tunnels in later columns")
  sim.afterSave=nil
  local digs=sim.digs
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(sim.digs==digs,"the way out dug new blocks")
end)

test("blocks the game won't let it break are skipped instead of ending the job",function()
  local r=4
  local api,sim,files,a=setup(r,60,56,96,104)
  local protected="Cannot break protected block"
  -- A tunnel block north of column 100's Y 55 shaft crossing, column 98's
  -- shaft partway down, and an ore beside a tunnel.
  local tunnelBlock={x=100,y=55,z=-57}
  local shaftBlock={x=98,y=58,z=-55}
  local ore={x=101,y=55,z=-54}
  assert(tunnel(100,55) and tunnel(98,56) and not tunnel(101,55))
  for _,w in ipairs({tunnelBlock,shaftBlock,ore}) do sim.refuse[lkey(w)]=protected end
  sim.blocks[lkey(ore)]="minecraft:deepslate_diamond_ore"
  api.command({action="fleetJob",args=a})
  finished(api,a)
  for _,w in ipairs({tunnelBlock,shaftBlock,ore}) do assert(sim.blocks[lkey(w)],"broke a protected block") end
  -- The tunnel stopped short of the block; its south half was still mined.
  assert(not sim.blocks[lkey({x=100,y=55,z=-56})] and sim.blocks[lkey({x=100,y=55,z=-58})])
  assert(not sim.blocks[lkey({x=100,y=55,z=-54})],"skipped the reachable half of the tunnel")
  -- Column 98 stopped above the block; columns beside it were still mined.
  assert(sim.blocks[lkey({x=98,y=56,z=-54})],"mined below a blocked shaft")
  for _,x in ipairs({97,99}) do
    for y=a.low,a.y-1 do
      if tunnel(x,y) then assert(not sim.blocks[lkey({x=x,y=y,z=-54})],"column "..x.." beside the blocked shaft was skipped") end
    end
  end
  local logs=table.concat(sim.prints,"\n")
  assert(logs:find("Tunnel stops at X 100, Y 55, Z -56",1,true) and logs:find("Shaft at X 98 stops at Y 59",1,true),logs)
end)

test("a staircase blocked by spawn protection or a claim explains why",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  sim.refuse[lkey({x=100,y=64,z=stairZ(3,4)})]="Cannot break protected block"
  local ok,why=pcall(api.row.enter,a)
  assert(not ok and tostring(why):find("spawn protection or a land claim",1,true),tostring(why))
end)

test("an update mid-job reboots between two steps and the job carries on",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  local source=assert(io.open("turtle/minerdash.lua")):read("a")
  sim.httpGet=function() return {readAll=function() return source end,close=function() end} end
  local asked=false
  sim.afterSave=function()
    local job=api.state().fleetJob
    if not asked and job and job.step>=20 then
      asked=true
      api.message({type="cmd",action="update"})
    end
  end
  sim.onReboot=function() coroutine.yield("reboot") end
  local run=coroutine.create(function() api.command({action="fleetJob",args=a}) end)
  local ok,res=coroutine.resume(run)
  assert(ok and res=="reboot","did not reboot for the update: "..tostring(res))
  assert(files["minerdash.lua"]==source,"the downloaded script was not saved")
  local saved=assert(load("return "..files[".minerdash_state"],"state","t",{}))()
  assert(saved.fleetJob and not saved.fleetJob.paused and not saved.fleetJob.failed,"startup would not resume the job")
  assert(not saved.miningRoute.pendingMove,"rebooted in the middle of a move")
  assert(saved.fleetJob.step>=20)
  -- Boot again where the turtle physically is, and resume as startup does.
  local api2,sim2=miner(files)
  for _,field in ipairs({"blocks","refuse","slots","items","fuel","fuelLimit","selected","chests","deposits"}) do sim2[field]=sim[field] end
  sim2.pos,sim2.heading={x=sim.pos.x,y=sim.pos.y,z=sim.pos.z},sim.heading
  api2.config(fleetConfig())
  api2.fix(api2.state().pos,api2.state().world)
  api2.lease("granted")
  sim2.beforeMove=function()
    local route=api2.state().miningRoute
    if route and route.phase=="toDepot" then api2.lease("granted") end
  end
  api2.command({action="resume"})
  finished(api2,a)
  for x=96,104 do
    for y=a.low,a.y-1 do
      if tunnel(x,y) then
        for z=-59,-51 do
          if inside(x,z,4) then assert(not sim2.blocks[lkey({x=x,y=y,z=z})],"tunnel block left at "..x..","..y..","..z) end
        end
      end
    end
  end
end)

test("an update reaches a turtle stuck waiting for a turn at the depot",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  local source=assert(io.open("turtle/minerdash.lua")):read("a")
  sim.httpGet=function() return {readAll=function() return source end,close=function() end} end
  -- Nobody ever gets the dock, and its cargo is full of valuables from the start.
  api.lease(nil)
  sim.beforeMove=nil
  for slot=1,15 do sim.items[slot],sim.slots[slot]="minecraft:diamond",64 end
  local waits=0
  sim.onPullEvent=function()
    waits=waits+1
    if waits==3 then api.message({type="cmd",action="update"}) end
    assert(waits<50,"never updated while waiting for the dock")
  end
  sim.onReboot=function() coroutine.yield("reboot") end
  local run=coroutine.create(function() api.command({action="fleetJob",args=a}) end)
  local ok,res=coroutine.resume(run)
  assert(ok and res=="reboot","did not reboot for the update: "..tostring(res))
  local saved=assert(load("return "..files[".minerdash_state"],"state","t",{}))()
  assert(saved.fleetJob and not saved.fleetJob.paused and not saved.fleetJob.failed,"startup would not resume the job")
  assert(saved.miningRoute.phase=="toDepot" and not saved.holding,"rebooted somewhere other than the dock queue")
end)

local function stoppedDeep()
  local api,sim,files,a=setup(4,60,56,96,104)
  local stopped=false
  sim.afterSave=function()
    local w=api.state().world
    if not stopped and w and w.y<a.y-3 and w.z>-53 then
      stopped=true
      api.message({type="cmd",action="stop"})
    end
  end
  api.command({action="fleetJob",args=a})
  assert(stopped,"never reached a deep tunnel")
  sim.afterSave=nil
  sim.items[1],sim.slots[1]="minecraft:diamond",3
  return api,sim,files,a
end

test("go home goes straight home with its cargo when it has the fuel",function()
  local api,sim,files,a=stoppedDeep()
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(next(sim.deposits)==nil,"called at the depot on the way home")
  assert(sim.items[1]=="minecraft:diamond" and sim.slots[1]==3,"lost its cargo")
end)

test("go home calls at the depot first when it hasn't the fuel to get home",function()
  local api,sim,files,a=stoppedDeep()
  sim.fuel=30
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(sim.fuel>=10000,"did not refuel at the depot")
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==3,"did not unload at the depot")
end)

test("a dock turn saved away from the dock is dropped on boot",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  api.lease("granted")
  api.save()
  local api2=miner(files)
  assert(api2.leases().depot==nil,"kept a dock turn at home")
end)

test("junk is dropped in the tunnel instead of filling the cargo, and never reaches the dock",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  local filled,visits=false,0
  sim.afterSave=function()
    local job=api.state().fleetJob
    if not filled and job and job.step>=10 then
      filled=true
      for slot=1,13 do sim.items[slot],sim.slots[slot]="minecraft:deepslate",64 end
      sim.items[14],sim.slots[14]="minecraft:diamond",5
    end
  end
  local before=sim.beforeMove
  sim.beforeMove=function(target,direction)
    if key(target)=="-8,0,0" then visits=visits+1 end
    before(target,direction)
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(filled)
  assert(visits==1,"made "..visits.." dock visits; junk should not need one")
  assert(sim.worldDrops["minecraft:deepslate"]==13*64,"did not drop its junk underground")
  assert(not (sim.deposits["-8,-1,0"] or {})["minecraft:deepslate"],"carried junk to the dock")
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==5,"lost its treasure")
end)

test("junk is dropped once it fills two slots, even with plenty of room left",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  local stage,dropped,kept=0,nil,nil
  sim.afterSave=function()
    local job=api.state().fleetJob
    if not job then return end
    if stage==0 and job.step>=5 then
      stage=1
      sim.items[1],sim.slots[1]="minecraft:deepslate",30
    elseif stage==1 and job.step>=10 then
      stage=2
      kept=sim.slots[1]
      sim.items[2],sim.slots[2]="minecraft:tuff",20
      sim.items[3],sim.slots[3]="minecraft:diamond",2
    elseif stage==2 and job.step>=15 then
      stage=3
      dropped=(sim.slots[1] or 0)==0 and (sim.slots[2] or 0)==0
    end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(kept==30,"dropped a single partial stack of junk")
  assert(dropped,"carried two slots of junk")
  assert(sim.worldDrops["minecraft:deepslate"]==30 and sim.worldDrops["minecraft:tuff"]==20)
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==2,"lost its treasure")
end)

test("the way back out of a tunnel clears stone that lava and water formed in it",function()
  local api,sim,files,a=stoppedDeep()
  local w=api.state().world
  -- A block of the tunnel between the turtle and its shaft fills with stone.
  local between={x=w.x,y=w.y,z=w.z+(w.z>-55 and -1 or 1)}
  sim.blocks[lkey(between)]="minecraft:stone"
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(not sim.blocks[lkey(between)],"left the stone in its tunnel")
end)

test("each job counts the ore blocks it mines, and its receipt keeps the total",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  a.jobId="job-test"
  -- Ore beside two tunnels and in one tunnel block itself.
  sim.blocks[lkey({x=101,y=58,z=-54})]="minecraft:deepslate_diamond_ore"
  sim.blocks[lkey({x=101,y=58,z=-53})]="minecraft:deepslate_diamond_ore"
  sim.blocks[lkey({x=100,y=60,z=-56})]="minecraft:redstone_ore"
  assert(tunnel(100,60))
  local seen
  sim.afterSave=function()
    local job=api.state().fleetJob
    if job and job.ores then seen=job.ores end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  local receipt=api.state().lastFleetResult
  assert(receipt.jobId=="job-test","the receipt lost the job ID")
  assert(receipt.ores["minecraft:deepslate_diamond_ore"]==2 and receipt.ores["minecraft:redstone_ore"]==1,"ore counts were wrong")
  assert(seen and seen["minecraft:deepslate_diamond_ore"],"the running job did not count ore")
  assert(api.status().fleetJob==nil)
end)

test("a turtle joining a running job takes over columns, and between them they mine everything",function()
  local r=6
  local api,sim,files,a=setup(r,60,56,94,106)
  a.jobId="job-share"
  local stairs=function(home) return {x=home,y=a.y,z=stairZ(67-a.y,r)} end
  local box=function(west,east) return {x1=west-1,x2=east+1,y1=a.low-1,y2=a.y,z1=-55-r-1,z2=-55+r+1} end
  -- Early in pass 1, sweeping east at column 96: it keeps 94 to 100.
  local sent,shared=false,nil
  sim.afterSave=function()
    local st=api.status().fleetJob
    if not sent and st and st.at and st.at.pass==1 and st.at.x==96 then
      sent=true
      local update={}
      for key,value in pairs(st.args) do update[key]=value end
      update.first,update.last,update.x,update.veinBounds=94,100,94,box(94,100)
      update.done={pass=1,cols={{94,95}}}
      api.message({type="cmd",action="jobUpdate",args=update})
    end
    local job=api.state().fleetJob
    if sent and not shared and job and job.args.last==100 then shared=job.args.first end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(sent and shared==94,"never switched to its narrower columns")
  assert(table.concat(sim.prints,"\n"):find("now mining columns X 94 to 100",1,true))
  -- The helper, at home on X 101, shares the same world.
  local state=assert(load("return {pos={x=-1,y=0,z=0},heading=0}"))()
  local helperFiles={[".minerdash_state"]=common.serialize(state)}
  local api2,sim2=miner(helperFiles)
  for _,field in ipairs({"blocks","refuse","chests","deposits","worldDrops"}) do sim2[field]=sim[field] end
  sim2.pos,sim2.heading={x=-1,y=0,z=0},0
  api2.config(fleetConfig())
  api2.fix({x=-1,y=0,z=0},{x=101,y=67,z=-55})
  api2.lease("granted")
  sim2.beforeMove=function()
    local route=api2.state().miningRoute
    if route and route.phase=="toDepot" then api2.lease("granted") end
  end
  local b={}
  for key,value in pairs(a) do b[key]=value end
  b.routeHome,b.stairBottom={x=101,y=67,z=-55,facing="south"},stairs(101)
  b.first,b.last,b.x,b.veinBounds,b.queueId=101,106,101,box(101,106),"helper"
  b.done={pass=1,cols={}}
  api2.command({action="fleetJob",args=b})
  local state2=api2.state()
  assert(not state2.fleetJob,"helper stopped: "..tostring(state2.fleetJob and state2.fleetJob.failed))
  same(state2.world,b.routeHome)
  for x=94,106 do
    local home=x<=100 and 100 or 101
    for y=a.low,a.y-1 do
      if tunnel(x,y) then
        local h=math.floor(math.sqrt(r*r-(x-home)^2))
        for z=-55-h,-55+h do assert(not sim.blocks[lkey({x=x,y=y,z=z})],"tunnel block left at "..x..","..y..","..z) end
      end
    end
  end
end)

test("a block still there after digging is skipped like a protected one, in tunnels and veins",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  -- Zinc ore a mod keeps putting back: one in a tunnel, one beside a tunnel.
  local inTunnel={x=100,y=60,z=-57}
  local beside={x=101,y=58,z=-54}
  -- The second sits on top of the tunnel at (101, 57).
  assert(tunnel(100,60) and tunnel(101,57) and not tunnel(101,58))
  for _,w in ipairs({inTunnel,beside}) do
    sim.blocks[lkey(w)]="create:deepslate_zinc_ore"
    sim.sticky[lkey(w)]=true
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(sim.blocks[lkey(inTunnel)] and sim.blocks[lkey(beside)])
  local logs=table.concat(sim.prints,"\n")
  assert(logs:find("Tunnel stops at X 100, Y 60, Z -56",1,true),logs)
  assert(not sim.blocks[lkey({x=100,y=60,z=-54})],"skipped the reachable half of that tunnel")
end)

test("stacks of the same item split across slots are merged before the next step",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  local split=false
  sim.afterSave=function()
    local job=api.state().fleetJob
    if not split and job and job.step>=5 then
      split=true
      sim.items[3],sim.slots[3]="minecraft:diamond",2
      sim.items[7],sim.slots[7]="minecraft:diamond",4
      sim.items[9],sim.slots[9]="minecraft:emerald_ore",60
      sim.items[12],sim.slots[12]="minecraft:emerald_ore",10
    elseif split and job and job.step==10 then
      local diamonds,redstone={},{}
      for slot=1,16 do
        if sim.items[slot]=="minecraft:diamond" then diamonds[#diamonds+1]=sim.slots[slot] end
        if sim.items[slot]=="minecraft:emerald_ore" then redstone[#redstone+1]=sim.slots[slot] end
      end
      assert(#diamonds==1 and diamonds[1]==6,"diamonds still split")
      assert(#redstone==2 and redstone[1]==64 and redstone[2]==6,"emerald ore not merged into a full stack")
    end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(split)
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==6)
end)

test("a turtle in the way is waited for however long it takes, instead of stopping the job",function()
  local api,sim,files,a=setup(4,60,58,96,104)
  local cell=lkey({x=100,y=60,z=-57})
  assert(tunnel(100,60))
  sim.blocks[cell]="computercraft:turtle_normal"
  local waits,shown=0,false
  sim.onSleep=function()
    if sim.blocks[cell]=="computercraft:turtle_normal" then
      waits=waits+1
      local job=api.status().job
      shown=shown or (job and job.detail=="Waiting for another turtle to move")
      if waits>=180 then sim.blocks[cell]=nil end
    end
  end
  api.command({action="fleetJob",args=a})
  finished(api,a)
  assert(waits>=180,"never had to wait")
  assert(shown,"the wait wasn't shown")
end)

test("go home waits for a turtle on its stairs instead of giving up",function()
  local api,sim,files,a=stoppedDeep()
  local cell=lkey({x=100,y=67-2,z=stairZ(2,4)})
  sim.blocks[cell]="computercraft:turtle_normal"
  local waits=0
  sim.onSleep=function()
    if sim.blocks[cell] then
      waits=waits+1
      if waits>=180 then sim.blocks[cell]=nil end
    end
  end
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(waits>=180,"never had to wait")
end)

test("go home drops junk before leaving the mine and keeps its treasure",function()
  local api,sim,files,a=stoppedDeep()
  sim.items[2],sim.slots[2]="minecraft:cobblestone",40
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(sim.worldDrops["minecraft:cobblestone"]==40,"brought junk home")
  assert(sim.items[1]=="minecraft:diamond" and sim.slots[1]==3,"lost its treasure")
end)

-- Where the simulated turtle really is, and GPS that always reports it.
local function real(p) return {x=HOME.x-p.x,y=HOME.y+p.y,z=HOME.z+p.z} end
local function goodGps(api,sim)
  sim.gps=function() local w=real(sim.pos); return w.x,w.y,w.z end
  sim.onSleep=function() api.fix(api.state().pos,real(sim.pos)) end
end
-- Fills its 6 sides with stone, except those given (local cells) as open.
local function boxIn(sim,open)
  local p=sim.pos
  for _,d in ipairs({{1,0,0},{-1,0,0},{0,0,1},{0,0,-1},{0,1,0},{0,-1,0}}) do
    sim.blocks[key({x=p.x+d[1],y=p.y+d[2],z=p.z+d[3]})]="minecraft:stone"
  end
  for _,c in ipairs(open or {}) do sim.blocks[key(c)]=nil end
end

test("a turtle whose facing is unsure steps into open space and back to find it, then goes home",function()
  local api,sim,files,a=stoppedDeep()
  api.loseFacing()
  assert(not api.trusted())
  goodGps(api,sim)
  local digs=sim.digs
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(sim.digs==digs,"dug to find its facing")
end)

test("with open space only above it, it steps up, finds its facing beside that, and comes back down",function()
  local api,sim,files,a=stoppedDeep()
  api.loseFacing()
  goodGps(api,sim)
  local p=sim.pos
  local start={x=p.x,y=p.y,z=p.z}
  local above={x=p.x,y=p.y+1,z=p.z}
  boxIn(sim,{above})
  sim.pos=above
  boxIn(sim,{start,{x=p.x+1,y=p.y+1,z=p.z}})
  sim.pos=start
  local digs,moves=sim.digs,#sim.history
  api.row.findFacing()
  assert(api.trusted(),"facing still unsure")
  same(sim.pos,start)
  assert(sim.digs==digs,"dug to find its facing")
  for i=moves+1,#sim.history do assert(sim.history[i].y<=start.y+1,"went more than one block up") end
end)

test("at the bottom of a shaft it climbs the open space to the first side opening, then comes back down",function()
  local api,sim,files,a=stoppedDeep()
  api.loseFacing()
  goodGps(api,sim)
  local p=sim.pos
  local start={x=p.x,y=p.y,z=p.z}
  -- Open for 3 blocks above, closed on every side until the third.
  boxIn(sim,{{x=p.x,y=p.y+1,z=p.z}})
  for i=1,3 do
    sim.pos={x=start.x,y=start.y+i,z=start.z}
    local open={{x=start.x,y=start.y+i-1,z=start.z}}
    if i<3 then open[2]={x=start.x,y=start.y+i+1,z=start.z} else open[2]={x=start.x,y=start.y+i,z=start.z+1} end
    boxIn(sim,open)
  end
  sim.pos=start
  local digs,moves=sim.digs,#sim.history
  api.row.findFacing()
  assert(api.trusted(),"facing still unsure")
  same(sim.pos,start)
  assert(sim.digs==digs,"dug to find its facing")
  local top=start.y
  for i=moves+1,#sim.history do top=math.max(top,sim.history[i].y) end
  assert(top==start.y+3,"climbed to "..top.." instead of the opening 3 up")
end)

test("sand or gravel beside it is dug to step in only when none of the 4 blocks around it is protected",function()
  for _,guarded in ipairs({false,true}) do
    local api,sim,files,a=stoppedDeep()
    -- One block north along the tunnel, so all 4 blocks around it are
    -- inside the radius.
    while sim.heading~=2 do api.command({action="turnRight"}) end
    local before=sim.pos
    api.command({action="forward"})
    assert(sim.pos~=before,"didn't move north")
    api.loseFacing()
    goodGps(api,sim)
    local p=sim.pos
    local start={x=p.x,y=p.y,z=p.z}
    boxIn(sim)
    sim.blocks[key({x=p.x+1,y=p.y,z=p.z})]="minecraft:gravel"
    if guarded then
      -- Only the block on the far side is protected, but it can't tell
      -- which side is which without its facing.
      local w=real({x=p.x-1,y=p.y,z=p.z})
      api.protection({{name="base",x1=w.x,x2=w.x,y1=w.y,y2=w.y,z1=w.z,z2=w.z}})
    end
    local digs=sim.digs
    api.row.findFacing()
    same(sim.pos,start)
    if guarded then
      assert(not api.trusted(),"settled its facing without moving")
      assert(sim.digs==digs,"dug beside a protected block")
    else
      assert(api.trusted(),"facing still unsure")
      assert(sim.digs==digs+1,"didn't dig just the gravel")
    end
  end
end)

test("it never goes above its home row to find its facing",function()
  local api,sim,files,a=stoppedDeep()
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  api.loseFacing()
  goodGps(api,sim)
  local p=sim.pos
  boxIn(sim,{{x=p.x,y=p.y+1,z=p.z}})
  local moves=#sim.history
  api.row.findFacing()
  assert(#sim.history==moves,"moved with only open space above its home row")
  assert(not api.trusted())
end)

test("a move button pressed while its facing is unsure finds the facing first, then moves",function()
  local api,sim,files,a=stoppedDeep()
  api.loseFacing()
  goodGps(api,sim)
  local p=sim.pos
  local start={x=p.x,y=p.y,z=p.z}
  api.command({action="forward"})
  assert(api.trusted(),"facing still unsure")
  local moved=math.abs(sim.pos.x-start.x)+math.abs(sim.pos.z-start.z)
  assert(moved==1 and sim.pos.y==start.y,"didn't move one block")
end)

-- Stopped deep, then dug by hand below its lowest tunnel level (55), where
-- nothing is its saved route.
local function offRoute()
  local api,sim,files,a=stoppedDeep()
  for _=1,4 do api.command({action="down",args={dig=true}}) end
  local w=api.state().world
  assert(w.y==54,"didn't get below its tunnels: "..tostring(w.y))
  return api,sim,files,a
end
local function homeArea(y1)
  return {name="Home",x1=-2500,x2=2500,y1=y1,y2=320,z1=-2500,z2=2500}
end

test("a turtle off its route below the Home protected area digs back to its shaft and goes home",function()
  local api,sim,files,a=offRoute()
  api.protection({homeArea(64)})
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  local said=false
  for _,line in ipairs(sim.prints) do if line:find("digging back to its shaft",1,true) then said=true end end
  assert(said,"didn't say it was digging back")
end)

test("an off-route turtle at or above the Home floor, or with no Home area, stays where it is",function()
  for _,areas in ipairs({{homeArea(50)},{},{{name="Base",x1=-2500,x2=2500,y1=64,y2=320,z1=-2500,z2=2500}}}) do
    local api,sim,files,a=offRoute()
    api.protection(areas)
    local p,digs=sim.pos,sim.digs
    api.command({action="goHome"})
    same(sim.pos,p)
    assert(sim.digs==digs,"dug without a Home area below it")
  end
end)

test("rock blocking its saved way back is dug through only below the Home protected area",function()
  for _,guarded in ipairs({true,false}) do
    local api,sim,files,a=stoppedDeep()
    -- On its way along the tunnel to the shaft.
    local cell=lkey({x=99,y=58,z=-53})
    sim.blocks[cell]="minecraft:deepslate"
    api.protection(guarded and {homeArea(64)} or {})
    local p=sim.pos
    api.command({action="goHome"})
    if guarded then
      same(api.state().world,a.routeHome)
      assert(sim.blocks[cell]==nil,"didn't dig the rock")
    else
      same(sim.pos,p)
      assert(sim.blocks[cell]=="minecraft:deepslate","dug a new route with no Home area below it")
    end
  end
end)

test("rock that comes back after digging stops it after three tries, with one log line",function()
  local api,sim,files,a=stoppedDeep()
  local cell=lkey({x=99,y=58,z=-53})
  sim.blocks[cell]="minecraft:deepslate"
  sim.sticky[cell]=true
  api.protection({homeArea(64)})
  local p,digs=sim.pos,sim.digs
  api.command({action="goHome"})
  same(sim.pos,p)
  assert(sim.digs==digs+3,"dug it "..(sim.digs-digs).." times")
  local said,stopped=0,false
  for _,line in ipairs(sim.prints) do
    if line:find("digging through",1,true) then said=said+1 end
    if line:find("still there after digging",1,true) then stopped=true end
  end
  assert(said==1,"logged digging through "..said.." times")
  assert(stopped,"didn't say the block keeps coming back")
end)

test("unload sends a turtle at home to drop everything off at the depot, then back home",function()
  local api,sim,files,a=stoppedDeep()
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(next(sim.deposits)==nil)
  api.command({action="unload"})
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==3,"didn't unload at the depot")
  same(api.state().world,a.routeHome)
end)

test("unload from a stopped job deep in the mine drops off, comes home, and leaves the job paused",function()
  local api,sim,files,a=stoppedDeep()
  api.command({action="unload"})
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]==3,"didn't unload at the depot")
  same(api.state().world,a.routeHome)
  local job=api.state().fleetJob
  assert(job and job.paused,"lost its paused job")
end)

test("unload asked for mid-job goes to the depot before the next step and carries on with the job",function()
  local api,sim,files,a=setup(4,60,56,96,104)
  -- Left alone, this job's first depot visit is at step 70.
  local asked,visitedAt
  sim.afterSave=function()
    local state=api.state()
    local w,route,job=state.world,state.miningRoute,state.fleetJob
    if not asked and w and w.y<a.y-3 and job and job.step>=5 then
      asked=job.step
      sim.items[16],sim.slots[16]="minecraft:diamond",2
      api.message({type="cmd",action="unload"})
    end
    if asked and not visitedAt and route and route.phase=="toDepot" and job then visitedAt=job.step end
  end
  api.command({action="fleetJob",args=a})
  sim.afterSave=nil
  assert(asked,"never reached a deep tunnel")
  assert(visitedAt and visitedAt<=asked+1,"went to the depot at step "..tostring(visitedAt).." after being asked at step "..asked)
  assert(sim.deposits["-8,0,-1"]["minecraft:diamond"]>=2,"didn't unload at the depot")
  finished(api,a)
end)

test("outside its radius below the Home area it may only step back toward the circle",function()
  local api,sim,files,a=stoppedDeep()
  local row=api.row
  api.protection({homeArea(64)})
  -- Radius 4 around (100, -55).
  assert(row.mayReach({x=100,y=50,z=-61},{x=100,y=50,z=-60}),"refused a step back toward the circle")
  assert(not row.mayReach({x=100,y=50,z=-61},{x=100,y=50,z=-62}),"allowed a step further out")
  assert(not row.mayReach({x=100,y=50,z=-61},{x=100,y=49,z=-61}),"allowed a step down outside the circle")
  assert(not row.mayReach({x=100,y=64,z=-61},{x=100,y=64,z=-60}),"allowed it at the Home floor")
  api.protection({})
  assert(not row.mayReach({x=100,y=50,z=-61},{x=100,y=50,z=-60}),"allowed it with no Home area")
end)

test("a turtle outside its radius below the Home area comes back into the circle and goes home",function()
  for _,guarded in ipairs({true,false}) do
    local api,sim,files,a=stoppedDeep()
    api.protection(guarded and {homeArea(64)} or {})
    -- At (99, 58, -52), outside a radius of 2. Once back in that circle,
    -- the real radius (4) returns for the stairs it dug.
    local route=api.state().miningRoute
    route.radius=2
    sim.afterSave=function()
      local w=api.state().world
      if w and (w.x-100)^2+(w.z+55)^2<=4 then route.radius=4 end
    end
    local p=sim.pos
    api.command({action="goHome"})
    sim.afterSave=nil
    if guarded then
      same(api.state().world,a.routeHome)
    else
      same(sim.pos,p)
    end
  end
end)

test("a move cut short that GPS never settled is fixed by stepping aside and back, then it goes home",function()
  local api,sim,files,a=stoppedDeep()
  goodGps(api,sim)
  -- Left over from a reboot, matching neither where it is nor next to it.
  api.state().miningRoute.pendingMove={from={x=0,y=0,z=0},to={x=0,y=0,z=1}}
  api.save()
  local moves=#sim.history
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  assert(not api.state().miningRoute.pendingMove,"still has the cut-short move")
  assert(#sim.history>moves)
  local said=false
  for _,line in ipairs(sim.prints) do if line:find("move was cut short",1,true) then said=true end end
  assert(said,"didn't say it was settling a cut-short move")
end)

test("outside its radius in a shaft, or at the corridor level, it walks back into the circle first",function()
  -- Local heading for each compass direction: +Z local is south, +X west.
  local H={east=3,west=1,south=0,north=2}
  local function go(api,sim,dir,n)
    for _=1,n do
      if dir=="up" or dir=="down" then api.command({action=dir,args={dig=true}})
      else
        while sim.heading~=H[dir] do api.command({action="turnRight"}) end
        api.command({action="forward",args={dig=true}})
      end
    end
  end
  -- From (99, 58, -52) to X 103 on the shafts' row, then up to the given Y.
  for _,up in ipairs({0,3,4}) do
    local api,sim,files,a=stoppedDeep()
    go(api,sim,"north",3)
    go(api,sim,"east",4)
    go(api,sim,"up",up)
    local w=api.state().world
    assert(w.x==103 and w.z==-55 and w.y==58+up)
    api.protection({homeArea(64)})
    -- Outside a radius of 2; the real one (4) returns once it's back inside.
    local route=api.state().miningRoute
    route.radius=2
    sim.afterSave=function()
      local v=api.state().world
      if v and (v.x-100)^2+(v.z+55)^2<=4 then route.radius=4 end
    end
    api.command({action="goHome"})
    sim.afterSave=nil
    same(api.state().world,a.routeHome)
  end
end)

test("a Nether turtle uses the Nether's depot and protected areas, and switching forgets its saved home",function()
  local api,sim,files,a=stoppedDeep()
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  local settings=fleetConfig()
  settings.protect.areas={homeArea(45)}
  settings.dimensions={nether={depot={x=8,y=67,z=-50,junk="down",valuables="north",fuel="west"},areas={homeArea(100)}}}
  api.config(settings)
  assert(api.row.homeFloor()==45 and api.currentDepot().x==108)
  -- The same dimension changes nothing.
  api.command({action="setDimension",args={dimension="overworld"}})
  assert(api.state().miningRoute,"forgot its route switching to the dimension it was in")
  api.command({action="setDimension",args={dimension="nether"}})
  assert(api.dimension()=="nether")
  assert(api.row.homeFloor()==100,"still uses the Overworld's protected areas")
  assert(api.currentDepot().x==8,"still uses the Overworld's depot")
  local state=api.state()
  assert(not state.miningRoute and not state.fleetJob,"kept its Overworld home or job")
  -- It stays a Nether turtle after a reboot.
  local again=miner(files)
  assert(again.dimension()=="nether","forgot its dimension after a reboot")
end)

test("a turtle put back on the home row by hand walks along the surface to its own home",function()
  local api,sim,files,a=stoppedDeep()
  api.command({action="goHome"})
  same(api.state().world,a.routeHome)
  api.protection({homeArea(45)})
  -- Into the next turtle's slot, as if carried there with its saved phase
  -- still underground.
  while sim.heading~=1 do api.command({action="turnRight"}) end
  api.command({action="forward"})
  same(api.state().world,{x=99,y=67,z=-55})
  local route=api.state().miningRoute
  route.phase,route.intent="work","home"
  api.save()
  local digs=sim.digs
  api.command({action="recoverRoute"})
  same(api.state().world,a.routeHome)
  assert(sim.digs==digs,"dug on the surface")
end)

assert(#failures==0,table.concat(failures,"\n"))
print("Passed "..count.." staggered scenarios")
