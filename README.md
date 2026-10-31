# MinerDash

A web dashboard for running a fleet of CC:Tweaked mining turtles, deployed on DigitalOcean App Platform.

- **South-row mining.** Each turtle keeps its own home at its actual X, **Y 67, Z -55**, facing **south**. It opens a diagonal stair to the mining level, then joins automatically spaced parallel lanes with one block between them. All excavation stays inside its home-centered mining cylinder, whose radius depends only on X/Z.
- **Automatic job queue.** Line up mining areas and quarries. Each starts when its selected turtles are ready, after rechecking protection. Assignment receipts prevent duplicate work when connections drop.
- **3D map.** A map of the world you can spin and zoom, showing every turtle, the depot, protected areas, job areas and every block the fleet has mined, colored by what it was.
- **Automatic servicing.** Fuel reserves cover the staircase, the mining corridor, the shared depot trip, and vein continuation. Low fuel or inventory space triggers an unload/refuel trip before work resumes.
- **A shared depot.** Every turtle unloads at the same dock with three chests: junk, valuables and fuel. Items are sorted by name patterns you choose. Turtles refuel from the fuel chest and deposit the coal they mine into it.
- **No collisions.** Turtles take the quickest open route, and the server shares where every turtle is and where it's about to move, so they steer around each other. The lower ID has right of way, and turtles standing still are treated as obstacles. One turtle at a time uses the dock while the others wait a few blocks away. A turtle never digs another one.
- **Defined return route.** A mining turtle returns at its safe mining Y to its own saved stair bottom, climbs the exact opened stairs, and reaches its own home. Depot travel stays flat at **Y 67**.
- **Few turns.** A turn takes as long as a move, so routes run straight rather than zig-zag. Turtles also check ore veins and sort at the dock in the order that needs the fewest turns.
- **Saved route progress.** Own home, stair progress, the reached stair bottom, and travel phase survive jobs and reboots. Returns use that specific route, without a general breadcrumb journal or a route-memory limit.
- **Protection.** Chests, barrels, shulker boxes, hoppers, Create blocks, ComputerCraft blocks, and configured protected blocks are never excavated. Protected areas have one narrow exception: initial excavation of a turtle's new stair cells. Normal mining, return corridors, later stair travel, and Force home keep area protection enabled.
- **Pause, Resume, Cancel.** Pause freezes a turtle in place. Cancel stops the job and sends it home. **Pause all**, **Resume all** and **Recall all** act on the whole fleet.
- **Permanent row homes.** The first new row job captures each turtle's own home. Starting a later job never replaces it with the turtle's current position.
- **Built for big fleets.** It has search and status filters, a fleet map of turtles, depot, protected areas and job areas, an **Update all scripts** button, and an installer disk for setting up many turtles.
- **GPS.** World coordinates and compass facing for turtles with a wireless or ender modem. Turtles resume their jobs by themselves after a reboot or chunk reload.

```
turtles (Lua) ──wss──▶  server.js (Node, App Platform)  ◀──wss── browser dashboard
```

## Deploy to DigitalOcean App Platform

1. Push this repo to GitHub.
2. Generate two secrets, for example with `openssl rand -base64 24`:
   - `DASHBOARD_PASSWORD`: what you type to sign in to the dashboard
   - `TURTLE_TOKEN`: what each turtle uses to connect
3. In the DigitalOcean control panel, go to **Create → App Platform**, pick the GitHub repo and the `main` branch. It detects Node.js and runs `npm start`.
4. Under **Environment Variables**, add `DASHBOARD_PASSWORD` and `TURTLE_TOKEN` and tick **Encrypt** for both.
5. Keep it at **1 container**. Turtle connections and the dock queue live in memory, so they can't be split across instances. The smallest size is plenty.
6. Deploy, then open `https://<your-app>.ondigitalocean.app`.

If you use `doctl`, you can create the app from the included spec with `doctl apps create --spec .do/app.yaml` and then set the two secrets in the app's settings. Edit `repo:` in the spec first if your GitHub repo has a different name.

