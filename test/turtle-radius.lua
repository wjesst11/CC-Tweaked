-- Exercise the actual home-centered excavation boundary, including recovery.
-- Run from the repository root: lua test/turtle-radius.lua
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
    depot={x=108,y=67,z=-55,junk="down",valuables="north",fuel="west"},refuelTo=10000,
    protect={blocks={"*chest*","*barrel*","create:*"},areas={}},
    items={valuables={"*diamond*"},fuel={"minecraft:coal"}},veinBlocks={"*_ore"},
  }
end

local function args(y, radius, laneX)
  local depth = 67-y
  return {
    kind="branchMine",routeMode="southRow",access="southStairs",entryY=67,
    routeHome={x=100,y=67,z=-55,facing="south"},
    stairBottom={x=100,y=y,z=-55+depth},
    x=laneX or 100,y=y,z=-55+depth,dir="south",radius=radius,band=0,
    coverage="allSides",scan=true,length=radius-depth+1,
    veinBounds={x1=100-radius,x2=100+radius,y1=y-1,y2=y+2,z1=-55-radius,z2=-55+radius},
  }
end

local function rowMiner(y, radius, laneX)
  local api, sim, files = miner()
  local a, f = args(y,radius,laneX), config()
  api.config(f)
  api.fix({x=0,y=0,z=0},{x=100,y=67,z=-55})
  return api,sim,files,a,f
end

local function decoded(text)
  return assert(load("return " .. text,"saved radius state","t",{}))()
end

local function reboot(files, physical, f)
  local saved=decoded(files[".minerdash_state"])
  local c=saved.calib
  local cx,cz={[0]=0,1,0,-1},{[0]=-1,0,1,0}
  local right=(c.f0+1)%4
  local dx,dz=physical.pos.x-c.l.x,physical.pos.z-c.l.z
  local world={
    x=c.w.x+dz*cx[c.f0]+dx*cx[right],
    y=c.w.y+physical.pos.y-c.l.y,
    z=c.w.z+dz*cz[c.f0]+dx*cz[right],
  }
  local api,sim=miner(files)
  for _,field in ipairs({"blocks","slots","items","fuel","fuelLimit","selected","chests","deposits"}) do
    sim[field]=physical[field]
  end
  sim.pos={x=physical.pos.x,y=physical.pos.y,z=physical.pos.z}
  sim.heading=physical.heading
  api.config(f)
  api.fix(api.state().pos,world)
  return api,sim
end

local function assertInside(history, radius, first)
  for i=first or 1,#history do
    local p=history[i]
    assert(p.x^2+p.z^2<=radius^2,"movement left the home circle at "..key(p))
  end
end

test("the home boundary is an infinite vertical cylinder with no Y term",function()
  local api,sim,files,a=rowMiner(67,2)
  api.row.ensure(a)
  for _,y in ipairs({-100000,0,100000}) do
    assert(api.row.inCircle({x=101,y=y,z=-54},a.routeHome,2),"height rejected an inside X/Z point")
    assert(api.row.withinRadius({x=102,y=y,z=-55}),"height changed the circle edge")
    assert(not api.row.inCircle({x=102,y=y,z=-53},a.routeHome,2),"height accepted an outside rectangle corner")
    assert(not api.row.withinRadius({x=102,y=y,z=-54}),"height accepted an outside X/Z point")
  end
end)

test("six-side ore exploration keeps circle-edge ore and rectangle corners intact",function()
  local api,sim,files,a=rowMiner(67,2)
  api.row.enter(a)
  local inside={"-1,0,0","-1,0,1","-2,0,0"}
  local outside={"-1,0,2","-2,0,2"}
  for _,cell in ipairs(inside) do sim.blocks[cell]="minecraft:diamond_ore" end
  for _,cell in ipairs(outside) do sim.blocks[cell]="minecraft:diamond_ore" end
  local heading=sim.heading
  assert(api.scan(a,{left=32,path={},full=function() return false end}))
  for _,cell in ipairs(inside) do assert(not sim.blocks[cell],"missed inside ore "..cell) end
  for _,cell in ipairs(outside) do assert(sim.blocks[cell],"mined outside ore "..cell) end
  same(sim.pos,{x=0,y=0,z=0})
  assert(sim.heading==heading)
  assertInside(sim.history,2)
end)

test("height does not change the own-home radius for floor and upper-wall ore",function()
  local api,sim,files,a=rowMiner(67,2)
  api.row.enter(a)
  local inside={"1,1,0","1,2,0","1,-1,0"}
  local outside={"2,1,1","2,2,1","2,-1,1"}
  sim.blocks["1,0,0"]="minecraft:diamond_ore"
  sim.blocks["1,1,1"]="minecraft:diamond_ore"
  sim.blocks["1,-1,1"]="minecraft:diamond_ore"
  for _,cell in ipairs(inside) do sim.blocks[cell]="minecraft:diamond_ore" end
  for _,cell in ipairs(outside) do sim.blocks[cell]="minecraft:diamond_ore" end
  assert(api.scan(a,{left=32,path={},full=function() return false end}))
  for _,cell in ipairs(inside) do assert(not sim.blocks[cell],"missed inside ore "..cell) end
  for _,cell in ipairs(outside) do assert(sim.blocks[cell],"mined outside vertical ore "..cell) end
  assertInside(sim.history,2)
end)

