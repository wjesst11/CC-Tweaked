# MinerDash

A web dashboard for running a fleet of CC:Tweaked mining turtles, deployed on DigitalOcean App Platform.

- **Fleet jobs.** Send any group of turtles to mine a Y level until each has brought back a goal, like 64 diamonds, or split a big quarry between them.
- **Automatic job queue.** Line up mining areas and quarries. Each starts when its selected turtles are ready, after rechecking protection. Assignment receipts prevent duplicate work when connections drop.
- **3D map.** A map of the world you can spin and zoom, showing every turtle, the depot, protected areas, job areas and every block the fleet has mined, colored by what it was.
- **Never stranded.** A turtle always keeps enough fuel to get back to where it refuels, judged from the way it would really go. When it runs low on fuel or space, even partway through an ore vein, it unloads and refuels, then goes back to exactly where it left off.
- **A shared depot.** Every turtle unloads at the same dock with three chests: junk, valuables and fuel. Items are sorted by name patterns you choose. Turtles refuel from the fuel chest and deposit the coal they mine into it.
- **No collisions.** Turtles take the quickest open route, and the server shares where every turtle is and where it's about to move, so they steer around each other. The lower ID has right of way, and turtles standing still are treated as obstacles. One turtle at a time uses the dock while the others wait a few blocks away. A turtle never digs another one.
- **Travel never breaks blocks.** Going home, to the depot or to a job, a turtle plans a route through open space and goes around walls, roofs, trees and hills. It prefers ways it has already been, rather than feeling its way along rock it can't see. If there's no open way, it stops and says where it is instead of digging.
- **Few turns.** A turn takes as long as a move, so routes run straight rather than zig-zag. Turtles also check ore veins and sort at the dock in the order that needs the fewest turns.
- **Smarter returns.** Turtles choose short open routes home, account for turns, and back down straight corridors without turning around. The recorded home route stays available as a fallback, survives reboots, and is preserved when a new job starts somewhere else.
- **Protection.** Turtles never dig chests, barrels, shulker boxes, hoppers, Create blocks, or any ComputerCraft block such as other turtles and your GPS computers. They never dig or build inside protected areas, like a friend's base. The rules live on every turtle, so they hold even if the server is down.
- **Pause, Resume, Cancel.** Pause freezes a turtle in place. Cancel stops the job and sends it home. **Pause all**, **Resume all** and **Recall all** act on the whole fleet.
- **Permanent homes.** A turtle's home is where it first runs the script. Change it from the dashboard any time.
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

Turtles need a pickaxe, and a wireless or ender modem for GPS. You also need a GPS network: four host computers running `gps host`.

**With the installer disk (fastest for many turtles):**

1. Put a floppy in a disk drive. On a computer next to it, run:
   ```
   wget https://<your-app>.ondigitalocean.app/install.lua disk/startup.lua
   disk/startup.lua
   ```
   Paste your `TURTLE_TOKEN` once. It's saved on the disk.
2. Place a turtle next to the drive and turn it on. It equips the modem from its inventory, names itself (for example `Miner12`), and installs MinerDash.
3. Pick it up, place it where it should live, and turn it on. That spot becomes its **home**, and it connects. (To make the drive spot its home instead, press Enter during install.)

**By hand:**
```
wget https://<your-app>.ondigitalocean.app/turtle.lua startup.lua
startup
```
Then paste the token. Run `startup setup` to change the address or token later.

A home doesn't need open sky directly above it, but it does need some open way out, such as an open side, window or doorway. Turtles never dig their way out. A fully enclosed turtle stops and tells you.

## Set up the fleet (Fleet page)

1. **Depot.**
   1. Pick a dock spot and put three chests next to it on different sides (north, south, east, west, above or below).
   2. Enter the dock's coordinates, or drive a turtle there and click **Dock at …'s position**.
   3. Choose which side each chest is on.

   Turtles come into the dock through open space from any side without a chest. The one whose turn it is goes in; the others wait 3 to 5 blocks away. So the depot works anywhere with a little open room around it, including a low room underground. A room 3 or 4 blocks high is plenty, and it doesn't need open sky. Keep job start points at least 6 blocks from the dock; the server refuses ones that are closer.
