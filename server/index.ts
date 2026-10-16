import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { botTurnSteps, cardLabel, DammitGame, extendMeld, RuleError } from '../src/engine';
import { ClientMsg, GameKind, REACTIONS, SeatInfo, ServerMsg, snapshotFor, swoopSnapshotFor } from '../src/net/protocol';
import { describePlay, DEFAULT_TARGET, SwoopError, SwoopGame } from '../src/swoop/engine';
import { swoopBotSteps } from '../src/swoop/bot';
import { cardLabel as label } from '../src/engine/cards';

const PORT = Number(process.env.PORT) || 8787;
const MAX_SEATS = 20;
const SWOOP_HOLD_MS = 2800;                            // let everyone see a swooped pile before play moves on
const STEP_MS = Number(process.env.STEP_MS) || 1200;      // pause between bot actions
const DEAL_MS = Number(process.env.DEAL_MS) || 4800;      // let everyone's deal animation finish
const TAKEOVER_MS = Number(process.env.TAKEOVER_MS) || 10000; // a dropped player is replaced by a bot after this long
const BOT_NAMES = ['Ruby', 'Max', 'Ivy', 'Otis', 'Nora', 'Leo', 'Maya', 'Finn', 'Zoe', 'Hank', 'Lena', 'Jude', 'Cleo', 'Gus', 'Pearl', 'Walt', 'Dot', 'Ezra', 'Mabel', 'Ike'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

interface Seat { name: string; bot: boolean; token: string; ws: WebSocket | null; lostAt: number; lastReact?: number }

const meldCardIds = (g: DammitGame) => new Set(g.players.flatMap((p) => p.melds.flatMap((m) => m.cards.map((c) => c.id))));

class Room {
  seats: Seat[] = [];
  game: DammitGame | SwoopGame | null = null;
  kind: GameKind = 'dammit';
  target = DEFAULT_TARGET;
  gen: Generator<string, void> | null = null;
  genSeat = -1;
  timer: ReturnType<typeof setTimeout> | undefined;
  pauseUntil = 0;
  pausedFor: unknown = null;
  lastActive = Date.now();
  constructor(public code: string) {}

  humanSeats = () => this.seats.map((s, i) => ({ s, i })).filter((x) => !x.s.bot);
  hostSeat = () => this.humanSeats()[0]?.i ?? -1;
  connected = (s: Seat) => !!s.ws && s.ws.readyState === WebSocket.OPEN;
  info(): SeatInfo[] {
    const host = this.hostSeat();
    return this.seats.map((s, i) => ({ name: s.name, bot: s.bot, connected: s.bot || this.connected(s), host: i === host }));
  }
  send(s: Seat, m: ServerMsg) { if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(m)); }

  broadcastLobby() {
    const seats = this.info();
    this.seats.forEach((s, i) => this.send(s, { t: 'lobby', code: this.code, seat: i, seats, game: this.kind, target: this.target }));
  }

  /** Sends every seat its own view of the table. */
  broadcastState(lines: string[] = [], flash: number[] = [], actor: number | null = null, drawn: number | null = null, resumeSeat = -1) {
    const g = this.game!;
    const seats = this.info();
    this.seats.forEach((s, i) => this.send(s, {
      t: 'state', kind: this.kind, seat: i, snap: g instanceof SwoopGame ? swoopSnapshotFor(g, i) : snapshotFor(g, i), lines, flash, actor, drawn: actor === i ? drawn : null, resume: i === resumeSeat, seats,
    }));
  }

  freeBotName(): string {
    const used = new Set(this.seats.map((s) => s.name));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    return free.length ? free[Math.floor(Math.random() * free.length)] : `Bot ${this.seats.length + 1}`;
  }

  start() {
    const names = this.seats.map((s) => s.name);
    this.game = this.kind === 'swoop' ? new SwoopGame(names, { target: this.target }) : new DammitGame(names);
    this.gen = null;
    this.pauseUntil = Date.now() + (this.kind === 'swoop' ? 1500 : DEAL_MS);
    this.broadcastState();
    this.schedule();
  }

  /** Is the seat whose turn it is played by the server (a bot, or a human who has dropped)? */
  automated(i: number): boolean {
    const s = this.seats[i];
    return s.bot || (!this.connected(s) && Date.now() - s.lostAt >= TAKEOVER_MS);
  }

  schedule() {
    clearTimeout(this.timer);
    const g = this.game;
    if (!g || g.status !== 'playing') return;
    if (g instanceof SwoopGame && (g.lastPlay?.swoop || g.lastPlay?.took) && g.lastPlay !== this.pausedFor) { this.pausedFor = g.lastPlay; this.pauseUntil = Date.now() + SWOOP_HOLD_MS; }
    let wait = Math.max(0, this.pauseUntil - Date.now());
    if (this.gen && this.genSeat !== g.current) this.gen = null;
    if (!this.gen) {
      const s = this.seats[g.current];
      if (!s.bot) {
        if (this.connected(s)) return; // waiting for a human
        wait = Math.max(wait, TAKEOVER_MS - (Date.now() - s.lostAt)); // give a dropped player a moment to come back
      }
    }
    this.timer = setTimeout(() => this.tick(), Math.max(wait, this.gen ? STEP_MS : STEP_MS));
  }

  tick() {
    const g = this.game;
    if (!g || g.status !== 'playing') return;
    if (this.gen && this.genSeat !== g.current) this.gen = null; // stale: that turn already finished
    if (!this.gen && !this.automated(g.current)) return this.schedule();
    const actor = g.current;
    if (!this.gen) { this.gen = g instanceof SwoopGame ? swoopBotSteps(g) : botTurnSteps(g); this.genSeat = g.current; }
    const before = g instanceof DammitGame ? meldCardIds(g) : new Set<number>();
    const step = this.gen.next();
    if (step.done) {
      this.gen = null;
    } else {
      const lines = [step.value];
      const flash = g instanceof DammitGame && / played .* onto | laid down /.test(step.value) ? [...meldCardIds(g)].filter((i) => !before.has(i)) : [];
      this.broadcastState(lines, flash, actor);
    }
    if (g.status !== 'playing' && step.done) this.broadcastState();
    this.schedule();
  }

  act(seat: number, m: Extract<ClientMsg, { t: 'act' }>) {
    const g = this.game, s = this.seats[seat];
    if (!g || !s) return;
    if (g instanceof SwoopGame) return this.actSwoop(g, seat, s, m);
    try {
      if (g.status !== 'playing') throw new RuleError('The hand is over');
      if (g.current !== seat) throw new RuleError("It's not your turn");
      if (this.gen && this.genSeat === seat) throw new RuleError('A bot is finishing your turn, one moment…');
      this.gen = null;
      const p = g.players[seat];
      const lines: string[] = [];
      let flash: number[] = [];
      let drawn: number | null = null;
      const before = meldCardIds(g);
      const changed = () => [...meldCardIds(g)].filter((i) => !before.has(i));
      switch (m.a) {
        case 'draw': {
          const c = g.draw(m.from);
          if (c) { drawn = c.id; lines.push(`${p.name} drew ${cardLabel(c)} ${m.from === 'deck' ? 'from the deck' : 'from the discard pile'}`); }
          else lines.push('Stalemate: nobody can make progress');
          break;
        }
        case 'objective': {
          const lvl = p.level + 1;
          g.layObjective(m.groups);
          flash = changed();
          lines.push(`${p.name} laid down level ${lvl}`);
          break;
        }
        case 'meld':
          g.layMeld(m.ids);
          flash = changed();
          lines.push(`${p.name} laid a new meld`);
          break;
        case 'discard': {
          const c = p.hand.find((h) => h.id === m.id);
          if (!c) throw new RuleError('Card not in hand');
          g.discard(m.id);
          lines.push(`${p.name} discarded ${cardLabel(c)}`);
          break;
        }
        case 'layon':
          if (!m.plays.length || m.plays.length > 60) throw new RuleError('Nothing to play');
          for (const pl of m.plays) {
            if (g.status !== 'playing') break;
            const c = p.hand.find((h) => h.id === pl.id);
            if (!c) throw new RuleError('Card not in hand');
            const target = g.players[pl.player]?.melds[pl.meld];
            if (!target || !extendMeld(target, c)) throw new RuleError('Card does not extend that meld');
            g.layOn(pl.id, { player: pl.player, meld: pl.meld });
            flash.push(pl.id);
            lines.push(`${p.name} played ${cardLabel(c)} onto ${g.players[pl.player].name}'s meld`);
          }
          break;
      }
      if (g.status !== 'playing' && g.lastHandWinner === seat) lines.push(`${p.name} went out!`);
      this.broadcastState(lines, flash, seat, drawn);
      this.schedule();
    } catch (e) {
      this.send(s, { t: 'err', msg: e instanceof RuleError ? e.message : 'Something went wrong' });
    }
  }

  actSwoop(g: SwoopGame, seat: number, s: Seat, m: Extract<ClientMsg, { t: 'act' }>) {
    try {
      if (g.status !== 'playing') throw new SwoopError('The round is over');
      if (g.current !== seat) throw new SwoopError("It's not your turn");
      if (this.gen && this.genSeat === seat) throw new SwoopError('A bot is finishing your turn, one moment…');
      this.gen = null;
      const name = g.players[seat].name;
      const lines: string[] = [];
      switch (m.a) {
        case 'splay':
          if (!Array.isArray(m.ids) || m.ids.length > 60) throw new SwoopError('Select the card(s) to play');
          lines.push(describePlay(name, g.play(m.ids.map(Number))));
          break;
        case 'sflip': {
          const slot = Number(m.slot);
          const card = g.players[seat].mystery[slot];
          const res = g.flip(slot);
          lines.push(res.took
            ? `${name} flipped ${label(res.card)}: too high, took the pile (${g.lastPlay!.count} cards)`
            : `${name} flipped a mystery card: ${label(card ?? res.card)}`);
          break;
        }
        case 'stake': lines.push(describePlay(name, g.take(Number(m.id)))); break;
        default: throw new SwoopError('Unknown move');
      }
      if (g.status !== 'playing') lines.push(g.lastOut === null ? 'Nobody could go out: round ends' : `${g.players[g.lastOut].name} went out!`);
      this.broadcastState(lines, [], seat);
      this.schedule();
    } catch (e) {
      this.send(s, { t: 'err', msg: e instanceof SwoopError ? e.message : 'Something went wrong' });
    }
  }

  nextHand() {
    const g = this.game;
    if (!g) return;
    if (g instanceof SwoopGame) {
      if (g.status !== 'roundOver') return;
      g.nextRound();
      this.gen = null;
      this.pauseUntil = Date.now() + 1500;
      this.broadcastState([`Round ${g.roundNumber} dealt`]);
      return this.schedule();
    }
    if (g.status !== 'handOver') return;
    g.nextHand();
    this.gen = null;
    this.pauseUntil = Date.now() + DEAL_MS;
    this.broadcastState([`Hand ${g.handNumber} dealt`]);
    this.schedule();
  }
}

