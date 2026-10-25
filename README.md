# Swara Showdown

A mobile-first, real-time multiplayer melody-memory game built with React, Vite, Express and Socket.IO. Rooms hold state in memory; there is no database.

## Run locally

Requirements: Node.js 20+

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in two or more browsers/devices. The Vite server proxies Socket.IO and health checks to the Express server on port 3001.

For a production-style local run:

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3001`.

## Deploy to Render (early playable build)

A `render.yaml` Blueprint is included. Push this folder to a GitHub repository, then in Render choose **New → Blueprint** and connect that repository. Review the `swara-showdown` web service and apply the Blueprint. It uses the Free plan, builds with `npm install && npm run build`, starts with `npm start`, and checks `/healthz`. You can also create **New → Web Service** and use those same build/start commands. Node 20 or newer is required. No database, secrets, or environment variables are required. Render supplies `PORT`; the app listens on `0.0.0.0` and serves both the built frontend and Socket.IO from the same web service.

After deployment, open `https://<your-service>.onrender.com/healthz`; success returns JSON with `ok: true`. Share the root URL to play.

The first request to a sleeping free instance may be slow. The join screen shows **“Waking up the stage…”** instead of a blank state while the connection reconnects. Room state is intentionally in-memory and will be cleared if the service restarts or spins down.

## Implemented rules

- 2–10 players; room code and QR invite, no login.
- Host also plays; host chooses the raga in the lobby and may kick players before the game.
- Raga semitones above C4: Shankarabharanam `0,2,4,5,7,9,11`; Mayamalavagowla `0,1,4,5,7,8,11`; Kalyani `0,2,4,6,7,9,11`; Kharaharapriya `0,2,3,5,7,9,10`.
- Key positions stay fixed; the selected raga changes pitches only.
- The 15-second answer deadline is anchored to the server-side scheduled end of the phrase.
- Reveal lasts 6 seconds; leaderboard lasts 5 seconds. Host can skip either phase.
- Six rounds: 3, 3, 4, 4, 5 and 6 notes. Round six doubles points.
- Scoring: 100 per correct note in the correct position, 200 perfect bonus, and up to 200 speed bonus on perfect answers.
- Browser-generated plucked notes via Web Audio; no audio files.
- Refresh/reconnect identity and score are preserved while the same server process/room remains alive.
- Host disconnect pauses the room and starts 30-second host failover.

## Notes

- Audio starts after a user gesture, to accommodate mobile browser autoplay policies. iPhone players should turn off Silent mode.
- Web audio on separate phones is scheduled against a shared server timestamp; network and device output latency mean physical playback cannot be sample-accurately simultaneous.
- Rooms are in-memory as requested. A process restart resets all rooms.