2. **Protection.** Add protected areas (two corners, inclusive) and adjust the block patterns. `*` matches anything, so `create:*` covers every Create block.
3. **Item sorting.** Name patterns for valuables and fuel. Everything else is junk. With a big fleet the junk chest fills quickly, so empty it into a trash can or a hopper line.
4. Click **Save fleet settings**. Every turtle gets them right away.

## Fleet jobs

Pick turtles in the picker (**All ready** selects every online, idle turtle that knows its GPS facing), then:

- **Mine a level.** Choose an ore preset or a Y level, a start point and a direction, then the goal: how many of what each turtle should bring back (say 64 diamonds, or 0 for no goal).
  - **Its own slice of rock.** Each turtle digs its own 2-high tunnel, *spacing* blocks apart, and mines any ore veins it sees in the floor and walls.
  - **Height band.** **Stay within** sets how far above and below the level it may go. Once it reaches **Go at most** blocks out, it starts a new tunnel 3 blocks up, and later 3 blocks down, as long as those stay inside the band. It keeps going until it reaches its goal or has mined its whole slice.
  - **What it digs.** Veins are followed only inside the turtle's band and its slice (halfway to the next turtle's tunnel on each side). A vein that runs into a protected area is left there.
  - **Getting down.** New level jobs use a diagonal staircase: one block forward, one block down, with two blocks of headroom. X/Z specify the tunnel bottom; **Stair entrance Y** sets its top. The entrance is that many blocks behind the tunnel bottom, opposite the mining direction. Choose an entrance that opens into air. The preview and map show it before you start. Existing saved jobs retain their original access route when resumed.
- **Quarry an area.** Two corners plus top and bottom Y. The area is split into one strip per turtle. Only blocks inside the box are dug: turtles drop in from above through open air, so set the top at ground level. Anything above it, like trees, is left alone. A box whose top is buried is refused rather than dug down to.

The planned area is outlined on the fleet map before you start. Each turtle flies to its spot by the shortest open route without digging, and then works.

**Depot trips.** When a turtle is nearly full or low on fuel, it flies to the depot, waits its turn, sorts its items into the chests, refuels and goes back. This can happen partway through a vein: it remembers the way it dug into the vein and finishes it when it's back. When the job is done (or cancelled, or stopped by a problem), it unloads and refuels at the depot one last time, then heads home.

**Fuel.** A turtle never goes further than it has the fuel to come back from. It always keeps enough for two legs:
1. back out of the job the way it really goes, through its own tunnels to the shaft;
2. the flight to the depot, using the longest flight it has actually made between the job and the depot. Until it has made one, it uses the straight-line distance plus room for detours.

It keeps the same again for the trip back out, plus a margin. At the depot it takes on at least that much, even if **Refuel to** is set lower.

Before anything starts, the server checks the job. If anything fails, it refuses and tells you why:
- **Protected areas:** no turtle's slice, height band, or access stair may reach into one. Stair headroom is checked too.
- **The depot:** no job or staircase may dig at the depot or where turtles wait for it.
- **Homes:** no mining area or staircase may dig out a turtle's home.

- **Pause** stops a turtle where it is. A turtle at the dock finishes its turn first.
- **Resume** carries on.
- **Cancel** (or **Go home**, or **Recall** for a group) sends the turtle home by a short open route, with its recorded route as a fallback.
- **If something stops a job,** such as a protected block in the way or no open way to the dock, the turtle notes why ("Job stopped: …"), heads home, and waits. Fix the problem and press **Resume**, and it goes back to work.

If a turtle reboots mid-job, it picks the job back up by itself.

**The home route belongs to home, not to a job.** Script **1.7.1** journals every visited cell in `.minerdash_route` on the turtle. A new job can start away from home without replacing that history; clearing or finishing a job also preserves it until the turtle actually gets home. Reboots and chunk reloads restore the journal. Reaching home starts a fresh route for the next outing. Explicitly changing home or resetting position starts a new route; GPS recalibration also invalidates coordinates when the turtle has been moved by hand. A simple GPS position correction keeps the existing route.

