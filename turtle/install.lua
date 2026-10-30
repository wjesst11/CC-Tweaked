-- MinerDash installer disk.
--
-- Make the disk once, on any computer or turtle next to a disk drive:
--   wget __HTTP_URL__/install.lua disk/startup.lua
--   disk/startup.lua
-- It asks for the turtle token once and keeps it on the disk.
--
-- After that, any turtle that boots next to the drive installs MinerDash: it
-- equips a wireless/ender modem from its inventory, names itself if it has no
-- label, downloads the client and saves the token. Then pick it up, place it
-- where it should live and turn it on: wherever the client first runs becomes
-- the turtle's home. (Press Enter during install to start right there instead.)

local BASE = "__HTTP_URL__"
local dir = fs.getDir(shell.getRunningProgram())
local tokenFile = fs.combine(dir, "minerdash_token")

local token
if fs.exists(tokenFile) then
  local f = fs.open(tokenFile, "r")
  token = f.readAll()
  f.close()
else
  print("MinerDash installer disk setup")
  repeat
    write("Turtle token: ")
    token = read("*"):gsub("^%s+", ""):gsub("%s+$", "")
  until token ~= ""
  local f = fs.open(tokenFile, "w")
  f.write(token)
  f.close()
  print("Saved. Turtles that boot next to this drive will install themselves.")
end

if not turtle then
  print("This disk is ready. Put turtles next to the drive and turn them on.")
  return
end

-- Equip a wireless/ender modem from the inventory, keeping the pickaxe.
local function hasModem()
  return peripheral.find("modem", function(_, m) return m.isWireless() end) ~= nil
end

local function findItem(pattern)
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item and item.name:find(pattern) then return slot end
  end
end

if not hasModem() then
  local slot = findItem("modem")
  if slot then
    turtle.select(slot)
    turtle.equipRight()
    -- If the pickaxe was on the right, it's now in the inventory: put it on the left.
    local pick = findItem("pickaxe")
    if pick then
      turtle.select(pick)
      turtle.equipLeft()
    end
    turtle.select(1)
  end
  if not hasModem() then print("No wireless modem found: GPS and fleet jobs won't work.") end
end

-- A label keeps the turtle's files when it's picked up.
if not os.getComputerLabel() then os.setComputerLabel("Miner" .. os.getComputerID()) end

print("Downloading MinerDash...")
local res, err = http.get(BASE .. "/turtle.lua")
if not res then error("Download failed: " .. tostring(err), 0) end
local code = res.readAll()
res.close()
local f = fs.open("/startup.lua", "w")
f.write(code)
f.close()

-- The downloaded client already knows the server address; drop any old one.
settings.unset("minerdash.url")
settings.set("minerdash.token", token)
settings.save()
print("Installed on " .. os.getComputerLabel() .. ".")

-- A turtle that has run before keeps its home; just start it.
if fs.exists("/.minerdash_state") then
  shell.run("/startup.lua")
  return
end

print("Place me where I should live and turn me on: that spot becomes my home.")
print("Or press Enter to make this spot home and start now.")
local timer = os.startTimer(15)
while true do
  local event, a = os.pullEvent()
  if event == "key" and a == keys.enter then
    -- A disk startup replaces the turtle's own, so start the client directly.
    shell.run("/startup.lua")
    return
  elseif event == "timer" and a == timer then
    print("Shutting down. Pick me up and place me at my home.")
    sleep(2)
    os.shutdown()
  end
end