Every push to `main` redeploys. Turtles and open dashboards reconnect on their own. Fleet settings survive redeploys because every turtle keeps a copy and hands it back.

## Set up turtles

Use script **2.1.1** on every mining turtle. Each needs an equipped pickaxe, an equipped wireless or ender modem, starting fuel, and a working GPS network with four host computers running `gps host`.

Set up the home row before starting a level job:

1. Place each turtle at its own X coordinate, **Y 67, Z -55**.
2. Face every turtle **south**, toward increasing Z. Leave room above the row and room for their stairs to extend south.
3. Put coal or charcoal in each turtle. Select its fuel slot on the dashboard and click **Refuel from slot**; the client also consumes inventory fuel while idle.
4. Wait for a GPS position. At this known row position, the new row job can establish the supplied south facing without a calibration move.

Homes may have different X coordinates. The underground lanes are assembled separately at the mining level; there is no need to turn every surface home into a shared dock.

**With the installer disk (fastest for many turtles):**

1. Put a floppy in a disk drive. On a computer next to it, run:
   ```
   wget https://<your-app>.ondigitalocean.app/install.lua disk/startup.lua
   disk/startup.lua
   ```
   Paste your `TURTLE_TOKEN` once. It's saved on the disk.
2. Place a turtle next to the drive and turn it on. It equips the modem from its inventory, names itself (for example `Miner12`), and installs MinerDash.
3. Let it shut down, then place it at its own home-row position, **Y 67, Z -55**, facing south, and turn it on. The first row job saves that home. Do not start a row job at the installer drive unless the drive is already beside that exact home position.

**By hand:**
```
wget https://<your-app>.ondigitalocean.app/turtle.lua startup.lua
startup
```
Then paste the token. The manual client does not equip a modem or name the turtle: equip the modem while keeping its pickaxe, and give the turtle a name before picking it up so its files are retained. Run `startup setup` to change the address or token later.

For existing installations, use **Update all scripts** while the turtles are idle. Old branch jobs are paused for migration; create a new row job after updating and returning the turtles to their home row. Their old free-form access route is not guessed or reused as a new south staircase.

## Set up the fleet (Fleet page)

1. **Depot.**
   1. Keep the existing shared depot, with its turtle dock at **Y 67**, and put three chests next to the dock on different sides (north, south, east, west, above or below).
   2. Enter the dock's coordinates, or drive a turtle there and click **Dock at …'s position**.
   3. Choose which side each chest is on.

   Leave open routes at **Y 67** between the home row and the depot, including the waiting spots 3 to 5 blocks from the dock. A turtle can turn or detour around other turtles on that plane, but it does not fly above the route or dig a new surface passage. One turtle uses the dock at a time. Stock the fuel chest and keep space in the junk and valuables chests. Mining areas and stair excavations must stay outside the depot and its waiting space.
2. **Protection.** Add protected areas (two corners, inclusive) and adjust the block patterns. `*` matches anything, so `create:*` covers every Create block. A line starting with `!` is an exception: the default `!create:*_ore` leaves Create's zinc ores fair game while every other Create block stays protected. Settings saved before 2.2.0 that protect `create:*` get this exception added once; remove it from the list if you want Create's ores protected again.
3. **Item sorting.** Name patterns for valuables and fuel. Everything else is junk. With a big fleet the junk chest fills quickly, so empty it into a trash can or a hopper line.
4. Click **Save fleet settings**. Every turtle gets them right away.

## Fleet jobs

Update to **2.2.0**, place the selected turtles at their own home-row positions, and wait for GPS. New level jobs start from those homes. Pick the turtles in the fleet picker, then:

- **Mine a level.** Choose an ore preset, or a **top level** and **bottom level** (both from **Y -58** to **Y 64**; set them the same for one level) and a **Start at** level, then the **mining radius** (default **256**, whole numbers from **1 to 1024**). When the turtles finish, every block from the top level to the bottom level inside their circles has been checked for ore. The preview estimates how many blocks that digs.
  - **Ore presets.** Each preset covers its ore's whole spawn range in Java 1.21.1, cut to Y -58 (bedrock is below) and Y 64 (just under the home row), and starts where the ore is most common: diamond and redstone at the bottom, gold at -16, lapis at 0, iron at 16, copper at 48, ancient debris at 16, and coal and emerald at the top of what the tunnels reach.
  - **Most likely first.** Levels are mined in passes of five, starting with the band around the **Start at** level and moving outward, one band above and one below in turn. Each pass has one tunnel in every column, so stopping early still leaves the richest levels done. Each pass sweeps the turtle's columns, back and forth on alternate passes. Without a start level, mining starts at the top.
  - **Staggered tunnels.** The turtles run straight 1×1 tunnels north and south. On each level there is a tunnel in one column out of every five, shifted two columns east for every level down: column `x` has a tunnel at level `y` when `(x + 2y) mod 5 = 0`. Every tunnel block is checked up, down, east and west, and every block between tunnels touches exactly one tunnel on one of those faces. Nothing is missed, and only one block in five is dug. To cover the top and bottom levels fully, tunnels also run one level above the top and one below the bottom.
  - **The whole cylinder.** Each turtle has an infinite vertical cylinder centered on its permanent home X/Z: a block is inside when `(x - homeX)^2 + (z - homeZ)^2 <= radius^2`. There is no vertical limit. Every column inside any selected turtle's circle is mined, and each column's tunnels run from its circle's north edge to its south edge. Columns are split west to east into one run per turtle with about equal work, and a column only one turtle can reach always goes to that turtle. Each turtle mines its run from the end nearer its own stairs. The blocks at the very rim of a circle can lack a tunnel neighbor inside it.
  - **Shafts and corridor.** Each turtle's stairs end at the access level, two above the top level. From the stair bottom it walks along its own home column to **Z -55**, the row through every circle's center. A corridor along that row reaches each of its columns. In each column, a shaft drops straight down from the corridor, and every tunnel crosses it. Shafts are always dug in one piece from the corridor down. Once the first pass has reached every column, later passes move between columns through the shafts at depth instead of climbing back to the corridor. Tunnels are dug outward from the shaft, first north, then south, so the way back is always through blocks already dug.
  - **Ore checks.** Ore found beside a tunnel is followed as a vein, within the turtle's columns, its neighbors' nearest columns, one level below the lowest tunnel and up to the corridor, all clipped to its circle. Large veins are finished over multiple saved passes. Depot trips resume the exact vein path.
  - **Blocks it can't break.** Spawn protection (16 blocks around world spawn by default, at every depth) and land-claim mods can refuse a turtle's digging with "Cannot break protected block". Staggered jobs treat such a block, bedrock, and blocks protected in Fleet settings as an obstacle: a tunnel stops short of it and the turtle moves on to the next part, a shaft stops above it and that column's deeper tunnels are skipped, and ore it can't break is left alone. Each skip is logged with its position. Those blocks go unchecked, so allow turtles ("fake players") in your claims, or move the job away from spawn, for full coverage. A staircase that hits one stops the job and says so.
  - **Returning.** The turtle unwinds its saved vein path, walks back along its tunnel to the shaft, climbs the shaft to the corridor, follows the corridor and its home column to its stair bottom, then climbs its exact stairs. Below the corridor it only clears what fell into or formed in its own tunnels on the way out: sand and gravel, and the stone, cobblestone or obsidian that lava makes when it flows into water. It never digs a new way up through rock.
  - **Initial descent.** Starting from its own saved home, each turtle moves **one block south, then one block down**, repeating to the access level, with two blocks of clearance. When the radius is smaller than the depth, the stairs **switch back**: south to `Z -55 + radius`, then north to `Z -55`, and so on, so they never leave the circle. The reached bottom is saved for that turtle.
  - **Stair protection exception.** Only initial excavation of the next unopened stair cell may cross a protected area. It must still stay inside the mining-radius circle. Protected block patterns, containers, ComputerCraft blocks, and other turtles remain protected throughout. The exception does not apply to the corridor, shafts, tunnels, ore mining, return travel, later descents, or Force home.
  - **Reusing stairs.** Later trips descend only the opened steps. A shallower job reuses part of them; a deeper one digs only the unopened extension. Every radius shares the stairs down to its first switchback. A later job with a different radius reuses only those shared steps and digs the rest of its own. Saved home coordinates are never replaced by a later job.
  - **Older queued jobs.** Level jobs queued before 2.2.0 still mine parallel 2-high lanes on one level, starting at their stair bottom.
