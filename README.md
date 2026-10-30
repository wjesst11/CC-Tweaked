# MinerDash

A web dashboard for running a fleet of CC:Tweaked mining turtles, deployed on DigitalOcean App Platform.

- **Fleet jobs.** Send any group of turtles to mine a Y level (each turtle digs its own parallel tunnel and follows ore veins), or split a big quarry between them.
- **A shared depot.** Every turtle unloads at the same dock with three chests: junk, valuables and fuel. Items are sorted by name patterns you choose. Turtles refuel from the fuel chest and deposit the coal they mine into it.
- **No collisions.** Turtles take the shortest open route, and the server shares where every turtle is and where it's about to move, so they steer around each other. The lower ID has right of way, and turtles standing still are treated as obstacles. The dock is used by one turtle at a time. A turtle never digs another one.
- **Travel never breaks blocks.** Going home, to the depot or to a job, a turtle plans a route through open air and goes around roofs, trees and hills. If there's no open way, it stops and says where it is instead of digging.
- **Retracing home.** Each turtle remembers the blocks it has moved through since it left home. Going home (when a job ends, is cancelled, or runs into a problem), it goes back that way, clearing only sand, gravel and other blocks that fell into its path.
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

1. **Depot.** Pick a dock spot and put three chests next to it on different sides (north, south, east, west, above or below). Enter the dock's coordinates, or drive a turtle there and click **Dock at …'s position**. Then choose which side each chest is on. Turtles come straight down into the dock, so keep the sky above it open. With a chest *above* the dock, they come down the column next to it instead (the dashboard tells you which side), so keep that one open.
2. **Waiting height.** Turtles waiting for the dock line up in the air just east of it, one per block, starting at this height. It must be at least 3 blocks above the dock, with up to 64 blocks of room above it.
3. **Protection.** Add protected areas (two corners, inclusive) and adjust the block patterns. `*` matches anything, so `create:*` covers every Create block.
4. **Item sorting.** Name patterns for valuables and fuel. Everything else is junk. With a big fleet the junk chest fills quickly, so empty it into a trash can or a hopper line.
5. Click **Save fleet settings**. Every turtle gets them right away.

## Fleet jobs

Pick turtles in the picker (**All ready** selects every online, idle turtle that knows its GPS facing), then:

- **Mine a level.** Choose an ore preset or a Y level, a start point, a direction and a tunnel length. Each turtle digs its own 2-high tunnel, *spacing* blocks apart. It mines any ore veins it sees in the floor and walls, unless the vein runs into a protected area. To reach the level, each turtle digs a 1×1 shaft straight down at its tunnel's start, so pick a start out in the open, away from builds.
- **Quarry an area.** Two corners plus top and bottom Y. The area is split into one strip per turtle. Only blocks inside the box are dug: turtles drop in from above through open air, so set the top at ground level. Anything above it, like trees, is left alone. A box whose top is buried is refused rather than dug down to.

The planned area is outlined on the fleet map before you start. Each turtle flies to its spot by the shortest open route without digging, and then works. When it's full or low on fuel, it flies to the depot, waits its turn, sorts its items into the chests, refuels, and goes back. When it's done it unloads one last time and flies home.

Before anything starts, the server checks that no job, and no shaft down to it, would dig into a protected area, the depot, or a turtle's home. If one would, it refuses and tells you why.

- **Pause** stops a turtle where it is. A turtle at the dock finishes its turn first.
- **Resume** carries on.
- **Cancel** (or **Go home**, or **Recall** for a group) retraces the turtle's way home.
- **If something stops a job,** such as a protected block in the way or a dock column that's blocked, the turtle notes why ("Job stopped: …"), retraces its way home, and waits. Fix the problem and press **Resume**, and it goes back to work.

If a turtle reboots mid-job, it picks the job back up by itself.

## Positions and GPS

Turtles track their own movement and confirm it with GPS:

- The first time a turtle moves sideways, GPS tells it which way it's facing. Fleet jobs do this automatically by stepping into an open block.
- Every 30 seconds it checks its position. If the server stopped mid-move and left the saved position a block off, it corrects itself. If a player moved it, it recalibrates after its next move. Either way, home stays at its real world location.
- Until its GPS position is confirmed, a turtle refuses to dig anywhere when protected areas exist, because it can't be sure where it is.

## Local jobs

The **Start a job here** card on a turtle's page runs single-turtle jobs that don't use the depot:

- **Quarry:** a box forward, to the right and down, starting under the turtle.
- **Tunnel:** straight ahead.

The form says exactly which coordinates will be dug, and the map outlines them.

They unload into a chest placed directly behind the spot where the job started.

## Run locally

```
npm install
DASHBOARD_PASSWORD=dev TURTLE_TOKEN=dev npm run dev
```

Then open http://localhost:8080. If you don't set the two variables, the server makes up temporary values and prints them on startup. CC:Tweaked blocks private IP addresses by default, so in-game turtles can only reach a local server if you change its config.

## Files

| Path | What it is |
| --- | --- |
| `server.js` | HTTP + WebSocket server: auth, turtle state, lanes, the dock queue, fleet settings, command relay, Lua downloads |
| `fleet.js` | Fleet settings validation and fleet-job planning and safety checks |
| `public/` | The dashboard (plain HTML/CSS/JS, no build step) |
| `turtle/minerdash.lua` | The turtle client (served at `/turtle.lua` with the server's address filled in) |
| `turtle/install.lua` | The installer disk (served at `/install.lua`) |
| `.do/app.yaml` | App Platform spec |
