import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  pingInterval: 25000,
  pingTimeout: 20000,
});
const PORT = Number(process.env.PORT || 3001);
const rooms = new Map();
const MAX_PLAYERS = 10;
const ANSWER_MS = 15_000;
const REVEAL_MS = 6_000;
const LEADERBOARD_MS = 5_000;
const NOTE_MS = 520;
const GAP_MS = 110;
const NOTE_LENGTH_MS = 320;

export const RAGAS = {
  Shankarabharanam: { semitones: [0, 2, 4, 5, 7, 9, 11], description: 'Bright, open and uplifting — a major-scale feel.' },
  Mayamalavagowla: { semitones: [0, 1, 4, 5, 7, 8, 11], description: 'A distinctive, traditional Carnatic sound with a serious glow.' },
  Kalyani: { semitones: [0, 2, 4, 6, 7, 9, 11], description: 'Luminous and expansive, with a shimmering raised Ma.' },
  Kharaharapriya: { semitones: [0, 2, 3, 5, 7, 9, 10], description: 'Warm and expressive, with a mellow minor-color mood.' },
};
const SWARAS = ['Sa', 'Re', 'Ga', 'Ma', 'Pa', 'Da', 'Ni'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function cleanName(value) {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
}
function uniqueName(room, requested, exceptId = null) {
  const base = cleanName(requested) || 'Player';
  const occupied = new Set([...room.players.values()].filter(p => p.id !== exceptId).map(p => p.name.toLowerCase()));
  if (!occupied.has(base.toLowerCase())) return base;
  let n = 2;
  while (occupied.has(`${base} (${n})`.toLowerCase())) n++;
  return `${base} (${n})`;
}
function makePlayer(id, name, socket) {
  return {
    id, name, score: 0, connected: true, socketId: socket.id,
    answer: [], answerSubmitted: false, submittedAt: null, clearUsed: false,
    roundPoints: 0, lastRound: null,
  };
}
function makeRoom(socket, playerId, name, scale) {
  const code = makeCode();
  const player = makePlayer(playerId, cleanName(name) || 'Host', socket);
  const room = {
    code, hostId: player.id, players: new Map([[player.id, player]]), scale: RAGAS[scale] ? scale : 'Shankarabharanam',
    labelMode: 'swara', phase: 'lobby', round: 0, phrase: [], roundPlayerIds: [],
    listenStartAt: null, listenEndsAt: null, answerEndsAt: null, endsAt: null,
    results: [], previousPhase: null, pauseInfo: null, timer: null, failoverTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  socket.data.roomCode = code;
  socket.data.playerId = player.id;
  socket.join(code);
  return room;
}
function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
function schedule(room, at, callback) {
  clearRoomTimer(room);
  room.endsAt = at;
  room.timer = setTimeout(() => {
    room.timer = null;
    callback();
  }, Math.max(0, at - Date.now()));
}
function phraseLength(round) {
  return round <= 2 ? 3 : round <= 4 ? 4 : round === 5 ? 5 : 6;
}
function makePhrase(length) {
  const phrase = [0];
  while (phrase.length < length) {
    const previous = phrase[phrase.length - 1];
    const moves = [-2, -1, 1, 2];
    const candidates = moves.map(m => previous + m).filter(v => v >= 0 && v <= 6);
    let next = candidates[crypto.randomInt(candidates.length)];
    if (phrase.length > 1 && next === phrase[phrase.length - 2] && Math.random() < 0.7) {
      const alternatives = candidates.filter(v => v !== next && v !== phrase[phrase.length - 2]);
      if (alternatives.length) next = alternatives[crypto.randomInt(alternatives.length)];
    }
    phrase.push(next);
  }
  return phrase;
}
function allInRoundAnswered(room) {
  return room.roundPlayerIds.length > 0 && room.roundPlayerIds.every(id => room.players.get(id)?.answerSubmitted);
}
function serialise(room, playerId) {
  const self = room.players.get(playerId);
  const reveal = ['reveal', 'leaderboard', 'final'].includes(room.phase);
  const currentPlayers = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    isHost: p.id === room.hostId,
    answered: p.answerSubmitted,
    answer: reveal && room.roundPlayerIds.includes(p.id) ? [...p.answer] : undefined,
    roundPoints: reveal && room.roundPlayerIds.includes(p.id) ? p.roundPoints : undefined,
    correctCount: reveal && p.lastRound?.round === room.round ? p.lastRound.correctCount : undefined,
    perfect: reveal && p.lastRound?.round === room.round ? p.lastRound.perfect : undefined,
    speedBonus: reveal && p.lastRound?.round === room.round ? p.lastRound.speedBonus : undefined,
  }));
  const secondsLeft = room.endsAt ? Math.max(0, room.endsAt - Date.now()) : null;
  return {
    code: room.code, hostId: room.hostId, myId: playerId,
    isHost: playerId === room.hostId, phase: room.phase, previousPhase: room.previousPhase,
    scale: room.scale, scaleDescription: RAGAS[room.scale].description, ragaSemitones: RAGAS[room.scale].semitones,
    labelMode: room.labelMode, round: room.round, totalRounds: 6,
    phraseLength: room.round ? phraseLength(room.round) : 0,
    phrase: room.phase === 'lobby' || room.phase === 'paused' ? [] : [...room.phrase],
    players: currentPlayers,
    myAnswer: self ? [...self.answer] : [], myClearUsed: self?.clearUsed ?? false,
    canPlayThisRound: room.roundPlayerIds.includes(playerId),
    roundPlayerIds: [...room.roundPlayerIds],
    answersCount: room.roundPlayerIds.filter(id => room.players.get(id)?.answerSubmitted).length,
    roundPlayerCount: room.roundPlayerIds.length,
    results: room.results,
    endsAt: room.endsAt, listenStartAt: room.listenStartAt, listenEndsAt: room.listenEndsAt,
    answerEndsAt: room.answerEndsAt,
    secondsLeft: secondsLeft == null ? null : Math.ceil(secondsLeft / 1000),
    serverNow: Date.now(),
    playerCount: room.players.size,
    connectedCount: [...room.players.values()].filter(p => p.connected).length,
  };
}
function sendState(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('roomState', serialise(room, player.id));
  }
}
function sendError(socket, message) {
  socket.emit('gameError', { message });
}
function resetPlayerForRound(player) {
  player.answer = [];
  player.answerSubmitted = false;
  player.submittedAt = null;
  player.clearUsed = false;
  player.roundPoints = 0;
  player.lastRound = null;
}
function startGame(room, { resetScores = false } = {}) {
  clearRoomTimer(room);
  if (resetScores) {
    room.results = [];
    for (const player of room.players.values()) player.score = 0;
  }
  startRound(room, 1);
}
function startRound(room, round) {
  clearRoomTimer(room);
  room.round = round;
  room.phrase = makePhrase(phraseLength(round));
  room.roundPlayerIds = [...room.players.values()].filter(p => p.connected).map(p => p.id);
  for (const player of room.players.values()) resetPlayerForRound(player);
  room.phase = 'countdown';
  room.listenStartAt = null;
  room.listenEndsAt = null;
  room.answerEndsAt = null;
  schedule(room, Date.now() + 3000, () => startListen(room));
  sendState(room);
}
function startListen(room) {
  if (!rooms.has(room.code) || room.phase === 'paused') return;
  room.phase = 'listen';
  room.listenStartAt = Date.now() + 650;
  const duration = (room.phrase.length - 1) * (NOTE_MS + GAP_MS) + NOTE_LENGTH_MS;
  room.listenEndsAt = room.listenStartAt + duration;
  room.answerEndsAt = room.listenEndsAt + ANSWER_MS;
  schedule(room, room.listenEndsAt, () => startAnswer(room));
  sendState(room);
}
function startAnswer(room) {
  if (!rooms.has(room.code) || room.phase === 'paused') return;
  room.phase = 'answer';
  // The deadline is anchored to the scheduled end of the phrase, not transition-handler execution time.
  room.endsAt = room.answerEndsAt ?? (room.listenEndsAt + ANSWER_MS);
  sendState(room);
  if (allInRoundAnswered(room)) return finishRound(room);
  schedule(room, room.endsAt, () => finishRound(room));
}
function scorePlayer(room, player) {
  const answer = player.answer.slice(0, room.phrase.length);
  const correctCount = answer.reduce((total, note, index) => total + (note === room.phrase[index] ? 1 : 0), 0);
  const perfect = answer.length === room.phrase.length && answer.every((note, index) => note === room.phrase[index]);
  const speedBonus = perfect && player.submittedAt != null
    ? Math.max(0, Math.min(200, Math.floor(200 * Math.max(0, (room.answerEndsAt ?? Date.now()) - player.submittedAt) / ANSWER_MS)))
    : 0;
  const multiplier = room.round === 6 ? 2 : 1;
  const points = (correctCount * 100 + (perfect ? 200 : 0) + speedBonus) * multiplier;
  player.roundPoints = points;
  player.score += points;
  player.lastRound = { round: room.round, correctCount, perfect, speedBonus, points, answer: [...player.answer] };
  return {
    playerId: player.id, name: player.name, answer: [...player.answer],
    correctCount, perfect, speedBonus, points, totalScore: player.score,
  };
}
function finishRound(room) {
  clearRoomTimer(room);
  if (!['answer', 'paused'].includes(room.phase)) return;
  const roundResults = room.roundPlayerIds.map(id => {
    const p = room.players.get(id);
    if (!p) return null;
    return scorePlayer(room, p);
  }).filter(Boolean);
  room.results = roundResults;
  room.phase = 'reveal';
  schedule(room, Date.now() + REVEAL_MS, () => startLeaderboard(room));
  sendState(room);
}
function startLeaderboard(room) {
  if (!rooms.has(room.code) || room.phase === 'paused') return;
  room.phase = 'leaderboard';
  schedule(room, Date.now() + LEADERBOARD_MS, () => advanceAfterLeaderboard(room));
  sendState(room);
}
function advanceAfterLeaderboard(room) {
  if (room.round >= 6) {
    room.phase = 'final';
    room.endsAt = null;
    sendState(room);
    return;
  }
  startRound(room, room.round + 1);
}
function resetForLobby(room) {
  clearRoomTimer(room);
  room.phase = 'lobby';
  room.round = 0;
  room.phrase = [];
  room.roundPlayerIds = [];
  room.listenStartAt = room.listenEndsAt = room.answerEndsAt = room.endsAt = null;
  room.results = [];
  room.pauseInfo = null;
  for (const player of room.players.values()) {
    player.score = 0;
    resetPlayerForRound(player);
  }
}
function pauseForHostLoss(room) {
  if (room.phase === 'paused') return;
  clearRoomTimer(room);
  room.pauseInfo = {
    phase: room.phase,
    remainingMs: Math.max(0, (room.endsAt ?? Date.now()) - Date.now()),
    pausedAt: Date.now(),
  };
  room.previousPhase = room.phase;
  room.phase = 'paused';
  room.endsAt = null;
  sendState(room);
  if (room.failoverTimer) clearTimeout(room.failoverTimer);
  room.failoverTimer = setTimeout(() => {
    room.failoverTimer = null;
    const next = [...room.players.values()].find(p => p.id !== room.hostId && p.connected);
    if (!next) { sendState(room); return; }
    room.hostId = next.id;
    resumeAfterHostLoss(room);
  }, 30_000);
}
function resumeAfterHostLoss(room) {
  if (room.failoverTimer) clearTimeout(room.failoverTimer);
  room.failoverTimer = null;
  const info = room.pauseInfo;
  room.pauseInfo = null;
  if (!info) { sendState(room); return; }
  // Restart the melody if interrupted so every connected device hears the same complete phrase.
  if (info.phase === 'listen' || info.phase === 'countdown') {
    room.phase = 'countdown';
    schedule(room, Date.now() + 1500, () => startListen(room));
    sendState(room);
    return;
  }
  room.phase = info.phase;
  if (info.phase === 'answer') {
    room.answerEndsAt = Date.now() + info.remainingMs;
    room.endsAt = room.answerEndsAt;
    sendState(room);
    schedule(room, room.endsAt, () => finishRound(room));
    return;
  }
  if (info.phase === 'reveal') {
    schedule(room, Date.now() + info.remainingMs, () => startLeaderboard(room));
    sendState(room);
    return;
  }
  if (info.phase === 'leaderboard') {
    schedule(room, Date.now() + info.remainingMs, () => advanceAfterLeaderboard(room));
    sendState(room);
    return;
  }
  sendState(room);
}
function removePlayer(room, playerId, wasKicked = true) {
  const player = room.players.get(playerId);
  if (!player) return;
  if (player.socketId) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      if (wasKicked) socket.emit('kicked', { message: 'The host removed you from this room.' });
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
    }
  }
  room.players.delete(playerId);
  room.roundPlayerIds = room.roundPlayerIds.filter(id => id !== playerId);
  if (room.players.size === 0) {
    clearRoomTimer(room);
    rooms.delete(room.code);
  } else {
    if (room.hostId === playerId) room.hostId = [...room.players.values()].find(p => p.connected)?.id ?? [...room.players.keys()][0];
    sendState(room);
  }
}