- **Quarry an area.** Two corners plus top and bottom Y. The area is split into one strip per turtle. Only blocks inside the box are dug: turtles drop in from above through open air, so set the top at ground level. Anything above it, like trees, is left alone. A box whose top is buried is refused rather than dug down to.

The planned lanes, individual stairs, radius circles, and checked areas are shown before starting. Each lane ends at its turtle's circle boundary. Row mining follows the saved home/stair protocol above; quarry jobs retain their separate bounded-box behavior.

**Depot trips and returns.** When fuel or inventory requires servicing, the turtle first unwinds any ore detour. At its safe mining Y it mines back along the return corridor to its own saved bottom, keeping normal area and block protection enabled. It climbs the exact stairs in reverse: **up, then north** for each step. It reaches its own home, travels flat at **Y 67** to the existing shared depot, unloads/refuels, and returns flat to the same home. To resume, it walks down the already opened stairs and returns at mining Y to its lane and saved work position. Initial descent can also pause for servicing and continue from its saved partial step.

The mining radius does not prevent the shared-depot journey: surface travel between home and depot may leave the circle, stays at **Y 67**, and does not gain permission to excavate outside it. The radius also remains enforced during Force home and initial staircase excavation.

Stair travel never cuts a new way through stone or containers. It may clear only sand or gravel that fell into a specifically opened step, with ordinary protection checks. A blocked staircase stops the turtle and reports the obstruction. It does not choose another stair route or mine upward through rock.

**Fuel.** Reserves cover the return corridor, both movements of every stair step, the flat shared-depot journey, and the trip back to work. A saved vein continuation adds its replay cost. Turtles also keep a margin for waiting and detours on the depot plane.

At the depot it takes on at least that reserve, even if **Refuel to** is set lower.

Turtles don't carry junk either. Anything not on the valuables or fuel lists is dropped underground where the turtle is: in one batch as soon as junk fills two slots, so it carries at most about a stack at a time without leaving an item behind for every block mined, and before any trip out of the mine (a depot visit, the end of a job, or Go home), so it arrives with only treasure and fuel. It never drops into a chest beside it, and jobs at the surface keep their junk for the junk chest. Dropped items disappear after five minutes, as Minecraft items do.

Turtles don't carry spare fuel. After refuelling, leftover coal or charcoal goes back in the fuel chest. If the fuel chest is full, the turtle burns the leftover into its tank (up to the tank's limit), and anything still left goes into the valuables chest, or else the junk chest. A full fuel chest is not an unloading error. An empty or missing fuel supply still requires attention when the turtle needs more fuel.

Before anything starts, the server checks the job. If anything fails, it refuses and tells you why:
- **Protected areas:** mining slices, ore-check allowances, and flat assembly/return corridors may not enter them. The sole area exception is new initial staircase excavation, as described above.
- **The depot:** no job or staircase may dig at the depot or where turtles wait for it.
- **Homes:** no mining area or staircase may dig out a turtle's home.

- **Pause** stops a turtle where it is. A turtle at the dock finishes its turn first.
- **Resume** carries on.
- **Cancel** (or **Go home**, or **Recall** for a group) returns a row miner to its own bottom, climbs its exact stairs and goes straight home with whatever it carries. It calls at the depot first only when it hasn't the fuel to get home.
- **If something stops a job,** such as a protected block in the way or no open way to the dock, the turtle notes why ("Job stopped: …"), heads home, and waits. Fix the problem and press **Resume**, and it goes back to work.