const rooms = new Map<string, Room>();
const where = new WeakMap<WebSocket, { room: Room; seat: number }>();

function newCode(): string {
  for (;;) {
    const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    if (!rooms.has(c)) return c;
  }
}
const cleanName = (n: unknown) => (typeof n === 'string' ? n.trim().slice(0, 16) : '') || 'Player';
const token = () => randomBytes(12).toString('hex');

function attach(ws: WebSocket, room: Room, seat: number) {
  room.seats[seat].ws = ws;
  where.set(ws, { room, seat });
  room.lastActive = Date.now();
}

function detach(ws: WebSocket) {
  const w = where.get(ws);
  if (!w) return;
  where.delete(ws);
  const { room, seat } = w;
  const s = room.seats[seat];
  if (!s || s.ws !== ws) return;
  s.ws = null;
  s.lostAt = Date.now();
  if (!room.game) {
    room.seats.splice(seat, 1); // in the lobby a dropped player just leaves
    room.seats.forEach((x) => { const ww = x.ws && where.get(x.ws); if (ww) ww.seat = room.seats.indexOf(x); });
    room.broadcastLobby();
  } else {
    room.broadcastState();
    room.schedule();
  }
}

function handle(ws: WebSocket, m: ClientMsg) {
  const send = (x: ServerMsg) => ws.send(JSON.stringify(x));
  const w = where.get(ws);
  switch (m.t) {
    case 'create': {
      if (w) return;
      if (rooms.size > 200) return send({ t: 'err', msg: 'Server is full, try later' });
      const room = new Room(newCode());
      room.kind = m.game === 'swoop' ? 'swoop' : 'dammit';
      rooms.set(room.code, room);
      const tk = token();
      room.seats.push({ name: cleanName(m.name), bot: false, token: tk, ws: null, lostAt: 0 });
      attach(ws, room, 0);
      send({ t: 'joined', code: room.code, seat: 0, token: tk });
      return room.broadcastLobby();
    }
    case 'join': {
      if (w) return;
      const room = rooms.get(String(m.code).toUpperCase().trim());
      if (!room) return send({ t: 'err', msg: 'No room with that code' });
      const name = cleanName(m.name);
      if (room.game) {
        // Game already running: a dropped player can reclaim their seat by name.
        const i = room.seats.findIndex((s) => !s.bot && !room.connected(s) && s.name.toLowerCase() === name.toLowerCase());
        if (i < 0) return send({ t: 'err', msg: 'That game has already started' });
        attach(ws, room, i);
        send({ t: 'joined', code: room.code, seat: i, token: room.seats[i].token });
        return room.broadcastState([], [], null, null, i);
      }
      if (room.seats.length >= MAX_SEATS) return send({ t: 'err', msg: 'Room is full' });
      let nm = name;
      for (let n = 2; room.seats.some((s) => s.name.toLowerCase() === nm.toLowerCase()); n++) nm = `${name.slice(0, 13)} ${n}`;
      const tk = token();
      room.seats.push({ name: nm, bot: false, token: tk, ws: null, lostAt: 0 });
      const i = room.seats.length - 1;
      attach(ws, room, i);
      send({ t: 'joined', code: room.code, seat: i, token: tk });
      return room.broadcastLobby();
    }
    case 'rejoin': {
      if (w) return;
      const room = rooms.get(String(m.code).toUpperCase().trim());
      const i = room ? room.seats.findIndex((s) => !s.bot && s.token === m.token) : -1;
      if (!room || i < 0) return send({ t: 'err', msg: 'That room has ended' });
      const old = room.seats[i].ws;
      if (old && old !== ws) { where.delete(old); old.close(); }
      attach(ws, room, i);
      send({ t: 'joined', code: room.code, seat: i, token: m.token });
      return room.game ? room.broadcastState([], [], null, null, i) : room.broadcastLobby();
    }
  }
  if (!w) return send({ t: 'err', msg: 'Not in a room' });
  const { room, seat } = w;
  room.lastActive = Date.now();
  switch (m.t) {
    case 'react': {
      if (!room.game || !REACTIONS.includes(String(m.e))) return;
      const now = Date.now();
      if (now - (room.seats[seat].lastReact ?? 0) < 700) return; // no spamming
      room.seats[seat].lastReact = now;
      room.seats.forEach((s) => room.send(s, { t: 'react', seat, name: room.seats[seat].name, e: m.e }));
      return;
    }
    case 'addbot':
      if (room.game || seat !== room.hostSeat() || room.seats.length >= MAX_SEATS) return;
      room.seats.push({ name: room.freeBotName(), bot: true, token: '', ws: null, lostAt: 0 });
      return room.broadcastLobby();
    case 'removebot':
      if (room.game || seat !== room.hostSeat() || !room.seats[m.seat]?.bot) return;
      room.seats.splice(m.seat, 1);
      room.seats.forEach((x) => { const ww = x.ws && where.get(x.ws); if (ww) ww.seat = room.seats.indexOf(x); });
      return room.broadcastLobby();
    case 'settarget':
      if (room.game || room.kind !== 'swoop' || seat !== room.hostSeat()) return;
      room.target = Math.min(100000, Math.max(1, Math.round(Number(m.target)) || DEFAULT_TARGET));
      return room.broadcastLobby();
    case 'start':
      if (room.game || seat !== room.hostSeat()) return;
      if (room.seats.length < 2) return send({ t: 'err', msg: 'Add a friend or a bot first' });
      if (room.kind === 'swoop') room.target = Math.min(100000, Math.max(1, Math.round(Number(m.target)) || DEFAULT_TARGET));
      return room.start();
    case 'tolobby':
      if (!room.game || seat !== room.hostSeat()) return;
      clearTimeout(room.timer);
      room.game = null; room.gen = null;
      room.seats = room.seats.filter((s) => s.bot || room.connected(s));
      room.seats.forEach((x) => { const ww = x.ws && where.get(x.ws); if (ww) ww.seat = room.seats.indexOf(x); });
      return room.broadcastLobby();
    case 'next': return room.nextHand();
    case 'act': return room.act(seat, m);
    case 'leave': {
      where.delete(ws);
      const s = room.seats[seat];
      if (!room.game) {
        room.seats.splice(seat, 1);
        room.seats.forEach((x) => { const ww = x.ws && where.get(x.ws); if (ww) ww.seat = room.seats.indexOf(x); });
        room.broadcastLobby();
      } else if (s) {
        s.bot = true; s.ws = null; // a bot takes over for good
        room.broadcastState(); room.schedule();
      }
      send({ t: 'left' });
      if (!room.humanSeats().length) { clearTimeout(room.timer); rooms.delete(room.code); }
    }
  }
}

// ---------- http (also serves the built game so one process can host everything) + websocket ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('Not found'); return; }
  res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  (ws as any).alive = true;
  ws.on('pong', () => { (ws as any).alive = true; });
  ws.on('message', (data) => {
    let m: ClientMsg;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); ws.send(JSON.stringify({ t: 'err', msg: 'Something went wrong' })); }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => detach(ws));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!(ws as any).alive) { ws.terminate(); return; }
    (ws as any).alive = false;
    ws.ping();
  });
  for (const [code, room] of rooms) {
    if (room.seats.some((s) => !s.bot && room.connected(s))) room.lastActive = Date.now();
    else if (Date.now() - room.lastActive > 15 * 60_000) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 25_000);

server.listen(PORT, () => console.log(`Dammit server on :${PORT}`));
