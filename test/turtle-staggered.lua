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

local function setup(r,yTop,yBottom,first,last)
  local api,sim,files=miner()
  local A,low=yTop+2,math.max(yBottom-1,-59)
  api.config({
    depot={x=108,y=67,z=-55,junk="down",valuables="north",fuel="west"},refuelTo=10000,
    protect={blocks={"*chest*","*barrel*","create:*","!create:*_ore"},areas={}},
    items={valuables={"*diamond*","*_ore"},fuel={"minecraft:coal"}},veinBlocks={"*_ore"},
  })
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

assert(#failures==0,table.concat(failures,"\n"))
print("Passed "..count.." staggered scenarios")
