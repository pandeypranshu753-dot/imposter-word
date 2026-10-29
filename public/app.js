const app = document.getElementById('app'), statusEl = document.getElementById('connection'), toast = document.getElementById('toast');
let ws = null, state = null, connecting = false, stopReconnect = false, kicked = false, awaitingJoin = false;
let formName = localStorage.getItem('iw-name') || '', selectedVote = null, clock = null, toastTimer = null, localDeadline = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const roomCode = () => new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
// Session tokens live in sessionStorage: a refresh keeps you in the game, but a second tab is a separate player.
const getToken = code => { try { return sessionStorage.getItem(`iw-token-${code}`); } catch { return null; } };
const setToken = (code, t) => { try { sessionStorage.setItem(`iw-token-${code}`, t); } catch {} };
const clearToken = code => { try { sessionStorage.removeItem(`iw-token-${code}`); } catch {} };
let resuming = Boolean(roomCode() && getToken(roomCode()) && formName);

const me = () => state?.players.find(p => p.id === state.selfId);
const who = id => state?.players.find(p => p.id === id)?.name || 'Unknown';
const isHost = () => state?.selfId === state?.hostId;
const connectedCount = () => state.players.filter(p => p.connected).length;
const say = message => { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 4300); };
const setStatus = (live, text) => { statusEl.textContent = text || (live ? 'Live' : 'Offline'); statusEl.classList.toggle('offline', !live); };
const send = data => { if (ws?.readyState !== WebSocket.OPEN) { say('Not connected. Reconnecting…'); return; } ws.send(JSON.stringify(data)); };
const button = (text, action, cls = '') => `<button class="btn ${cls}" data-action="${action}">${text}</button>`;

function connect() {
  if (connecting || stopReconnect) return;
  connecting = true;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = sock;
  setStatus(false, 'Connecting…');
  sock.onopen = () => {
    connecting = false;
    setStatus(true);
    const code = state?.room || roomCode();
    const token = code && getToken(code);
    const name = state ? me()?.name : formName;
    if (code && name && token) { awaitingJoin = true; send({ type: 'join', code, name, token }); }
    else if (resuming) { resuming = false; render(); }
  };
  sock.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'error') {
      say(m.message);
      if (awaitingJoin) { // automatic re-join failed (room gone, name taken…): go back to the start screen
        awaitingJoin = false; resuming = false;
        const code = state?.room || roomCode();
        if (code) clearToken(code);
        state = null; render();
      }
      return;
    }
    if (m.type === 'kicked') {
      kicked = true; stopReconnect = true; state = null; resuming = false;
      const code = roomCode(); if (code) clearToken(code);
      render(); return;
    }
    if (m.type === 'state') {
      awaitingJoin = false; resuming = false;
      const changed = state?.phase !== m.phase || state?.round !== m.round;
      state = m;
      localDeadline = m.timeLeft != null ? Date.now() + m.timeLeft : null;
      formName = me()?.name || formName;
      localStorage.setItem('iw-name', formName);
      setToken(m.room, m.token);
      if (roomCode() !== m.room) history.replaceState({}, '', `/?room=${m.room}`);
      if (changed) selectedVote = null;
      render();
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // an old socket we already replaced
    connecting = false;
    setStatus(false, stopReconnect ? 'Disconnected' : 'Offline — reconnecting');
    if (!stopReconnect) setTimeout(connect, 1800);
  };
  sock.onerror = () => {};
}
// Phones freeze background tabs: reconnect the moment the player comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) connect();
});

function landing() {
  return `<section class="hero"><div class="eyebrow">The ultimate bluffing game</div><h1>One word.<br><span>One imposter.</span></h1><p>Everyone gets a secret word. One player gets a different one. Give clues, spot the odd one out, and vote!</p></section>
<section class="panel"><h2>Let's play 🎉</h2><label class="field" for="name">YOUR NICKNAME</label><input class="input" id="name" maxlength="18" placeholder="e.g. SneakyPanda" value="${esc(formName)}" autocomplete="nickname"><div class="space"></div>${button('Create a room ✦', 'create')}<div class="divider">or join your friends</div><label class="field" for="room">4-LETTER ROOM CODE</label><input class="input" id="room" maxlength="4" placeholder="ABCD" style="text-transform:uppercase;letter-spacing:5px" value="${esc(roomCode())}"><div class="space"></div>${button('Join room →', 'join', 'alt')}</section>`;
}
const resumePanel = () => `<section class="panel center"><h2>Rejoining your game…</h2><p class="muted">Hang tight, reconnecting to room ${esc(roomCode())}.</p></section>`;
const kickedPanel = () => `<section class="panel center"><h2>Opened somewhere else 🪟</h2><p class="muted">This game is now open in another tab or window, which took over your seat. Close this tab, or start over here with a different nickname.</p><div class="space"></div>${button('Back to start', 'home')}</section>`;

