import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Tunables (env overrides are used by the automated test) ----------------
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500;
const REVEAL_MS = Number(process.env.REVEAL_MS || 5000); // secret-word screen
const TURN_MS = Number(process.env.TURN_MS || 45000);    // time to give a clue
const GRACE_MS = Number(process.env.GRACE_MS || 8000);   // refresh/reconnect window
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';              // no vowels: no accidental words

const PAIRS = [
['Coffee','Tea','Food'],['Pizza','Burger','Food'],['Pancake','Waffle','Food'],['Apple','Pear','Food'],['Cake','Pie','Food'],['Rice','Pasta','Food'],['Soup','Stew','Food'],['Lemon','Lime','Food'],['Chocolate','Caramel','Food'],['Cookie','Brownie','Food'],
['Guitar','Violin','Music'],['Piano','Keyboard','Music'],['Drums','Bongos','Music'],['Flute','Clarinet','Music'],['Singing','Rapping','Music'],
['Beach','Pool','Places'],['Forest','Jungle','Places'],['Mountain','Hill','Places'],['Hotel','Hostel','Places'],['Museum','Gallery','Places'],['Library','Bookstore','Places'],['River','Lake','Places'],
['Cat','Dog','Animals'],['Lion','Tiger','Animals'],['Dolphin','Whale','Animals'],['Butterfly','Moth','Animals'],['Rabbit','Hare','Animals'],
['Football','Basketball','Sports'],['Tennis','Badminton','Sports'],['Skiing','Snowboarding','Sports'],['Running','Jogging','Sports'],['Chess','Checkers','Games'],['Bicycle','Scooter','Transport'],['Train','Tram','Transport'],['Plane','Helicopter','Transport'],['Rain','Snow','Nature'],['Sun','Moon','Nature'],['Thunder','Lightning','Nature'],['Laptop','Tablet','Tech'],['Camera','Phone','Tech']
];

const rooms = new Map();
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });

