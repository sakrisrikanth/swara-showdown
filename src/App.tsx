import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { io, Socket } from 'socket.io-client';

type Phase = 'lobby' | 'countdown' | 'listen' | 'answer' | 'reveal' | 'leaderboard' | 'final' | 'paused';
type Player = {
  id: string; name: string; score: number; connected: boolean; isHost: boolean; answered: boolean;
  answer?: number[]; roundPoints?: number; correctCount?: number; perfect?: boolean; speedBonus?: number;
};
type GameState = {
  code: string; hostId: string; myId: string; isHost: boolean; phase: Phase; previousPhase: Phase | null;
  scale: string; scaleDescription: string; ragaSemitones: number[]; labelMode: 'swara' | 'western';
  round: number; totalRounds: number; phraseLength: number; phrase: number[]; players: Player[];
  myAnswer: number[]; myClearUsed: boolean; canPlayThisRound: boolean; roundPlayerIds: string[];
  answersCount: number; roundPlayerCount: number; results: any[]; endsAt: number | null;
  listenStartAt: number | null; listenEndsAt: number | null; answerEndsAt: number | null;
  secondsLeft: number | null; serverNow: number; playerCount: number; connectedCount: number;
};

const RAGAS: Record<string, { semitones: number[]; description: string }> = {
  Shankarabharanam: { semitones: [0, 2, 4, 5, 7, 9, 11], description: 'Bright, open and uplifting — a major-scale feel.' },
  Mayamalavagowla: { semitones: [0, 1, 4, 5, 7, 8, 11], description: 'A distinctive Carnatic sound with a serious glow.' },
  Kalyani: { semitones: [0, 2, 4, 6, 7, 9, 11], description: 'Luminous and expansive, with a shimmering raised Ma.' },
  Kharaharapriya: { semitones: [0, 2, 3, 5, 7, 9, 10], description: 'Warm and expressive, with a mellow minor-color mood.' },
};
const SWARAS = ['Sa', 'Re', 'Ga', 'Ma', 'Pa', 'Da', 'Ni'];
const WESTERN = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Ti'];
const COLORS = ['#F7C35E', '#F18C69', '#E77699', '#B58AE3', '#7D9CF5', '#59C9C0', '#A8D96A'];
const AUDIO_NOTE_GAP_MS = 630;
const AUDIO_NOTE_LENGTH_MS = 320;