If a turtle reboots, its saved phase identifies whether it was opening a forward/down stair half-step, mining, climbing, or visiting the depot. Home and stair data live independently of the job in `.minerdash_state`; a cleared job does not erase them. Interrupted final or recall travel can recover even after job bookkeeping changes. The old `.minerdash_route` breadcrumb journal is no longer used, and its former cell limit does not restrict this route.

Version **2.2.0** mines levels with staggered tunnels through each turtle's whole circle, switches staircases back when the radius is smaller than the depth, and leaves Create's ores minable. Version **2.1.2** saves shared waypoints on every CC:Tweaked version. 2.1.1 relied on the `allow_repetitions` serializer option, which older CC:Tweaked versions ignore, so turtles still failed with "Cannot serialize table with repeated entries" when they reached the bottom of their stairs and started scanning. Version 2.1.1 updated the activity label as turtles leave the depot and resume work. If an older turtle is still online after the serialization error, recall it home before updating so the old client can save its independent route after clearing the failed assignment. Then update and start a new job.

**Force home** follows the same controlled return route. Its mining is confined to the safe mining-level return, followed by the saved stairs and the flat depot/home trip. It does not grant a free three-dimensional mining path or a protected-area exception. Protected blocks and areas remain protected; an obstructed saved staircase still requires attention.

## Automatic fleet queue

**Updating scripts.** **Update all scripts** reaches busy turtles too. A turtle on 2.2.3 or later updates at the next point where a reboot loses nothing (between two tunnel blocks, or parked waiting at the depot) and carries on with its job. For an older busy turtle, the server stops its job (the job stays saved), updates it once idle, and resumes the job when it reconnects. **The dock.** If the turtle using the dock disconnects anywhere but at the dock, the next turtle gets its turn; a turtle rebooting away from the dock gives up a turn it had saved. **Release dock** in Fleet settings still frees it by hand.

Use **Fleet → Add to queue** to line up level mines or quarries. Select the turtles that should work each area; they can already be busy. The queue runs one fleet job at a time and waits until every selected turtle is online, has reported a fresh GPS position, and has finished its current work. New level jobs require script **2.2.0** and start from each turtle's saved home; use **Update all scripts** while turtles are idle. Older queued level jobs without a mining radius must be replaced with new radius jobs. Their permanent homes and opened stairs remain saved.

Before starting, the server checks the area again against the current depot, homes and protected areas. It saves the assignments before sending them. Every assignment carries a unique ID, which the turtle keeps with its progress and completion receipt, so reconnecting or restarting does not cause the same assignment to run twice. The next job waits for all assigned turtles to finish and become idle, including their final unloading and return trip. Closing the dashboard leaves the queue running on the server.

- **Pause queue** stops future dispatches; turtles already mining continue. **Resume queue** allows dispatch again.
- **Pause all** pauses turtles and the queue. **Recall all** sends turtles home and pauses the queue. **Resume all** resumes paused turtles and allows queue dispatch again.
- **Cancel** removes a waiting job. Cancelling a running job recalls its assigned turtles and pauses the queue. A turtle that was offline is recalled when it reconnects with that cancelled assignment.
- A failed assignment or an area that no longer passes the safety checks blocks the job and pauses the queue. Check its reason in the queue card, cancel the blocked entry, fix the issue, and add a replacement job. Resuming the queue alone does not retry a blocked job.

The server stores up to 50 queue entries in `.data/fleet-queue.json` (ignored by Git). To retain the queue across server restarts, keep this directory. Set `FLEET_QUEUE_PATH` to an absolute path on persistent storage to use another location. DigitalOcean App Platform's local filesystem is temporary: redeploying or replacing the container can clear its queue file. Turtle-side progress still survives in Minecraft, but queued future jobs require retained server storage. A malformed queue file stops server startup instead of silently discarding planned work.

