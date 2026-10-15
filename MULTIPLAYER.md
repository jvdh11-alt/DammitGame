# Dammit online (friends) — how it works and how to run it

## Try it on your own network (no hosting needed)
1. Install Node.js 20+ on your PC, open a terminal in this folder.
2. `npm install`, then `npm run build`, then `npm run server`.
3. On any phone/PC on the same Wi-Fi open `http://<your-PC-IP>:8787` (find the IP with `ipconfig`).
   Everyone uses that same address. Tap "Play with friends".
   (If Windows Firewall asks, allow Node on private networks.)

## Playing
- One person: Play with friends -> Create a room -> share the 4-letter code (or the invite link).
- Others: Play with friends -> enter the code -> Join room.
- Host adds bots to fill seats, then Start game. A dropped player is replaced by a bot after 10 s
  and gets their seat back when they reconnect (the app reconnects automatically, or re-join with the same name).
- The server runs all the rules and bots; each player only receives their own hand.

## Putting it online for friends anywhere (later)
`render.yaml` is ready for Render.com (free web service): push this folder to GitHub, create a Blueprint on
Render pointing at the repo. The same service serves the game page and the websocket, so friends just open the
Render URL. (Free services sleep when idle: the first connection takes ~30 s to wake.)
If the game page stays on Netlify instead, enter the server address (e.g. wss://dammit.onrender.com) under
"Server address" on the Play with friends screen, or set VITE_SERVER_URL at build time.

## Settings (environment variables, all optional)
PORT (8787), STEP_MS (bot pace, 1200), DEAL_MS (pause after dealing, 4800), TAKEOVER_MS (10000).
