# MinerDash

A web dashboard for controlling CC:Tweaked mining turtles from anywhere, deployed on DigitalOcean App Platform.

- Live status for every turtle: fuel, position, inventory, current job, and the blocks around it
- Drive a turtle with buttons or the keyboard (`W A S D` move and turn, `E`/`Q` up and down, `Esc` stops)
- Start quarry and tunnel jobs. Turtles unload into a chest, burn the coal they mine, and return home when done
- **Stop all** and **Recall all** buttons for every turtle at once
- Top-down map with each turtle's recent path
- **Update script** pushes the latest turtle code from the server to a turtle and reboots it

```
turtle (Lua) ──wss──▶  server.js (Node, App Platform)  ◀──wss── browser dashboard
```

## Deploy to DigitalOcean App Platform

1. Push this repo to GitHub.
2. Generate two secrets, for example with `openssl rand -base64 24`:
   - `DASHBOARD_PASSWORD`: what you type to sign in to the dashboard
   - `TURTLE_TOKEN`: what each turtle uses to connect
3. In the DigitalOcean control panel, go to **Create → App Platform**, pick the GitHub repo and the `main` branch. It detects Node.js and runs `npm start`.
4. Under **Environment Variables**, add `DASHBOARD_PASSWORD` and `TURTLE_TOKEN` and tick **Encrypt** for both.
5. Keep it at **1 container**. Turtle connections live in memory, so they can't be split across instances. The smallest size is plenty.
6. Deploy, then open `https://<your-app>.ondigitalocean.app`.

If you use `doctl`, you can create the app from the included spec with `doctl apps create --spec .do/app.yaml` and then set the two secrets in the app's settings. Edit `repo:` in the spec first if your GitHub repo has a different name.

Health checks hit `/healthz`. Every push to `main` redeploys. Turtles and open dashboards reconnect on their own afterwards.

## Set up a turtle

1. Use a **mining turtle** (one with a pickaxe), give it some fuel, and name it: `label set Miner1`
2. On the turtle, run:
   ```
   wget https://<your-app>.ondigitalocean.app/turtle.lua startup.lua
   startup
   ```
3. Paste your `TURTLE_TOKEN` when it asks. It's saved, and since the script is `startup.lua` the turtle reconnects after reboots and chunk reloads.

To change the URL or token later, run `startup setup`. The dashboard's **Add turtle** button shows the exact `wget` command for your deployment.

The Minecraft server needs CC:Tweaked's HTTP API (with websockets) enabled. It is on by default. If you self-host the dashboard on your LAN, note that CC:Tweaked blocks private IP addresses by default. The public App Platform URL avoids that.

## How jobs work

- **Starting a job makes the turtle's current spot home.** Put a chest directly **behind** the turtle before you start.
- **Quarry** digs a box *length* blocks forward, *width* blocks to the right, and *depth* blocks down, starting one block below the turtle. It mines three layers per pass and stops early if it reaches bedrock.
- **Tunnel** digs straight ahead, 1–3 blocks high.
- When the inventory fills up, the turtle goes home, empties into the chest (keeping one stack of fuel), and returns to where it was. If the chest is full or missing, it waits and says so in the log.
- It burns fuel items it has mined when it needs to. If it still can't make the trip, it goes home and waits for you to give it fuel.
- **Stop** halts the turtle where it is. **Go home** cancels any running job and brings the turtle back.

Coordinates are relative to where the turtle first ran the script, with +Z being the direction it faced then. They're saved on the turtle, so they survive reboots. If you pick the turtle up and put it somewhere else, use **Reset position**. If the turtle has a wireless modem and you have a GPS network, the dashboard also shows its world coordinates.

## Run locally

```
npm install
DASHBOARD_PASSWORD=dev TURTLE_TOKEN=dev npm run dev
```

Then open http://localhost:8080. If you don't set the two variables, the server makes up temporary values and prints them on startup.

## Files

| Path | What it is |
| --- | --- |
| `server.js` | HTTP + WebSocket server. Handles auth, keeps turtle state in memory, relays commands, and serves `/turtle.lua` |
| `public/` | The dashboard (plain HTML/CSS/JS, no build step) |
| `turtle/minerdash.lua` | The turtle client. The server bakes its own URL into it when serving `/turtle.lua` |
| `.do/app.yaml` | App Platform spec |