function heading(title, subtitle) {
  return `<div class="topline"><h2>${title}</h2><span class="tag">ROUND ${state.round || '—'}</span></div><div class="instruction">${subtitle}</div>`;
}
function playerList(mode = 'lobby') {
  return `<div class="players">${state.players.map(p => `<div class="player ${p.connected ? '' : 'disconnected'}"><div class="avatar">${esc(p.name[0]?.toUpperCase())}</div><div class="name">${esc(p.name)}${p.id === state.selfId ? '<span class="pill">YOU</span>' : ''}${p.id === state.hostId ? '<span class="pill">HOST</span>' : ''}</div><div class="meta">${!p.connected ? 'Disconnected' : mode === 'vote' ? (state.hasVoted.includes(p.id) ? '✓ Voted' : 'Waiting…') : mode === 'clue' ? (state.turnId === p.id ? '✦ Their turn' : 'Online') : '● Online'}</div></div>`).join('')}</div>`;
}
function lobby() {
  const active = connectedCount();
  return `<section class="panel">${heading('Game lobby 🛋️', 'Share the room code or link. The host can start when at least 3 players are connected.')}<div class="center muted">YOUR ROOM CODE</div><div class="code">${esc(state.room)}</div>${button('Copy invite link', 'copy', 'ghost')}<div class="space"></div><div class="topline"><h2>Players</h2><span class="tag">${active}/8 connected</span></div>${playerList()}${state.message ? `<div class="notice">${esc(state.message)}</div>` : ''}<div class="space"></div>${isHost() ? button(active < 3 ? 'Waiting for 3 players…' : 'Start game →', 'start') : '<p class="center muted">Waiting for the host to start…</p>'}<div class="space"></div>${button('Leave room', 'leave', 'ghost')}</section>`;
}
function reveal() {
  return `<section class="panel">${heading('Your secret word 🤫', 'Memorize your word! Nobody knows who has the different one — not even you.')}<div class="wordbox"><div class="caption">Your word</div><div class="word">${esc(state.word)}</div></div><div class="countdown" id="countdown"></div><p class="center muted">Don't show your screen to anyone.</p></section>`;
}
function clue() {
  const myTurn = state.turnId === state.selfId;
  const clues = state.clues.map(c => `<div class="clue"><span>${esc(who(c.playerId))}</span>${c.skipped ? '<span class="muted">skipped</span>' : `<strong>${esc(c.word)}</strong>`}</div>`).join('');
  return `<section class="panel">${heading('Clue time 💬', 'Take turns giving exactly one word that hints at your secret word, without saying the word itself.')}<div class="tag">${esc(state.category)} category</div><div class="wordbox" style="padding:18px"><div class="caption">Your secret word</div><div class="word" style="font-size:30px">${esc(state.word)}</div></div><div class="topline"><h2>${myTurn ? 'Your turn! ✨' : `${esc(who(state.turnId))}'s turn…`}</h2><span class="tag" id="countdown"></span></div>${myTurn ? `<label class="field" for="clue">YOUR ONE-WORD CLUE</label><input class="input" id="clue" maxlength="24" placeholder="Type one word…" autocomplete="off" autocapitalize="none"><div class="space"></div>${button('Submit clue →', 'clue')}` : '<p class="muted">Waiting for their clue to appear live.</p>'}<div class="space"></div><h2>Clues (${state.clues.length}/${state.order.length})</h2>${clues || '<p class="muted">No clues yet.</p>'}</section>`;
}
function vote() {
  const voted = state.myVote != null;
  const choices = state.order.filter(id => id !== state.selfId).map(id => `<label class="choice"><input type="radio" name="vote" value="${esc(id)}" ${selectedVote === id ? 'checked' : ''}><span>${esc(who(id))}</span></label>`).join('');
  const clues = state.clues.map(c => `<div class="clue"><span>${esc(who(c.playerId))}</span>${c.skipped ? '<span class="muted">skipped</span>' : `<strong>${esc(c.word)}</strong>`}</div>`).join('');
  return `<section class="panel">${heading('Who is the imposter? 🕵️', 'Vote for the player whose clue seems suspicious. Votes stay secret until everyone has voted.')}<h2>The clues</h2>${clues}<div class="space"></div><div class="topline"><h2>Cast your vote</h2><span class="tag">${state.hasVoted.length}/${connectedCount()} voted</span></div>${voted ? `<div class="instruction">✓ Vote locked in for ${esc(who(state.myVote))}. Waiting for everyone else…</div>` : `<div class="stack">${choices}</div><div class="space"></div>${button('Lock in vote →', 'vote')}`}<div class="space"></div><h2>Vote status</h2>${playerList('vote')}</section>`;
}
function result() {
  const r = state.results;
  const board = [...state.players].sort((a, b) => b.score - a.score).map(p => `<div class="clue"><span>${esc(p.name)}${p.id === state.selfId ? ' (you)' : ''}</span><strong>${p.score} pt${p.score === 1 ? '' : 's'}</strong></div>`).join('');
  const rows = state.order.map(id => `<div class="clue"><span>${esc(who(id))}</span><strong>${r.votes[id] ? `→ ${esc(who(r.votes[id]))}` : '— no vote'}</strong></div>`).join('');
  return `<section class="panel">${heading('The big reveal 🎭', 'See who had the different word and how everyone voted. Players win only if the imposter gets the most votes.')}<div class="result">${r.playersWin ? '🎉 Players win!' : '😈 Imposter wins!'}</div><p class="center muted">The imposter was</p><h2 class="center" style="font-size:36px;color:#ffdf6e">${esc(who(r.imposterId))}</h2><div class="wordbox"><div class="caption">Everyone else's word</div><div class="word" style="font-size:33px">${esc(r.normalWord)}</div><div class="space"></div><div class="caption">Imposter's word</div><div class="word" style="font-size:33px">${esc(r.imposterWord)}</div></div><h2>Who voted for whom</h2>${rows}<div class="space"></div><h2>Scoreboard</h2><p class="tiny">Catch the imposter: +1 for each other player. Escape: +2 for the imposter.</p>${board}<div class="space"></div>${isHost() ? button(connectedCount() >= 3 ? 'Play again ↻' : 'Waiting for 3 players…', 'start') : '<p class="center muted">Waiting for the host to start another round…</p>'}<div class="space"></div>${button('Leave room', 'leave', 'ghost')}</section>`;
}