Run `npm test` for the planner, queue, and WebSocket integration checks. With Lua installed (or `LUA_BIN` set to its executable), turtle simulations also check movement and protection. You can run the navigation scenarios directly with `lua test/turtle-routing.lua`.

## 3D map

The **3D map** tab draws the world in Minecraft's own coordinates.

**Turtles** are colored by status, with a nose showing which way each one faces. You also see the depot and its chests, protected areas (red), job areas, homes and a ground grid in chunks (bigger squares for a big area).

**Mined blocks** are every block any turtle has dug since the server started, colored by what it was. Ores stand out.

**Using it:**
- Drag to spin, right-drag to pan, and scroll to zoom.
- Click a turtle to select it, or double-click to open its page.
- Hover a turtle or a mined block for details, including which turtle mined the block.
- **Fit** frames everything. **Follow** keeps the camera on the selected turtle.
- Checkboxes show only ores, or hide areas, jobs or names.
- **Clear history** forgets the mined blocks.

The map keeps the most recent 250,000 mined blocks in the server's memory, so a redeploy clears it. It needs WebGL and loads its 3D library from cdn.jsdelivr.net.

## Turtles that go offline far away

A turtle only runs while its chunk is loaded. Usually that means a player is nearby. Mining far from where you are, or after you log off, it stops and shows as offline. The sidebar shows where it was last seen.

When you come back near it, it switches back on and carries on with its job by itself. To keep a mining area running while you're away, keep its chunks loaded:
- `/forceload add <x1> <z1> <x2> <z2>` if you're an operator;
- a chunk-loading mod or claim, such as FTB Chunks;
- a chunk-loading turtle upgrade, such as the one in Advanced Peripherals.

## Positions and GPS

Turtles track their own movement and confirm it with GPS:

- For the first new row job, place the turtle at its own **Y 67, Z -55** home, facing **south**, and wait for a GPS position. This known starting setup establishes the facing without moving away from home. Other manual movement modes can still calibrate facing from a horizontal move.
- Every 30 seconds it checks its position. If the server stopped mid-move and left the saved position a block off, it corrects itself. If a player moved it, it recalibrates after its next move. Either way, home stays at its real world location.
- The initial stair area exception still requires a confirmed position and the exact saved pending stair cell. Unknown GPS never grants permission to ignore protected areas.

## Local jobs

The **Start a job here** card on a turtle's page runs single-turtle jobs:

- **Quarry:** a box forward, to the right and down, starting under the turtle.
- **Tunnel:** straight ahead.

The form says exactly which coordinates will be dug, and the map outlines them.

These commands use their own local job geometry before a turtle adopts a saved row route. Once its row home is saved, use **Fleet → Mine a level** for that turtle's south staircase, bottom waypoint, and fixed-Y shared-depot cycle.

## Run locally

```
npm install
DASHBOARD_PASSWORD=dev TURTLE_TOKEN=dev npm run dev
```

Then open http://localhost:8080. If you don't set the two variables, the server makes up temporary values and prints them on startup. CC:Tweaked blocks private IP addresses by default, so in-game turtles can only reach a local server if you change its config.

## Files

| Path | What it is |
| --- | --- |
| `server.js` | HTTP + WebSocket server: auth, turtle state, traffic, the dock queue, fleet settings, command relay, Lua downloads |
| `fleet.js` | Fleet settings validation and fleet-job planning and safety checks |
| `fleet-queue.js` | Persistent automatic job scheduling, assignment receipts, pause and cancellation |
| `public/` | The dashboard (plain HTML/CSS/JS, no build step; `world.js` is the 3D map, using three.js from a CDN) |
| `turtle/minerdash.lua` | The turtle client (served at `/turtle.lua` with the server's address filled in) |
| `turtle/install.lua` | The installer disk (served at `/install.lua`) |
| `.do/app.yaml` | App Platform spec |