io.on('connection', socket => {
  socket.emit('connected', { serverNow: Date.now() });
  socket.on('clockPing', ({ clientSentAt } = {}) => {
    socket.emit('clockPong', { clientSentAt: Number(clientSentAt) || Date.now(), serverNow: Date.now() });
  });

  socket.on('createRoom', ({ playerId, name, scale } = {}) => {
    if (!playerId) return sendError(socket, 'Your player ID is missing. Refresh and try again.');
    const existingCode = socket.data.roomCode;
    if (existingCode && rooms.has(existingCode)) socket.leave(existingCode);
    const room = makeRoom(socket, String(playerId).slice(0, 64), name, scale);
    sendState(room);
  });

  socket.on('joinRoom', ({ code, playerId, name } = {}) => {
    const roomCode = String(code ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const id = String(playerId ?? '').slice(0, 64);
    const room = rooms.get(roomCode);
    if (!room) return sendError(socket, 'Room not found. Check the four-letter code and try again.');
    if (!id) return sendError(socket, 'Your player ID is missing. Refresh and try again.');
    let player = room.players.get(id);
    if (!player && room.players.size >= MAX_PLAYERS) return sendError(socket, 'This room is full (10 players maximum).');
    if (player?.socketId && player.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(player.socketId);
      if (oldSocket) oldSocket.leave(room.code);
    }
    if (!player) {
      player = makePlayer(id, uniqueName(room, name), socket);
      room.players.set(id, player);
    } else {
      player.connected = true;
      player.socketId = socket.id;
      if (!player.name) player.name = uniqueName(room, name, id);
    }
    socket.data.roomCode = room.code;
    socket.data.playerId = id;
    socket.join(room.code);
    if (id === room.hostId && room.phase === 'paused') resumeAfterHostLoss(room);
    sendState(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    const playerId = socket.data.playerId;
    if (!room || !playerId) return;
    removePlayer(room, playerId, false);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  });

  socket.on('setScale', ({ scale } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.phase !== 'lobby') return;
    if (!RAGAS[scale]) return;
    room.scale = scale;
    sendState(room);
  });
  socket.on('setLabelMode', ({ mode } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !['swara', 'western'].includes(mode)) return;
    room.labelMode = mode;
    sendState(room);
  });
  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.phase !== 'lobby') return;
    if ([...room.players.values()].filter(p => p.connected).length < 2) return sendError(socket, 'At least two players must be connected to start.');
    startGame(room);
  });
  socket.on('tapNote', ({ index } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || room.phase !== 'answer' || !room.roundPlayerIds.includes(player.id)) return;
    if (player.answerSubmitted || player.answer.length >= room.phrase.length) return;
    const note = Number(index);
    if (!Number.isInteger(note) || note < 0 || note > 6) return;
    player.answer.push(note);
    if (player.answer.length === room.phrase.length) {
      player.answerSubmitted = true;
      player.submittedAt = Date.now();
    }
    if (allInRoundAnswered(room)) {
      finishRound(room);
    } else {
      sendState(room);
    }
  });
  socket.on('clearAnswer', () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || room.phase !== 'answer' || !room.roundPlayerIds.includes(player.id) || player.clearUsed) return;
    player.answer = [];
    player.answerSubmitted = false;
    player.submittedAt = null;
    player.clearUsed = true;
    sendState(room);
  });
  socket.on('skipPhase', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (room.phase === 'reveal') startLeaderboard(room);
    else if (room.phase === 'leaderboard') advanceAfterLeaderboard(room);
  });
  socket.on('kickPlayer', ({ targetId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.phase !== 'lobby' || targetId === room.hostId) return;
    removePlayer(room, String(targetId));
  });
  socket.on('playAgain', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.phase !== 'final') return;
    startGame(room, { resetScores: true });
  });
  socket.on('newGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.phase !== 'final') return;
    const oldCode = room.code;
    const newCode = makeCode();
    rooms.delete(oldCode);
    room.code = newCode;
    rooms.set(newCode, room);
    resetForLobby(room);
    for (const player of room.players.values()) {
      if (!player.socketId) continue;
      const s = io.sockets.sockets.get(player.socketId);
      if (s) {
        s.leave(oldCode);
        s.join(newCode);
        s.data.roomCode = newCode;
      }
    }
    sendState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    if (player.id === room.hostId) pauseForHostLoss(room);
    else sendState(room);
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'swara-showdown', rooms: rooms.size }));
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 2048);
  if (!text) return res.status(400).send('Missing QR text');
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 220, color: { dark: '#17172d', light: '#ffffff' }, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch { res.status(500).send('Could not create QR code'); }
});
app.get('/api/config', (_req, res) => res.json({ maxPlayers: MAX_PLAYERS, answerMs: ANSWER_MS, revealMs: REVEAL_MS, leaderboardMs: LEADERBOARD_MS, ragas: RAGAS }));
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist'), { maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
} else {
  app.get('/', (_req, res) => res.status(200).send('Swara Showdown server is up. Start the Vite app at http://localhost:5173'));
}

server.listen(PORT, '0.0.0.0', () => console.log(`Swara Showdown server listening on ${PORT}`));