The journal holds 100,000 cells. At that limit the turtle refuses new unexplored moves and keeps its existing return route, rather than deleting it. Home navigation can take open shortcuts, but it never digs a new path: only fallen blocks in cells it previously visited may be cleared, subject to protection rules.

**Force home** is a separate recovery command on the turtle page and in the fleet's picked-turtle controls. It cancels the current job and returns directly home, mining ordinary blocks when needed. Chests, other ComputerCraft blocks, configured protected blocks, restricted areas, and other turtles remain protected; it plans around obstacles it cannot dig. It preserves the saved home and return history. Normal **Go home** and **Recall** continue to use open routes. Update turtles to **1.8.0** for staircase mining and Force home.

## Automatic fleet queue

Use **Fleet → Add to queue** to line up level mines or quarries. Select the turtles that should work each area; they can already be busy. The queue runs one fleet job at a time and waits until every selected turtle is online, has reported a fresh GPS position, and has finished its current work. Each selected turtle needs script **1.7.0** or newer; use **Update all scripts** while turtles are idle.

Before starting, the server checks the area again against the current depot, homes and protected areas. It saves the assignments before sending them. Every assignment carries a unique ID, which the turtle keeps with its progress and completion receipt, so reconnecting or restarting does not cause the same assignment to run twice. The next job waits for all assigned turtles to finish and become idle, including their final unloading and return trip. Closing the dashboard leaves the queue running on the server.

- **Pause queue** stops future dispatches; turtles already mining continue. **Resume queue** allows dispatch again.
- **Pause all** pauses turtles and the queue. **Recall all** sends turtles home and pauses the queue. **Resume all** resumes paused turtles and allows queue dispatch again.
- **Cancel** removes a waiting job. Cancelling a running job recalls its assigned turtles and pauses the queue. A turtle that was offline is recalled when it reconnects with that cancelled assignment.
- A failed assignment or an area that no longer passes the safety checks blocks the job and pauses the queue. Check its reason in the queue card, cancel the blocked entry, fix the issue, and add a replacement job. Resuming the queue alone does not retry a blocked job.

The server stores up to 50 queue entries in `.data/fleet-queue.json` (ignored by Git). To retain the queue across server restarts, keep this directory. Set `FLEET_QUEUE_PATH` to an absolute path on persistent storage to use another location. DigitalOcean App Platform's local filesystem is temporary: redeploying or replacing the container can clear its queue file. Turtle-side progress still survives in Minecraft, but queued future jobs require retained server storage. A malformed queue file stops server startup instead of silently discarding planned work.

Run `npm test` for the queue and WebSocket integration checks. With Lua installed (or `LUA_BIN` set to its executable), it also runs turtle simulations for route persistence, off-home job starts, shortcuts, turn costs, and obstacles. You can run those directly with `lua test/turtle-routing.lua`.

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

- The first time a turtle moves sideways, GPS tells it which way it's facing. Fleet jobs do this automatically by stepping into an open block.
- Every 30 seconds it checks its position. If the server stopped mid-move and left the saved position a block off, it corrects itself. If a player moved it, it recalibrates after its next move. Either way, home stays at its real world location.
- Until its GPS position is confirmed, a turtle refuses to dig anywhere when protected areas exist, because it can't be sure where it is.

## Local jobs

The **Start a job here** card on a turtle's page runs single-turtle jobs:

- **Quarry:** a box forward, to the right and down, starting under the turtle.
- **Tunnel:** straight ahead.

The form says exactly which coordinates will be dug, and the map outlines them.

With the depot set up, they unload and refuel there, both partway through and at the end, keeping enough fuel to reach it. Without a depot, they unload into a chest placed directly behind the spot where the job started. Either way, when the job ends the turtle heads home using an open route, with its recorded route as a fallback.

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