// ---- Helpers ----------------------------------------------------------------
const uid = () => randomBytes(16).toString('hex');
const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
const fail = (ws, message) => send(ws, { type: 'error', message });
const online = r => r.players.filter(p => p.connected);
const getPlayer = (r, id) => r.players.find(p => p.id === id);
const validName = s => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 18 && /^[\p{L}\p{N} _.-]+$/u.test(s.trim());
const norm = s => s.trim().toLocaleLowerCase();
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function shuffle(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

function publicState(r, p) {
  const inRound = r.phase === 'reveal' || r.phase === 'clue' || r.phase === 'vote';
  const timed = r.deadline && (r.phase === 'reveal' || r.phase === 'clue');
  return {
    type: 'state', room: r.code, selfId: p.id, token: p.token, hostId: r.hostId, phase: r.phase,
    players: r.players.map(x => ({ id: x.id, name: x.name, connected: x.connected, score: r.scores[x.id] || 0 })),
    round: r.round, category: r.category,
    word: inRound ? p.word : null,
    timeLeft: timed ? Math.max(0, r.deadline - Date.now()) : null, // relative, so client clock skew can't matter
    turnId: r.phase === 'clue' ? r.order[r.turn] : null,
    order: r.order, clues: r.clues,
    hasVoted: r.phase === 'vote' ? Object.keys(r.votes) : [],
    myVote: r.phase === 'vote' ? (r.votes[p.id] ?? null) : null,
    results: r.phase === 'results' ? r.results : null,
    message: r.message
  };
}
function broadcast(r) { for (const p of r.players) if (p.connected) send(p.ws, publicState(r, p)); }

function clearTimer(r) { if (r.timer) clearTimeout(r.timer); r.timer = null; r.deadline = null; }
function clearRound(r) {
  clearTimer(r);
  r.order = []; r.turn = 0; r.clues = []; r.votes = {}; r.results = null; r.category = null; r.message = null; r.imposterId = null;
  for (const p of r.players) p.word = null;
}
function destroyRoom(r) {
  clearTimer(r);
  for (const p of r.players) clearTimeout(p.dropTimer);
  rooms.delete(r.code);
}
function toLobby(r, message) {
  clearRound(r);
  r.players = r.players.filter(p => p.connected); // drop anyone who is gone
  if (!r.players.some(p => p.id === r.hostId)) r.hostId = r.players[0]?.id ?? null;
  r.phase = 'lobby'; r.message = message;
  broadcast(r);
}

// ---- Round flow -------------------------------------------------------------
function newRound(r) {
  clearRound(r);
  r.round++;
  const [a, b, category] = pick(PAIRS);
  const flip = Math.random() < 0.5;
  const normal = flip ? b : a, odd = flip ? a : b;
  const members = shuffle(online(r));
  const imp = pick(members);
  r.imposterId = imp.id; r.normalWord = normal; r.imposterWord = odd; r.category = category;
  for (const p of members) p.word = p === imp ? odd : normal;
  r.order = members.map(p => p.id);
  r.phase = 'reveal';
  r.deadline = Date.now() + REVEAL_MS;
  broadcast(r);
  r.timer = setTimeout(() => {
    r.timer = null;
    if (r.phase !== 'reveal') return;
    r.phase = 'clue'; r.turn = 0;
    nextTurn(r);
    broadcast(r);
  }, REVEAL_MS);
}

// Moves to the next connected player's turn (marking skipped players), or to voting.
// Also (re)starts the per-turn timer so an AFK player can never freeze the game.
function nextTurn(r) {
  clearTimer(r);
  while (r.turn < r.order.length && !getPlayer(r, r.order[r.turn])?.connected) {
    r.clues.push({ playerId: r.order[r.turn], word: null, skipped: true });
    r.turn++;
  }
  if (r.turn >= r.order.length) { r.phase = 'vote'; return; }
  const id = r.order[r.turn];
  r.deadline = Date.now() + TURN_MS;
  r.timer = setTimeout(() => {
    r.timer = null;
    if (r.phase !== 'clue' || r.order[r.turn] !== id) return;
    r.clues.push({ playerId: id, word: null, skipped: true });
    r.turn++;
    nextTurn(r);
    broadcast(r);
  }, TURN_MS);
}

function votingDone(r) {
  const voters = r.order.filter(id => getPlayer(r, id)?.connected);
  return voters.length > 0 && voters.every(id => r.votes[id]);
}

function results(r) {
  clearTimer(r);
  const tally = {};
  for (const id of Object.values(r.votes)) tally[id] = (tally[id] || 0) + 1;
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter(id => tally[id] === max);
  const playersWin = top.length === 1 && top[0] === r.imposterId; // ties favour the imposter
  if (playersWin) { for (const id of r.order) if (id !== r.imposterId) r.scores[id] = (r.scores[id] || 0) + 1; }
  else r.scores[r.imposterId] = (r.scores[r.imposterId] || 0) + 2;
  r.results = { imposterId: r.imposterId, normalWord: r.normalWord, imposterWord: r.imposterWord, votes: r.votes, tally, playersWin };
  r.phase = 'results';
  broadcast(r);
}

// ---- Disconnects: short grace period so a page refresh never hurts ----------
function scheduleCleanup(r, p) {
  clearTimeout(p.dropTimer);
  p.dropTimer = setTimeout(() => {
    p.dropTimer = null;
    if (p.connected || !rooms.has(r.code) || !r.players.includes(p)) return;
    settle(r, p);
  }, GRACE_MS);
}
function settle(r, p) {
  if (r.phase === 'lobby') r.players = r.players.filter(x => x !== p);
  if (r.hostId === p.id) r.hostId = online(r)[0]?.id ?? null;
  if (!online(r).length) { destroyRoom(r); return; }
  if (r.phase !== 'lobby' && online(r).length < MIN_PLAYERS) { toLobby(r, 'Fewer than 3 players are connected. The round was cancelled.'); return; }
  if (r.phase === 'clue' && r.order[r.turn] === p.id) nextTurn(r);
  if (r.phase === 'vote' && votingDone(r)) { results(r); return; }
  broadcast(r);
}
function disconnect(ws) {
  const r = rooms.get(ws.roomCode);
  if (!r) return;
  const p = getPlayer(r, ws.playerId);
  if (!p || p.ws !== ws) return; // an older socket that was already replaced
  p.connected = false; p.ws = null;
  broadcast(r);
  scheduleCleanup(r, p);
}

// ---- Joining ----------------------------------------------------------------
function join(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  const name = String(msg.name || '').trim();
  if (!/^[A-Z]{4}$/.test(code)) return fail(ws, 'Enter a valid 4-letter room code.');
  if (!validName(name)) return fail(ws, 'Nickname must be 1\u201318 letters, numbers, spaces, or . _ -');
  const r = rooms.get(code);
  if (!r) return fail(ws, 'Room not found. Check the code and try again.');

  let p = r.players.find(x => norm(x.name) === norm(name));
  if (p) {
    const sameSession = Boolean(msg.token) && p.token === msg.token;
    if (p.connected && !sameSession) return fail(ws, 'That nickname is already taken.');
    if (p.connected && p.ws && p.ws !== ws) { // same session opened twice: newest wins
      const old = p.ws; p.ws = null;
      send(old, { type: 'kicked', message: 'This game was opened in another tab or window.' });
      old.close();
    }
    clearTimeout(p.dropTimer);
    p.token = uid(); p.connected = true; p.ws = ws; // disconnected nickname = reconnect
  } else {
    if (r.phase !== 'lobby') return fail(ws, 'A round is already in progress. Wait for the next lobby.');
    if (r.players.length >= MAX_PLAYERS) return fail(ws, 'Room full (maximum 8 players).');
    p = { id: uid(), token: uid(), name, connected: true, ws, word: null, dropTimer: null };
    r.players.push(p);
    if (!r.hostId) r.hostId = p.id;
  }
  ws.roomCode = code; ws.playerId = p.id;
  broadcast(r);
}

// ---- Messages ---------------------------------------------------------------
wss.on('connection', ws => {
  ws.isAlive = true; ws.winStart = Date.now(); ws.count = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    const now = Date.now();
    if (now - ws.winStart > 1000) { ws.winStart = now; ws.count = 0; }
    if (++ws.count > 15) return fail(ws, 'Slow down a little.');
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return fail(ws, 'Invalid message.'); }
    if (!m || typeof m !== 'object') return;
    try {
      if (m.type === 'create') {
        if (ws.roomCode) return fail(ws, 'Already in a room.');
        if (!validName(m.name)) return fail(ws, 'Enter a nickname (1\u201318 characters).');
        if (rooms.size >= MAX_ROOMS) return fail(ws, 'The server is busy. Try again in a minute.');
        let code;
        do { code = Array.from(randomBytes(4), x => CODE_LETTERS[x % CODE_LETTERS.length]).join(''); } while (rooms.has(code));
        rooms.set(code, { code, players: [], hostId: null, phase: 'lobby', round: 0, timer: null, deadline: null, scores: {}, order: [], turn: 0, clues: [], votes: {}, results: null, category: null, message: null });
        return join(ws, { code, name: m.name });
      }
      if (m.type === 'join') {
        if (ws.roomCode) return fail(ws, 'Already in a room.');
        return join(ws, m);
      }
      const r = rooms.get(ws.roomCode);
      const p = r && getPlayer(r, ws.playerId);
      if (!r || !p || p.ws !== ws) return fail(ws, 'Join a room first.');

      if (m.type === 'leave') {
        p.connected = false; p.ws = null; ws.roomCode = null; ws.playerId = null;
        clearTimeout(p.dropTimer);
        settle(r, p);
      } else if (m.type === 'start') {
        if (p.id !== r.hostId) return fail(ws, 'Only the host can start a round.');
        if (r.phase !== 'lobby' && r.phase !== 'results') return fail(ws, 'The round is already in progress.');
        if (online(r).length < MIN_PLAYERS) return fail(ws, 'At least 3 connected players are required.');
        newRound(r);
      } else if (m.type === 'clue') {
        if (r.phase !== 'clue' || r.order[r.turn] !== p.id) return fail(ws, 'It is not your turn.');
        const word = String(m.word || '').trim();
        if (!/^[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*$/u.test(word) || word.length > 24) return fail(ws, 'Enter one word, up to 24 characters.');
        const lw = word.toLocaleLowerCase();
        if (lw === p.word.toLocaleLowerCase()) return fail(ws, "You can't use your own secret word as a clue.");
        if (r.clues.some(c => c.word && c.word.toLocaleLowerCase() === lw)) return fail(ws, 'Someone already used that word. Try another.');
        r.clues.push({ playerId: p.id, word });
        r.turn++;
        nextTurn(r);
        broadcast(r);
      } else if (m.type === 'vote') {
        if (r.phase !== 'vote') return fail(ws, 'Voting is not open.');
        if (r.votes[p.id]) return fail(ws, 'You have already voted.');
        if (!r.order.includes(p.id)) return fail(ws, 'You are not in this round.');
        if (!r.order.includes(m.targetId) || m.targetId === p.id) return fail(ws, 'Choose another player.');
        r.votes[p.id] = m.targetId;
        if (votingDone(r)) results(r); else broadcast(r);
      } else fail(ws, 'Unknown action.');
    } catch (e) { console.error(e); fail(ws, 'Something went wrong. Please try again.'); }
  });
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => {});
});

// Heartbeat: keeps connections alive through proxies and detects dead phones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Imposter Word listening on http://localhost:${port}`));