function render() {
  // Keep a half-typed clue when the screen refreshes because of someone else's action.
  const prev = document.getElementById('clue'), typed = prev?.value, focused = prev && document.activeElement === prev;
  let html;
  if (kicked) html = kickedPanel();
  else if (!state) html = resuming ? resumePanel() : landing();
  else html = ({ lobby, reveal, clue, vote, results: result }[state.phase] || lobby)();
  app.innerHTML = html;
  if (typed) { const el = document.getElementById('clue'); if (el) { el.value = typed; if (focused) el.focus(); } }
  if (state && (state.phase === 'reveal' || state.phase === 'clue')) tick();
}
function tick() {
  clearTimeout(clock);
  const el = document.getElementById('countdown');
  if (!el || localDeadline == null) return;
  const s = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
  el.textContent = state.phase === 'reveal' ? `${s}s until clues begin` : `⏱ ${s}s`;
  if (s > 0) clock = setTimeout(tick, 250);
}

app.addEventListener('input', e => {
  if (e.target.id === 'name') formName = e.target.value;
  if (e.target.name === 'vote') selectedVote = e.target.value;
});
app.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'clue') app.querySelector('[data-action="clue"]')?.click();
  else if (e.target.id === 'room') app.querySelector('[data-action="join"]')?.click();
  else if (e.target.id === 'name') app.querySelector('[data-action="create"]')?.click();
});
app.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === 'create' || a === 'join') {
    const name = document.getElementById('name')?.value.trim();
    if (!name || name.length > 18) { say('Enter a nickname with 1–18 characters.'); return; }
    formName = name; localStorage.setItem('iw-name', name);
    if (a === 'create') send({ type: 'create', name });
    else {
      const code = document.getElementById('room').value.trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) { say('Enter the 4-letter room code.'); return; }
      send({ type: 'join', name, code, token: getToken(code) });
    }
  } else if (a === 'copy') {
    const url = `${location.origin}/?room=${state.room}`;
    try { await navigator.clipboard.writeText(url); say('Invite link copied!'); } catch { say(`Share this link: ${url}`); }
  } else if (a === 'start') {
    send({ type: 'start' });
  } else if (a === 'leave') {
    if (state) clearToken(state.room);
    send({ type: 'leave' });
    state = null; resuming = false; history.replaceState({}, '', '/'); render();
  } else if (a === 'home') {
    location.href = '/';
  } else if (a === 'clue') {
    const word = document.getElementById('clue')?.value.trim();
    if (!word || !/^\p{L}[\p{L}\p{N}'’-]*$/u.test(word) || word.length > 24) { say('Type a single word (24 characters max).'); return; }
    send({ type: 'clue', word });
    // do not clear the box: if the server rejects it (e.g. your own word) the player can just edit it
  } else if (a === 'vote') {
    if (!selectedVote) { say('Choose a player first.'); return; }
    send({ type: 'vote', targetId: selectedVote });
  }
});
render(); connect();
