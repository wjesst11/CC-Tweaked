-- Exercise ordinary navigation and ore scanning in the real turtle code.
-- Run from the repository root: lua test/turtle-routing.lua
local sim = dofile("test/turtle-sim.lua")
local miner, key, same = sim.miner, sim.key, sim.same

local count = 0
local function test(name, fn)
  local ok, err = pcall(fn)
  assert(ok, name .. ": " .. tostring(err))
  count = count+1
  print("ok " .. count .. " - " .. name)
end

test("ordinary navigation finds an open shortcut through a U-shaped visited space", function()
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

test("ordinary navigation backs down a straight corridor without turning", function()
  local api, sim = miner()
  for i=1,5 do api.move("forward") end
  api.returnHome()
  same(sim.pos,{x=0,y=0,z=0})
  assert(sim.turns==0 and sim.moves==10)
end)

test("ordinary navigation detours around protected blocks", function()
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

test("Create ores can be mined while every other Create block stays protected", function()
  local api, sim = miner()
  api.config({updatedAt=1, protect={blocks={"create:*","!create:*_ore"},areas={}}, items={valuables={},fuel={}}, veinBlocks={"*_ore"}})
  sim.blocks["0,0,1"]="create:deepslate_zinc_ore"
  assert(api.step({x=0,y=0,z=1,h=0}, true), "Create ore was protected")
  same(sim.pos,{x=0,y=0,z=1})
  sim.blocks["0,0,2"]="create:andesite_casing"
  local ok, why = api.step({x=0,y=0,z=2,h=0}, true)
  assert(not ok and why=="block" and sim.blocks["0,0,2"]=="create:andesite_casing", "a Create machine block was dug")
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