test("flat mining cannot walk or excavate outside the circle to bypass a protected block",function()
  for _,stone in ipairs({false,true}) do
    local api,sim,files,a=rowMiner(66,2)
    api.row.enter(a)
    assert(api.move("forward"))
    same(sim.pos,{x=0,y=-1,z=2})
    sim.blocks["0,-1,1"]="minecraft:chest"
    if stone then
      for x=-3,3 do for z=-3,3 do
        if x*x+z*z>4 then sim.blocks[x..",-1,"..z]="minecraft:stone" end
      end end
    end
    local beforeMoves,beforeDigs=sim.moves,sim.digs
    local ok=pcall(api.row.flatMine,{x=98,y=66,z=-55})
    assert(not ok,"returned around the protected block outside its circle")
    assert(sim.digs==beforeDigs,"dug an outside return detour")
    assert(sim.blocks["0,-1,1"]=="minecraft:chest")
    assertInside(sim.history,2,beforeMoves+1)
    assert(not pcall(api.jobs.forceHome),"Force Home bypassed the circle or protected return block")
    assert(sim.digs==beforeDigs and sim.blocks["0,-1,1"]=="minecraft:chest")
    assertInside(sim.history,2,beforeMoves+1)
  end
end)

test("initial descent outside the circle is rejected before the protected-area exception or air travel",function()
  for _,useStone in ipairs({false,true}) do
    local api,sim,files,a,f=rowMiner(64,2)
    f.protect.areas={{name="Initial area",x1=90,x2=110,y1=60,y2=70,z1=-60,z2=0}}
    api.config(f)
    if useStone then sim.blocks["0,0,1"]="minecraft:stone" end
    local ok,why=pcall(api.row.enter,a)
    assert(not ok and tostring(why):find("radius"),"accepted an unreachable staircase")
    assert(sim.moves==0 and sim.digs==0)
  end
  local api,sim,files,a=rowMiner(66,2,97)
  assert(not pcall(api.row.enter,a),"accepted a lane outside its own circle")
  assert(sim.moves==0 and sim.digs==0)
end)

test("radius validation requires an integer in the supported range",function()
  for _,radius in ipairs({0,-1,1.5,1025,"2",false}) do
    local api,sim,files,a=rowMiner(67,2)
    a.radius=radius
    assert(not pcall(api.row.ensure,a),"accepted invalid radius "..tostring(radius))
    assert(sim.moves==0 and sim.digs==0)
  end
  local api,sim,files,a=rowMiner(67,2)
  a.radius=nil
  assert(not pcall(api.row.ensure,a),"accepted a legacy job without radius")
end)

test("clearing a job and rebooting away from home preserves the original radius center",function()
  local api,sim,files,a,f=rowMiner(66,5)
  api.row.enter(a)
  for _=1,3 do assert(api.move("forward")) end
  same(api.state().world,{x=100,y=66,z=-51})
  api.actions.forgetJob()
  local recovered,physical=reboot(files,sim,f)
  same(recovered.state().miningRoute.home,a.routeHome)
  assert(recovered.state().miningRoute.radius==5)
  local before=physical.moves
  assert(not pcall(recovered.row.flatMine,{x=100,y=66,z=-49}),"recentered the radius on the away position")
  assert(physical.moves==before)
  recovered.row.flatMine({x=100,y=66,z=-50})
  same(recovered.state().world,{x=100,y=66,z=-50})
  assert(not recovered.move("forward"),"walked beyond the original circle after reboot")
  assertInside(physical.history,5)
end)

test("a later job may change radius only at the unchanged saved home",function()
  local api,sim,files,a=rowMiner(66,3)
  api.row.enter(a)
  a.radius=4
  assert(not pcall(api.row.ensure,a),"changed radius away from home")
  assert(api.state().miningRoute.radius==3)
  api.row.exit()
  api.row.ensure(a)
  same(api.state().miningRoute.home,a.routeHome)
  assert(api.state().miningRoute.radius==4)
end)

test("shared depot travel may leave the circle only on the Y67 surface and cannot excavate outside it",function()
  local api,sim,files,a,f=rowMiner(66,2)
  api.row.enter(a)
  sim.blocks["-8,-1,0"]="minecraft:chest"
  sim.blocks["-8,0,-1"]="minecraft:chest"
  sim.blocks["-7,0,0"]="minecraft:chest"
  sim.chests["-7,0,0"]={name="minecraft:coal",count=200}
  sim.slots[1],sim.items[1]=3,"minecraft:cobblestone"
  api.lease("granted")
  local beforeDigs=sim.digs
  api.depotVisit(0)
  local leftCircle,visitedDock=false,false
  for _,p in ipairs(sim.history) do
    if p.x^2+p.z^2>4 then
      leftCircle=true
      assert(p.y==0,"depot route left the circle below Y67")
    end
    if p.x==-8 and p.y==0 and p.z==0 then visitedDock=true end
  end
  assert(leftCircle and visitedDock,"did not visit the outside shared depot")
  assert(sim.digs==beforeDigs,"dug during the outside-circle depot journey")
  assert(sim.deposits["-8,-1,0"]["minecraft:cobblestone"]==3)
  same(api.state().world,a.routeHome)
  same(api.state().miningRoute.home,a.routeHome)
  assert(api.state().miningRoute.radius==2)
  -- This cell was visited during the depot journey. Even the ordinary
  -- fallen-block travel exception must not excavate it outside the cylinder.
  api.face(3)
  assert(api.move("forward") and api.move("forward"))
  sim.blocks["-3,0,0"]="minecraft:sand"
  local dug=sim.digs
  assert(not api.step({x=-3,y=0,z=0,h=3}),"cleared fallen sand outside the mining radius")
  assert(sim.blocks["-3,0,0"]=="minecraft:sand" and sim.digs==dug)
  sim.blocks["-3,0,0"]=nil
  assert(api.move("forward"),"flat surface travel outside the cylinder was blocked")
  local surface=api.state().world
  assert(not api.move("down") and not api.move("up"),"surface-phase travel escaped the Y67 plane outside the cylinder")
  same(api.state().world,surface)
end)

print("Passed " .. count .. " home-radius scenarios")
