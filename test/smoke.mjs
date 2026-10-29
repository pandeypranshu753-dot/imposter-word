// End-to-end smoke test. Run with: npm test   (starts its own server on a random port)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4100 + Math.floor(Math.random() * 500);
const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: port, REVEAL_MS: 150, TURN_MS: 700, GRACE_MS: 350 }, stdio: 'pipe' });
await new Promise(res => srv.stdout.on('data', d => String(d).includes('listening') && res()));

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const c = { name, state: null, errors: [], kicked: false, token: null };
  c.open = () => new Promise(res => { c.ws = new WebSocket(`ws://localhost:${port}`); c.ws.on('open', res);
    c.ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') { c.state = m; c.token = m.token; } else if (m.type === 'error') c.errors.push(m.message); else if (m.type === 'kicked') c.kicked = true; }); });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (c.state && fn(c.state)) return true; await sleep(15); } return false; };
  return c;
}
async function make(name) { const c = client(name); await c.open(); return c; }

try {
  console.log('Lobby & joining');
  const A = await make('Ann'); A.send({ type: 'create', name: 'Ann' });
  await A.until(s => s.room); const code = A.state.room;
  ok(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(code), `room code is 4 letters (${code})`);
  const B = await make('Bob'); B.send({ type: 'join', code, name: 'Bob' });
  const X = await make('ann'); X.send({ type: 'join', code, name: 'ann' }); await sleep(100);
  ok(X.errors.some(e => /taken/i.test(e)), 'duplicate nickname rejected (case-insensitive)');
  const N = await make('Nope'); N.send({ type: 'join', code: 'ZZZZ', name: 'Nope' }); await sleep(100);
  ok(N.errors.some(e => /not found/i.test(e)), 'unknown room rejected');
  const C = await make('Cy'); C.send({ type: 'join', code, name: 'Cy' });
  const D = await make('Di'); D.send({ type: 'join', code, name: 'Di' });
  await D.until(s => s.players.length === 4);
  ok(A.state.players.length === 4, 'all 4 players visible live');
  B.send({ type: 'start' }); await sleep(100);
  ok(B.errors.some(e => /host/i.test(e)), 'only host can start');

  console.log('Round flow');
  A.send({ type: 'start' });
  await A.until(s => s.phase === 'reveal');
  const all = [A, B, C, D];
  await sleep(50);
  const words = all.map(c => c.state.word);
  ok(new Set(words).size === 2 && words.filter(w => w === words[0]).length !== 2 || new Set(words).size === 2, 'exactly two different words dealt');
  ok(all.every(c => !JSON.stringify(c.state).includes('imposterId')), 'imposter identity not leaked before results');
  await A.until(s => s.phase === 'clue');
  const order = A.state.order; const byId = id => all.find(c => c.state.selfId === id);

  console.log('Disconnect handling');
  const second = byId(order[1]); second.ws.close();                    // drops while it is not their turn
  const first = byId(order[0]);
  await first.until(s => s.turnId === order[0]);
  first.send({ type: 'clue', word: first.state.word }); await sleep(100);
  ok(first.errors.some(e => /own secret word/i.test(e)), 'cannot use your own secret word');
  first.send({ type: 'clue', word: 'alpha' });
  const third = byId(order[2]);
  ok(await third.until(s => s.turnId === order[2]), 'turn skips the disconnected player (no freeze)');
  ok(third.state.clues.some(c => c.skipped && c.playerId === order[1]), 'skipped player is marked in the clue list');
  third.send({ type: 'clue', word: 'ALPHA' }); await sleep(100);
  ok(third.errors.some(e => /already used/i.test(e)), 'duplicate clue rejected');
  third.send({ type: 'clue', word: 'bravo' });

  console.log('Turn timer');
  const fourth = byId(order[3]);
  await fourth.until(s => s.turnId === order[3]);
  ok(await fourth.until(s => s.phase === 'vote', 2500), 'AFK player is skipped by the turn timer, voting opens');

  console.log('Refresh / reconnect');
  const live = all.filter(c => c !== second);
  const refresher = live[0]; const oldToken = refresher.token; refresher.ws.close(); await sleep(100);
  const re = client(refresher.name); await re.open(); re.send({ type: 'join', code, name: refresher.name, token: oldToken });
  ok(await re.until(s => s.phase === 'vote' && s.selfId === refresher.state.selfId), 'refresh mid-round restores the same player and phase');
  live[live.indexOf(refresher)] = re;

  console.log('Voting & results');
  const ids = live.map(c => c.state.selfId);
  const imp = live.find(c => c.state.word === live.map(x => x.state.word).sort((a, b) => live.filter(y => y.state.word === a).length - live.filter(y => y.state.word === b).length)[0]);
  live[0].send({ type: 'vote', targetId: live[0].state.selfId }); await sleep(80);
  ok(live[0].errors.some(e => /another player/i.test(e)), 'cannot vote for yourself');
  const tgt = imp.state.selfId;
  for (const c of live) { const t = c === imp ? ids.find(i => i !== c.state.selfId) : tgt; c.send({ type: 'vote', targetId: t }); }
  ok(await live[0].until(s => s.phase === 'results'), 'results appear once all CONNECTED players voted (disconnected one ignored)');
  const res = live[0].state.results;
  ok(res.imposterId === tgt && res.playersWin === true, 'imposter correctly identified and players win');
  ok(live[0].state.players.find(p => p.id !== tgt && p.connected)?.score === 1 && live[0].state.players.find(p => p.id === tgt).score === 0, 'scores awarded (+1 per catcher)');

  console.log('Host transfer & cancellation');
  await sleep(500);
  const roster = live.map(c => c.state.players.map(p => p.name).join(','))[0];
  ok(live[0].state.players.length >= 3, `roster after round: ${roster}`);
  const hostClient = live.find(c => c.state.selfId === c.state.hostId);
  hostClient.ws.close();
  const other = live.find(c => c !== hostClient);
  ok(await other.until(s => s.hostId !== hostClient.state.selfId && s.hostId), 'host passes to another player after grace period');
  const rest = live.filter(c => c !== hostClient);
  const newHost = rest.find(c => c.state.selfId === c.state.hostId);
  newHost.send({ type: 'start' });
  await rest[0].until(s => s.phase === 'reveal');
  rest.find(c => c !== newHost).ws.close();
  ok(await newHost.until(s => s.phase === 'lobby' && /Fewer than 3/.test(s.message || ''), 3000), 'dropping below 3 mid-game returns everyone to the lobby with a message');

  console.log('Same session in two tabs');
  const T1 = await make('Solo'); T1.send({ type: 'create', name: 'Solo' }); await T1.until(s => s.room);
  const T2 = await make('Solo'); T2.send({ type: 'join', code: T1.state.room, name: 'Solo', token: T1.token });
  ok(await T2.until(s => s.room) && await sleep(100) === undefined && T1.kicked, 'duplicate session replaces the old one and the old tab is told');

  console.log('Lobby cleanup & rejoin');
  const R = await make('R'); R.send({ type: 'create', name: 'R' }); await R.until(s => s.room);
  const Q = await make('Q'); Q.send({ type: 'join', code: R.state.room, name: 'Q' }); await R.until(s => s.players.length === 2);
  Q.ws.close(); await sleep(700);
  ok(R.state.players.length === 1, 'player who left the lobby is removed after the grace period');
} catch (e) { console.error(e); failed++; }

console.log(`\n${passed} passed, ${failed} failed`);
srv.kill(); process.exit(failed ? 1 : 0);