function getOrMakeId() {
  let id = localStorage.getItem('swara-player-id');
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `p-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem('swara-player-id', id);
  }
  return id;
}
function readName() { return localStorage.getItem('swara-player-name') || ''; }
function freqFor(index: number, semitones: number[]) {
  const midi = 60 + (semitones[index] ?? 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function formatScore(score: number) { return Math.max(0, score).toLocaleString('en-IN'); }
function phaseTitle(phase: Phase) {
  return ({ lobby: 'The stage is yours', countdown: 'Get ready', listen: 'Listen closely', answer: 'Play it back', reveal: 'The reveal', leaderboard: 'Scoreboard', final: 'The final podium', paused: 'Waiting for host' } as Record<Phase, string>)[phase];
}

export default function App() {
  const inviteRoomCode = new URLSearchParams(window.location.search)
    .get('room')
    ?.toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4) || '';
  const [name, setName] = useState(readName());
  const [joinCode, setJoinCode] = useState(inviteRoomCode);
  const [mode, setMode] = useState<'create' | 'join'>(inviteRoomCode.length === 4 ? 'join' : 'create');
  const [scaleChoice, setScaleChoice] = useState('Shankarabharanam');
  const [room, setRoom] = useState<GameState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [localLabels, setLocalLabels] = useState<'swara' | 'western'>('swara');
  const socketRef = useRef<Socket | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const playedRoundRef = useRef<string>('');
  const audioUnlockedRef = useRef(false);
  const offsetRef = useRef(0);
  const roomRef = useRef<GameState | null>(null);

  useEffect(() => { roomRef.current = room; }, [room]);

  const unlockAudio = useCallback(async () => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) throw new Error('Audio is not supported in this browser.');
      if (!audioRef.current) audioRef.current = new Ctx();
      if (audioRef.current.state === 'suspended') await audioRef.current.resume();
      // Tiny, silent warm-up oscillator primes audio on iOS after a user gesture.
      const ctx = audioRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.00001, ctx.currentTime);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.01);
      audioUnlockedRef.current = true;
      setAudioReady(true);
      return true;
    } catch (e: any) {
      setError(e?.message || 'Could not enable audio. Check your browser settings.');
      return false;
    }
  }, []);

  const playNote = useCallback((index: number, semitones?: number[], when?: number, duration = 0.32) => {
    const ctx = audioRef.current;
    if (!ctx) return;
    const st = semitones || roomRef.current?.ragaSemitones || RAGAS.Shankarabharanam.semitones;
    const start = Math.max(ctx.currentTime + 0.005, when ?? ctx.currentTime);
    const f = freqFor(index, st);
    const voice = (type: OscillatorType, hz: number, volume: number) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = type; osc.frequency.setValueAtTime(hz, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(start); osc.stop(start + duration + 0.03);
    };
    voice('triangle', f, 0.19);
    voice('sine', f * 2, 0.045);
  }, []);

  useEffect(() => {
    const socket = io({ autoConnect: true, reconnection: true, reconnectionAttempts: Infinity, timeout: 12000 });
    socketRef.current = socket;
    const helloTimer = window.setTimeout(() => { if (!socket.connected) setWaiting(true); }, 900);
    const pingClock = () => { socket.emit('clockPing', { clientSentAt: Date.now() }); };
    const clockInterval = window.setInterval(() => { if (socket.connected) pingClock(); }, 10000);
    socket.on('clockPong', ({ clientSentAt, serverNow }: { clientSentAt: number; serverNow: number }) => {
      const clientReceivedAt = Date.now();
      offsetRef.current = serverNow - (clientSentAt + clientReceivedAt) / 2;
    });
    socket.on('connect', () => {
      setWaiting(false); setBusy(false); setError('');
      pingClock();
      const storedCode = localStorage.getItem('swara-room-code');
      const playerId = getOrMakeId();
      if (storedCode) {
        socket.emit('joinRoom', { code: storedCode, playerId, name: localStorage.getItem('swara-player-name') || 'Player' });
      }
    });
    socket.on('disconnect', () => setWaiting(true));
    socket.on('connect_error', () => setWaiting(true));
    socket.on('roomState', (state: GameState) => {
      setRoom(state); roomRef.current = state;
      setBusy(false); setWaiting(false); setError('');
      localStorage.setItem('swara-room-code', state.code);
      localStorage.setItem('swara-player-name', name || readName() || 'Player');
    });
    socket.on('gameError', (payload: { message: string }) => {
      setError(payload.message); setBusy(false); setWaiting(false);
      if (/room not found/i.test(payload.message)) localStorage.removeItem('swara-room-code');
    });
    socket.on('kicked', (payload: { message: string }) => {
      setError(payload.message); setRoom(null); roomRef.current = null;
      localStorage.removeItem('swara-room-code'); setBusy(false);
    });
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => {
      window.clearTimeout(helloTimer); window.clearInterval(interval); window.clearInterval(clockInterval);
      socket.removeAllListeners(); socket.disconnect(); socketRef.current = null;
      if (audioRef.current) { void audioRef.current.close(); audioRef.current = null; }
    };
  }, []);

  useEffect(() => {
    if (!room || room.phase !== 'listen' || !room.canPlayThisRound || !room.listenStartAt || !audioReady) return;
    const key = `${room.code}-${room.round}-${room.listenStartAt}`;
    if (playedRoundRef.current === key) return;
    playedRoundRef.current = key;
    const ctx = audioRef.current;
    if (!ctx) return;
    const delay = room.listenStartAt - (Date.now() + offsetRef.current);
    const start = ctx.currentTime + Math.max(0, delay) / 1000;
    room.phrase.forEach((note, i) => playNote(note, room.ragaSemitones, start + i * AUDIO_NOTE_GAP_MS / 1000, 0.32));
  }, [room, playNote, audioReady]);

  const activeLabels = localLabels === 'swara' ? SWARAS : WESTERN;
  const currentServerTime = now + offsetRef.current;
  const msLeft = room?.endsAt ? Math.max(0, room.endsAt - currentServerTime) : 0;
  const secondsLeft = Math.ceil(msLeft / 1000);
  const activeListenIndex = useMemo(() => {
    if (!room || room.phase !== 'listen' || !room.listenStartAt) return -1;
    const elapsed = currentServerTime - room.listenStartAt;
    const ix = Math.floor(elapsed / AUDIO_NOTE_GAP_MS);
    return elapsed >= 0 && ix < room.phrase.length && elapsed - ix * AUDIO_NOTE_GAP_MS < AUDIO_NOTE_LENGTH_MS ? ix : -1;
  }, [room, currentServerTime]);

  const begin = async () => {
    setError('');
    const clean = name.trim().slice(0, 16);
    if (!clean) { setError('Add your name to join the game.'); return; }
    const enabled = await unlockAudio();
    if (!enabled) return;
    localStorage.setItem('swara-player-name', clean);
    setName(clean); setBusy(true); setWaiting(false);
    const socket = socketRef.current;
    if (!socket?.connected) {
      setWaiting(true);
      setError('The stage is waking up. Your connection will retry automatically.');
      return;
    }
    localStorage.removeItem('swara-room-code');
    if (mode === 'create') socket.emit('createRoom', { playerId: getOrMakeId(), name: clean, scale: scaleChoice });
    else {
      const code = joinCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (code.length !== 4) { setBusy(false); setError('Enter the four-letter room code.'); return; }
      socket.emit('joinRoom', { code, playerId: getOrMakeId(), name: clean });
    }
  };
  const emit = (event: string, payload?: any) => socketRef.current?.emit(event, payload);
  const leaveToHome = () => {
    emit('leaveRoom');
    localStorage.removeItem('swara-room-code'); setRoom(null); roomRef.current = null; setError('');
  };

  if (!room) {
    return <main className="app-shell home-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="brand"><div className="brand-mark"><span>♪</span><i>♫</i></div><div><div className="eyebrow">A MELODY MEMORY PARTY GAME</div><h1>Swara <span>Showdown</span></h1></div></header>
      <section className="home-grid">
        <div className="hero-copy">
          <p className="kicker">HEAR IT. FEEL IT. PLAY IT BACK.</p>
          <h2>How well can<br />you <em>remember</em><br />a melody?</h2>
          <p className="hero-intro">A little rhythm, a little instinct, and six rounds to prove your ears. Challenge friends from any phone or laptop.</p>
          <div className="feature-row"><span><b>♬</b> 2–10 players</span><span><b>◷</b> About 5 min</span><span><b>✳</b> 4 ragas</span></div>
          <div className="swara-ribbon" aria-hidden="true">{SWARAS.map((s, i) => <span key={s} style={{ background: COLORS[i], animationDelay: `${i * 80}ms` }}>{s}</span>)}</div>
        </div>
        <section className="join-card">
          <div className="card-topline"><span className="live-dot" /> THE JAM STARTS HERE</div>
          <h3>Take your place</h3><p className="muted">No account. No installs. Just listen and play.</p>
          <label className="field-label" htmlFor="playerName">YOUR PLAYER NAME</label>
          <input id="playerName" value={name} maxLength={16} placeholder="e.g. Melody Maker" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && begin()} autoComplete="nickname" />
          <div className="segmented"><button className={mode === 'create' ? 'selected' : ''} onClick={() => setMode('create')}>Create a room</button><button className={mode === 'join' ? 'selected' : ''} onClick={() => setMode('join')}>Join a room</button></div>
          {mode === 'create' ? <div className="scale-select-wrap"><label className="field-label" htmlFor="scaleChoice">CHOOSE YOUR MUSICAL MOOD</label><select id="scaleChoice" value={scaleChoice} onChange={e => setScaleChoice(e.target.value)}>{Object.entries(RAGAS).map(([key, r]) => <option key={key} value={key}>{key} — {r.description.split(' — ')[0]}</option>)}</select><div className="scale-explainer">{RAGAS[scaleChoice].description}</div></div> : <><label className="field-label" htmlFor="roomCode">FOUR-LETTER ROOM CODE</label><input id="roomCode" className="code-input" value={joinCode} maxLength={4} placeholder="ABCD" onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} onKeyDown={e => e.key === 'Enter' && begin()} autoCapitalize="characters" /></>}
          {mode === 'join' && joinCode.length === 4 && <p className="scale-explainer joining-room-note">Joining room {joinCode}</p>}
          <button className="primary-button join-button" onClick={begin} disabled={busy}>{busy ? <><span className="button-spinner" /> Joining the stage…</> : <>Tap to join <span>↗</span></>}</button>
          <p className="ios-tip">iPhone: turn off silent mode to hear the notes.</p>
          {waiting && <div className="wake-message"><span className="wake-spinner" /> <div><strong>Waking up the stage…</strong><small>The server may be starting after a quiet spell. We’ll reconnect automatically.</small></div></div>}
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="privacy-note"><span>♧</span> Your room is private to anyone with its code.</div>
        </section>
      </section>
      <footer className="home-footer"><span>SWARA SHOWDOWN <i>•</i> PLAY WITH YOUR EARS</span><span>MADE FOR EVERY KIND OF MUSIC LOVER</span></footer>
    </main>;
  }

  const me = room.players.find(p => p.id === room.myId);
  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const remaining = room.phraseLength - room.myAnswer.length;
  const shareLink = `${window.location.origin}/?room=${room.code}`;
  const ringPercent = room.phase === 'answer' ? Math.max(0, Math.min(100, msLeft / 15000 * 100)) : 100;
  const canAnswer = room.phase === 'answer' && room.canPlayThisRound && !me?.answered;
  const keyLabel = (index: number) => activeLabels[index];

  return <main className="app-shell game-shell">
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <header className="game-header"><button className="small-brand" onClick={leaveToHome} aria-label="Back to home"><span className="small-brand-icon">♪</span><span>Swara <b>Showdown</b></span></button><div className="game-header-right"><span className="room-code-pill"><span>ROOM</span> {room.code}</span><button className="icon-button" title="Copy room link" onClick={() => { void navigator.clipboard?.writeText(shareLink); setError('Room link copied — send it to your friends!'); }}><span>↗</span></button></div></header>

    {room.phase === 'lobby' ? <section className="lobby-layout">
      <div className="lobby-main">
        <div className="section-eyebrow"><span className="live-dot" /> ROOM LOBBY</div><h2>Gather your <em>players.</em></h2><p className="muted">The more ears, the merrier. You need at least two players to start.</p>
        <div className="room-share-card"><div><span className="field-label">YOUR ROOM CODE</span><div className="big-room-code">{room.code.split('').map((c, i) => <span key={i}>{c}</span>)}</div><p>Share this code with your crew</p><button className="text-button" onClick={() => { void navigator.clipboard?.writeText(shareLink); setError('Room link copied — send it to your friends!'); }}>Copy invite link ↗</button></div><div className="qr-wrap"><img src={`/api/qr?text=${encodeURIComponent(shareLink)}`} alt="QR code to join this room" /><small>SCAN TO JOIN</small></div></div>
        <div className="players-heading"><h3>On the stage <span>{room.playerCount}/10</span></h3><span className="muted small">{room.connectedCount} connected</span></div>
        <div className="players-list">{room.players.map((p, i) => <div className={`player-row ${p.id === room.myId ? 'player-self' : ''}`} key={p.id}><div className="player-avatar" style={{ background: COLORS[i % COLORS.length] }}>{p.name.slice(0, 1).toUpperCase()}</div><div className="player-name"><strong>{p.name}{p.id === room.myId ? ' (you)' : ''}</strong><small>{p.isHost ? 'HOST' : p.connected ? 'READY TO PLAY' : 'RECONNECTING…'}</small></div><div className="player-row-right">{p.isHost && <span className="host-tag">HOST ♛</span>}{room.isHost && p.id !== room.myId && <button className="kick-button" onClick={() => emit('kickPlayer', { targetId: p.id })} title={`Remove ${p.name}`}>×</button>}</div></div>)}</div>
      </div>
      <aside className="lobby-side"><div className="side-card"><div className="card-topline">✦ THE MUSICAL MOOD</div><h3>Pick a raga</h3><p className="muted small">Same seven keys. A whole new feeling.</p><div className="raga-list">{Object.entries(RAGAS).map(([key, r], i) => <button className={`raga-option ${room.scale === key ? 'active' : ''}`} key={key} onClick={() => room.isHost && emit('setScale', { scale: key })} disabled={!room.isHost}><span className="raga-dot" style={{ background: COLORS[(i + 1) % COLORS.length] }} /><span><strong>{key}</strong><small>{r.description}</small></span>{room.scale === key && <span className="checkmark">✓</span>}</button>)}</div>{!room.isHost && <p className="small muted">The host chooses the raga.</p>}<div className="how-to"><h4>HOW TO PLAY</h4><p><b>01</b> Listen to the phrase.</p><p><b>02</b> Tap the seven keys to repeat it.</p><p><b>03</b> Earn points for accuracy and speed.</p></div><button className="primary-button start-button" disabled={!room.isHost || room.connectedCount < 2} onClick={() => emit('startGame')}>{room.isHost ? room.connectedCount < 2 ? 'Waiting for one more player' : 'Start the showdown' : 'Waiting for host to start'} <span>→</span></button><div className="small muted center">6 rounds · Last round is worth double</div></div></aside>
      {error && <div className="floating-error" role="status">{error}<button onClick={() => setError('')}>×</button></div>}
    </section> : <section className="game-layout">
      <div className="game-topline"><div><div className="section-eyebrow"><span className="live-dot" /> {room.phase === 'paused' ? 'GAME PAUSED' : `ROUND ${room.round} OF 6`}</div><h2>{phaseTitle(room.phase)}{room.phase === 'answer' ? <span className="period">.</span> : <span className="period">.</span>}</h2><p className="muted">{room.phase === 'countdown' ? 'Get ready to catch the melody.' : room.phase === 'listen' ? 'Follow the glowing keys. The phrase starts on Sa.' : room.phase === 'answer' ? room.canPlayThisRound ? 'Tap the notes in the exact order you heard.' : 'You joined mid-round. You can play next round.' : room.phase === 'reveal' ? 'See how close your ears got.' : room.phase === 'leaderboard' ? 'Every note counts. Keep your eyes on the prize.' : room.phase === 'final' ? 'Six rounds down. Let’s celebrate those ears.' : 'The host disconnected. The game will resume when they return.'}</p></div><div className="phase-status"><div className={`timer-ring ${room.phase === 'answer' && secondsLeft <= 5 ? 'urgent' : ''}`} style={{ '--ring-progress': `${ringPercent}%` } as CSSProperties}><span>{room.phase === 'countdown' ? secondsLeft : room.phase === 'listen' ? '♫' : room.phase === 'answer' ? secondsLeft : room.phase === 'reveal' || room.phase === 'leaderboard' ? secondsLeft : room.phase === 'final' ? '★' : 'Ⅱ'}</span></div><small>{room.phase === 'answer' ? 'SECONDS LEFT' : room.phase === 'reveal' || room.phase === 'leaderboard' ? 'NEXT IN' : room.phase === 'listen' ? 'LISTEN' : room.phase === 'countdown' ? 'COUNTDOWN' : room.phase === 'final' ? 'CHAMPIONS' : 'ON PAUSE'}</small></div></div>

      {room.phase === 'countdown' && <div className="center-stage countdown-stage"><div className="pulse-orbit"><span>{Math.max(1, secondsLeft)}</span></div><p>Get ready to listen…</p></div>}
      {room.phase === 'listen' && <div className="center-stage listen-stage"><div className="listen-visual"><span className="sound-wave wave-one"/><span className="sound-wave wave-two"/><div className="sound-core">♫</div></div><p className="listening-label">Listen for the <strong>{room.phraseLength} notes</strong></p><div className="key-preview">{Array.from({ length: 7 }, (_, i) => <div className={`mini-key ${activeListenIndex === i ? 'lit' : ''}`} key={i} style={{ '--key-color': COLORS[i] } as CSSProperties}><span>{keyLabel(i)}</span></div>)}</div><p className="small muted">The notes will stop, then your 15 seconds begin.</p>{!audioReady && <button className="secondary-button enable-audio-button" onClick={() => void unlockAudio()}>Tap to enable sound</button>}</div>}

      {room.phase === 'answer' && <div className="answer-stage"><div className="answer-meta"><span>{room.canPlayThisRound ? me?.answered ? 'ANSWER LOCKED IN' : 'YOUR SEQUENCE' : 'WATCHING THIS ROUND'}</span><strong>{room.canPlayThisRound ? `${room.myAnswer.length} / ${room.phraseLength} notes` : 'Next round, you play'}</strong></div><div className="answer-slots">{Array.from({ length: room.phraseLength }, (_, i) => <div key={i} className={`answer-slot ${room.myAnswer[i] !== undefined ? 'filled' : ''} ${room.myAnswer[i] !== undefined && room.canPlayThisRound ? 'slot-glow' : ''}`} style={room.myAnswer[i] !== undefined ? { '--key-color': COLORS[room.myAnswer[i]] } as CSSProperties : undefined}>{room.myAnswer[i] !== undefined ? <><span>{keyLabel(room.myAnswer[i])}</span><small>{i + 1}</small></> : <span className="slot-number">{i + 1}</span>}</div>)}</div>{room.canPlayThisRound && <><div className="note-pad">{SWARAS.map((s, i) => <button key={s} className={`note-key ${localLabels === 'western' ? 'western' : ''}`} style={{ '--key-color': COLORS[i] } as CSSProperties} disabled={!canAnswer || room.myAnswer.length >= room.phraseLength} onClick={() => { playNote(i); emit('tapNote', { index: i }); }}><span className="note-key-light"/><strong>{keyLabel(i)}</strong><small>{s}</small></button>)}</div><div className="answer-controls"><button className="secondary-button" disabled={!canAnswer || room.myClearUsed || room.myAnswer.length === 0} onClick={() => emit('clearAnswer')}>↺ Clear {room.myClearUsed ? 'used' : 'once'}</button><span className="muted small">{me?.answered ? 'Nice! Your answer is in.' : remaining > 0 ? `${remaining} ${remaining === 1 ? 'note' : 'notes'} to go` : 'Answer submitted'}</span></div></>}{!room.canPlayThisRound && <div className="spectator-note">You joined after this round began. Stay tuned — you’re in from round {Math.min(6, room.round + 1)}.</div>}<div className="answer-count"><div className="answer-count-bar"><span style={{ width: `${room.roundPlayerCount ? room.answersCount / room.roundPlayerCount * 100 : 0}%` }}/></div><span>{room.answersCount} of {room.roundPlayerCount} players answered</span></div></div>}

      {room.phase === 'reveal' && <div className="reveal-stage"><div className="phrase-comparison"><div className="phrase-line-label">THE CORRECT PHRASE</div><div className="phrase-notes">{room.phrase.map((n, i) => <div className="phrase-note" key={i} style={{ '--key-color': COLORS[n] } as CSSProperties}><span>{keyLabel(n)}</span><small>{i + 1}</small></div>)}</div><div className="phrase-line-label your-line">PLAYER ANSWERS</div>{room.results.map((result: any) => <div className="result-row" key={result.playerId}><div className="result-player"><strong>{result.name}{result.playerId === room.myId ? ' (you)' : ''}</strong><small>{result.correctCount}/{room.phrase.length} notes right {result.perfect ? '· PERFECT' : ''}</small></div><div className="result-notes">{room.phrase.map((correct, i) => { const ans = result.answer?.[i]; const ok = ans === correct; return <span key={i} className={`result-note ${ok ? 'correct' : 'wrong'}`}>{ans === undefined ? '—' : keyLabel(ans)}</span>; })}</div><strong className="round-points">+{formatScore(result.points)}</strong></div>)}</div><div className="reveal-footer"><span className="badge-points">✦ +200 perfect bonus · Speed bonus up to 200{room.round === 6 ? ' · DOUBLE POINTS' : ''}</span>{room.isHost && <button className="secondary-button skip-button" onClick={() => emit('skipPhase')}>Skip reveal →</button>}</div></div>}

      {room.phase === 'leaderboard' && <div className="leaderboard-stage"><div className="leaderboard-panel"><div className="leaderboard-title"><span>♛</span><div><h3>Current standings</h3><p className="muted small">After round {room.round}</p></div></div>{sortedPlayers.map((p, i) => <div className={`leader-row ${p.id === room.myId ? 'you-row' : ''}`} key={p.id}><div className={`rank rank-${i + 1}`}>{i < 3 ? ['♛', '②', '③'][i] : String(i + 1).padStart(2, '0')}</div><div className="player-avatar small-avatar" style={{ background: COLORS[room.players.findIndex(q => q.id === p.id) % COLORS.length] }}>{p.name.slice(0, 1).toUpperCase()}</div><strong>{p.name}{p.id === room.myId ? ' (you)' : ''}</strong><span className="score-total">{formatScore(p.score)} <small>PTS</small></span></div>)}</div>{room.isHost && <button className="secondary-button skip-button board-skip" onClick={() => emit('skipPhase')}>{room.round === 6 ? 'Show podium now' : 'Next round now'} →</button>}</div>}

      {room.phase === 'final' && <div className="final-stage"><div className="confetti-strip">✦　✧　♫　✧　✦　♬　✧</div><div className="podium">{sortedPlayers.slice(0, 3).map((p, i) => <div className={`podium-person place-${i + 1}`} key={p.id}><div className="podium-crown">{['♛', '✦', '✦'][i]}</div><div className="podium-avatar" style={{ background: COLORS[room.players.findIndex(q => q.id === p.id) % COLORS.length] }}>{p.name.slice(0, 1).toUpperCase()}</div><strong>{p.name}</strong><span className="podium-score">{formatScore(p.score)} pts</span><div className="podium-block"><b>{[1, 2, 3][i]}</b></div></div>)}</div><div className="final-message"><span className="eyebrow">SIX ROUNDS · ONE MELODIC WINNER</span><h3>{sortedPlayers[0]?.name || 'The players'} <em>takes the crown!</em></h3><p className="muted">Every ear brought something to the stage. Run it back?</p></div>{room.isHost && <div className="final-actions"><button className="primary-button" onClick={() => emit('playAgain')}>Play again <span>↻</span></button><button className="secondary-button" onClick={() => emit('newGame')}>New game <span>＋</span></button></div>}</div>}

      {room.phase === 'paused' && <div className="center-stage paused-stage"><div className="paused-icon">Ⅱ</div><h3>Waiting for host</h3><p className="muted">The room has paused while the host reconnects. If they don’t return in 30 seconds, another player will take the lead.</p><div className="waiting-dots"><i/><i/><i/></div></div>}

      {room.phase !== 'final' && <div className="game-bottom"><div className="bottom-left"><span className="music-dot"/> <span>{room.scale}</span><span className="bottom-divider">/</span><button className="label-toggle" onClick={() => { const mode = localLabels === 'swara' ? 'western' : 'swara'; setLocalLabels(mode); }}>{localLabels === 'swara' ? 'Sa Re Ga…' : 'Do Re Mi…'} <span>↔</span></button></div><div className="bottom-right">{room.players.slice(0, 5).map((p, i) => <span title={p.name} className={`mini-avatar ${p.connected ? '' : 'offline'}`} style={{ background: COLORS[i % COLORS.length] }} key={p.id}>{p.name.slice(0, 1).toUpperCase()}</span>)}{room.playerCount > 5 && <span className="extra-players">+{room.playerCount - 5}</span>}<span className="player-count-label">{room.playerCount} playing</span></div></div>}
      {error && <div className="floating-error" role="status">{error}<button onClick={() => setError('')}>×</button></div>}
      {waiting && <div className="reconnect-toast"><span className="wake-spinner"/> Reconnecting to the stage…</div>}
    </section>}
  </main>;
}
