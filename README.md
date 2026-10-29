# Imposter Word

A mobile-first, real-time multiplayer party game. 3–8 players, 40 related word pairs, no accounts, no installs.

Everyone gets the same secret word except one player (the imposter), who gets a similar one. Players give one-word clues, then vote on who the imposter is.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start          # http://localhost:3000
npm test           # automated end-to-end check (starts its own server)
```

## Test with several players

Each browser **tab** is its own player (the session lives in `sessionStorage`), so you can test with 3 tabs of one browser:

1. Tab 1: enter a nickname → **Create a room**.
2. Tabs 2 and 3: open `http://localhost:3000/?room=CODE`, enter different nicknames → **Join room**.
3. Host clicks **Start game**. Try the awkward cases: refresh a tab mid-round (you stay in the game), close a tab (you get skipped), let someone run out the 45 s clue timer.
4. Phones on the same Wi-Fi: open `http://YOUR_COMPUTER_LAN_IP:3000` (allow TCP 3000 through the firewall).

## Deploy publicly (Render example)

This is a long-lived Node.js + WebSocket server, so static hosts (Vercel, Netlify, GitHub Pages) will not work. Use Render, Railway, Fly.io or similar.

- **Render:** push this folder to GitHub → New → Web Service (or Blueprint, `render.yaml` is included). Build `npm install`, start `npm start`. Render supplies `PORT` and HTTPS.
- Use **one instance** only: rooms live in memory and reset when the server restarts.
- Free tiers sleep when idle, so open the link once just before sharing it. A health check is at `/health`.

## Rules

- A random player gets the alternate word and is not told they are the imposter.
- Clues: one word each, in a random fixed order, 45 seconds per turn. You can't use your own secret word or a word someone already used. An AFK or disconnected player is skipped.
- Votes are hidden until everyone connected has voted; you can't vote for yourself.
- **Players win only if the imposter is the unique top-voted player** (ties favour the imposter).
- Scoreboard across rounds: +1 for each other player when the imposter is caught, +2 for the imposter if they escape.
- The host starts rounds. If the host leaves, host passes to another player.
- If fewer than 3 players stay connected mid-round, everyone returns to the lobby with a message.
- A refresh or brief connection drop has an 8 s grace period: you keep your seat, your turn and your host role. After that, host passes on, the round continues without you, and in the lobby your seat is freed. You can still rejoin mid-round with the same nickname.

## Notes

- Room codes use consonants only, so they never spell a word.
- The server pings every 25 s to keep connections alive behind proxies; the browser auto-reconnects and rejoins, including when a phone wakes from sleep.
- Nickname-based recovery is intended for friendly groups. For hostile environments, require the session token.
