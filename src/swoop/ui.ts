import type { SfxName } from '../ui/audio';
import { Card, cardLabel } from '../engine/cards';
import { ClientMsg, mirrorSwoop, SwoopSnapshot } from '../net/protocol';
import { describePlay, rankName, SWOOP_RANK, SwoopError, SwoopGame, SwoopPlayer } from './engine';
import { swoopBotSteps } from './bot';

export interface SwoopEnv {
  app: HTMLElement;
  esc(s: string): string;
  sfx(n: SfxName): void;
  soundControls(): string;
  speedControl(): string;
  botDelay(): number;
  send(m: ClientMsg): void;
  /** Leave to the home screen (online: leaves the room). */
  leave(): void;
  /** Host only (online): everyone back to the lobby. */
  toLobby(): void;
  isHost(): boolean;
  /** Solo game finished and the player wants another: back to the Swoop setup page. */
  newSolo(): void;
}

const SUIT: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

type Move = { a: 'splay'; ids: number[] } | { a: 'sflip'; slot: number } | { a: 'stake'; id: number };

export class SwoopUI {
  private g: SwoopGame | null = null;
  private me = 0;
  private net = false;
  private selected = new Set<number>();
  private armed: number | null = null;
  private message = '';
  private log: string[] = [];
  private panel: 'log' | 'scores' | null = null;
  private overlayKey = '';
  private announcedKey = '';
  private timer = 0;
  private gen: Generator<string, void> | null = null;
  private flashIds = new Set<number>();
  private flashTimer = 0;
  private seatInfo: { name: string; bot: boolean; connected: boolean; host: boolean }[] = [];

  constructor(private env: SwoopEnv) {}

  active(): boolean { return !!this.g; }

  dispose() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.flashTimer);
    this.gen = null;
    this.g = null;
  }

  // ---------- starting / receiving ----------

  startSolo(names: string[], target: number) {
    this.dispose();
    this.net = false;
    this.me = 0;
    this.g = new SwoopGame(names, { target });
    this.resetRound();
    this.log = [];
    this.overlayKey = this.announcedKey = '';
    this.render();
    this.schedule();
  }

  applyState(snap: SwoopSnapshot, seat: number, lines: string[], resume: boolean, seats: SwoopUI['seatInfo']) {
    const prev = this.g;
    const wasMine = !!prev && prev.status === 'playing' && prev.current === this.me && this.net;
    this.net = true;
    this.me = seat;
    this.seatInfo = seats;
    const g = mirrorSwoop(snap);
    const newRound = !prev || prev.roundNumber !== g.roundNumber;
    this.g = g;
    if (newRound) { this.resetRound(); if (!prev) this.log = []; }
    if (resume) this.announcedKey = this.overlayKey = this.keyOf(g);
    this.noteLines(lines);
    this.afterChange();
    if (!wasMine && !newRound && g.status === 'playing' && g.current === seat) this.env.sfx('turn');
    this.render();
  }

  // ---------- shared plumbing ----------

  private keyOf(g: SwoopGame) { return `${g.roundNumber}-${g.status}`; }

  private resetRound() {
    this.selected.clear(); this.armed = null; this.message = ''; this.panel = null; this.gen = null;
    this.flashIds.clear();
  }

  private noteLines(lines: string[]) {
    for (const l of lines) this.log.unshift(l);
    this.log.length = Math.min(this.log.length, 60);
    lines.slice(0, 4).forEach((l, i) => {
      const fx = /SWOOP/.test(l) ? 'lay' : /took the pile/.test(l) ? 'draw' : /flipped/.test(l) ? 'tick' : /played/.test(l) ? 'discard' : null;
      if (fx) window.setTimeout(() => this.env.sfx(fx), i * 90);
    });
    const lp = this.g?.lastPlay;
    if (lp && !lp.took) {
      lp.ids.forEach((i) => this.flashIds.add(i));
      window.clearTimeout(this.flashTimer);
      this.flashTimer = window.setTimeout(() => { this.flashIds.clear(); if (this.g) this.render(); }, 1200);
    }
  }

  /** Drop selections that are no longer possible; announce round / game end. */
  private afterChange() {
    const g = this.g!;
    const have = new Set(g.available(g.players[this.me]).map((c) => c.id));
    for (const id of [...this.selected]) if (!have.has(id)) this.selected.delete(id);
    if (g.revealed && g.current === this.me) this.selected.add(g.revealed.id);
    if (this.armed !== null && !g.flippable(g.players[this.me]).includes(this.armed)) this.armed = null;
    if (g.status === 'playing') return;
    const key = this.keyOf(g);
    if (key === this.announcedKey) return;
    this.announcedKey = key;
    const mine = g.status === 'gameOver' ? g.winners.includes(this.me) : g.lastOut === this.me;
    const fx: SfxName = g.status === 'gameOver' ? (mine ? 'gameWon' : 'gameOver') : (mine ? 'handWon' : 'handOver');
    window.setTimeout(() => this.env.sfx(fx), 350);
    window.setTimeout(() => { this.overlayKey = key; if (this.g) this.render(); }, 2600);
  }

  private myTurn(): boolean {
    const g = this.g!;
    return g.status === 'playing' && g.current === this.me;
  }

  // ---------- moves ----------

  private act(m: Move) {
    const g = this.g!;
    if (!this.myTurn()) { this.message = "It's not your turn"; return this.render(); }
    this.message = '';
    if (this.net) {
      this.env.send({ t: 'act', ...m } as ClientMsg);
      return;
    }
    try {
      const name = g.players[this.me].name;
      const lines: string[] = [];
      if (m.a === 'splay') lines.push(describePlay(name, g.play(m.ids)));
      else if (m.a === 'stake') lines.push(describePlay(name, g.take(m.id)));
      else {
        const card = g.players[this.me].mystery[m.slot];
        const res = g.flip(m.slot);
        lines.push(res.took ? `${name} flipped ${cardLabel(res.card)}: too high, took the pile (${g.lastPlay!.count} cards)` : `${name} flipped a mystery card: ${cardLabel(card ?? res.card)}`);
      }
      if (g.status !== 'playing') lines.push(g.lastOut === null ? 'Nobody could go out: round ends' : `${g.players[g.lastOut].name} went out!`);
      this.selected.clear(); this.armed = null;
      this.noteLines(lines);
      this.afterChange();
    } catch (e) {
      this.message = e instanceof SwoopError ? e.message : String(e);
    }
    this.render();
    this.schedule();
  }

  /** Solo: bots take their actions one at a time, paced by the speed setting. */
  private schedule() {
    window.clearTimeout(this.timer);
    const g = this.g;
    if (this.net || !g || g.status !== 'playing' || g.current === this.me) { this.gen = null; return; }
    this.timer = window.setTimeout(() => {
      const g2 = this.g;
      if (!g2 || g2.status !== 'playing') return;
      this.gen ??= swoopBotSteps(g2);
      const step = this.gen.next();
      if (step.done) {
        this.gen = null;
        if (g2.status === 'playing' && g2.current === this.me) this.env.sfx('turn');
      } else {
        const lines = [step.value];
        if (g2.status !== 'playing') lines.push(g2.lastOut === null ? 'Nobody could go out: round ends' : `${g2.players[g2.lastOut].name} went out!`);
        this.noteLines(lines);
        this.afterChange();
      }
      this.render();
      this.schedule();
    }, this.env.botDelay());
  }

  private nextRound() {
    if (this.net) { this.env.send({ t: 'next' }); return; }
    const g = this.g!;
    if (g.status !== 'roundOver') return;
    g.nextRound();
    this.resetRound();
    this.noteLines([`Round ${g.roundNumber} dealt`]);
    this.render();
    this.schedule();
  }

  // ---------- selection ----------

  private toggle(c: Card) {
    const g = this.g!;
    if (!this.myTurn()) return;
    this.message = '';
    const cur = [...this.selected].map((id) => g.available(g.players[this.me]).find((x) => x.id === id)).filter((x): x is Card => !!x);
    if (g.revealed && c.rank !== g.revealed.rank) { this.message = 'Only add cards that match the flipped card'; return this.render(); }
    if (cur.length && cur[0].rank !== c.rank) {
      this.selected = new Set(g.revealed ? [g.revealed.id] : []);
    }
    if (c.rank === SWOOP_RANK) {
      const had = this.selected.has(c.id);
      this.selected = new Set(g.revealed && g.revealed.rank === SWOOP_RANK ? [g.revealed.id] : had ? [] : [c.id]);
    } else if (this.selected.has(c.id)) {
      if (!(g.revealed && c.id === g.revealed.id)) this.selected.delete(c.id);
    } else {
      this.selected.add(c.id);
    }
    this.armed = null;
    this.render();
  }

  private tapRank(rank: number) {
    const g = this.g!;
    if (!this.myTurn()) return;
    const me = g.players[this.me];
    const hand = me.hand.filter((c) => c.rank === rank);
    const next = hand.find((c) => !this.selected.has(c.id));
    if (next) return this.toggle(next);
    // everything of this number is already selected: clear it
    hand.forEach((c) => this.selected.delete(c.id));
    this.render();
  }

  // ---------- actions from the page ----------

  onAction(a: string, el: HTMLElement): boolean {
    const g = this.g;
    if (!g || !a.startsWith('sw-')) return false;
    const me = g.players[this.me];
    switch (a) {
      case 'sw-rank': this.tapRank(Number(el.dataset.rank)); return true;
      case 'sw-board': {
        const c = me.board.find((x) => x && x.id === Number(el.dataset.id));
        if (c) this.toggle(c);
        return true;
      }
      case 'sw-mys': {
        if (!this.myTurn()) return true;
        const slot = Number(el.dataset.slot);
        if (g.flippable(me).includes(slot)) { this.armed = this.armed === slot ? null : slot; this.message = ''; this.selected = new Set(); }
        else this.message = this.myTurn() && !g.fresh ? 'Mystery cards can only be flipped before you play a card' : 'That mystery card is still covered';
        this.render(); return true;
      }
      case 'sw-flip': if (this.armed !== null) this.act({ a: 'sflip', slot: this.armed }); return true;
      case 'sw-play': {
        const ids = [...this.selected];
        const err = g.checkPlay(ids);
        if (err) { this.message = err; this.render(); return true; }
        this.act({ a: 'splay', ids }); return true;
      }
      case 'sw-take': {
        const pick = [...this.selected].length === 1 ? [...this.selected][0] : (me.board.find((c): c is Card => c !== null) ?? me.hand[0])?.id;
        if (pick === undefined) { this.message = 'Nothing to show'; this.render(); return true; }
        this.act({ a: 'stake', id: pick }); return true;
      }
      case 'sw-next': this.nextRound(); return true;
      case 'sw-scores': this.panel = 'scores'; this.render(); return true;
      case 'sw-log': this.panel = 'log'; this.render(); return true;
      case 'sw-close': this.panel = null; this.render(); return true;
      case 'sw-leave': this.env.leave(); return true;
      case 'sw-lobby': this.env.toLobby(); return true;
      case 'sw-again': this.env.newSolo(); return true;
    }
    return false;
  }

  // ---------- rendering ----------

  private card(c: Card, cls = '', attrs = '', tag: 'button' | 'div' = 'button'): string {
    const red = c.suit === 'H' || c.suit === 'D' ? 'red' : 'black';
    const sw = c.rank === SWOOP_RANK ? 'swoopcard' : '';
    const label = `${rankName(c.rank)}${SUIT[c.suit]}`;
    return `<${tag} class="swc ${red} ${sw} ${cls}" ${attrs} aria-label="${label}"><span class="r">${c.rank === SWOOP_RANK ? '10' : rankName(c.rank)}</span><span class="s">${SUIT[c.suit]}</span>${c.rank === SWOOP_RANK ? '<span class="sw">SWOOP</span>' : ''}</${tag}>`;
  }

  private back(cls = '', attrs = '', tag: 'button' | 'div' = 'div'): string {
    return `<${tag} class="swc back ${cls}" ${attrs} aria-label="face-down card"></${tag}>`;
  }

  /** One of the four board/mystery slots: the face-up card sits on its face-down card. */
  private slot(p: SwoopPlayer, i: number, mine: boolean, flippable: boolean): string {
    const b = p.board[i], m = p.mystery[i];
    if (!b && !m) return `<span class="slot empty"></span>`;
    if (!b && m) {
      const tap = mine && flippable ? `data-action="sw-mys" data-slot="${i}"` : mine ? `data-action="sw-mys" data-slot="${i}"` : '';
      return `<span class="slot">${this.back(`up ${flippable ? 'canflip' : ''} ${this.armed === i ? 'armed' : ''}`, tap, mine ? 'button' : 'div')}</span>`;
    }
    const playable = mine && this.myTurn() && this.g!.pile.length > 0 && this.g!.rankPlayable(b!.rank);
    const face = mine
      ? this.card(b!, `top ${this.selected.has(b!.id) ? 'selected' : ''} ${playable ? 'playable' : ''}`, `data-action="sw-board" data-id="${b!.id}"`)
      : this.card(b!, 'top', '', 'div');
    return `<span class="slot">${m ? this.back('under') : ''}${face}</span>`;
  }

  render() {
    const g = this.g;
    if (!g) return;
    const env = this.env;
    const app = env.app;
    app.className = 'swgame';
    const me = g.players[this.me];
    const myTurn = this.myTurn();
    const top = g.pile[g.pile.length - 1];
    const run = g.topRun();
    const sel = g.available(me).filter((c) => this.selected.has(c.id));
    const canPlay = myTurn && sel.length > 0 && g.checkPlay([...this.selected]) === null;
    const flippable = myTurn ? g.flippable(me) : [];
    const curName = env.esc(g.players[g.current].name);

    const opps = g.players.filter((p) => p.id !== this.me).map((p) => {
      const off = this.net && this.seatInfo[p.id] && !this.seatInfo[p.id].bot && !this.seatInfo[p.id].connected;
      const table = p.board.filter(Boolean).length + p.mystery.filter(Boolean).length;
      return `<div class="sw-opp ${p.id === g.current && g.status === 'playing' ? 'active' : ''}">
        <div class="sw-on"><b>${env.esc(p.name)}</b>${off ? ' <small>(offline)</small>' : ''}<span class="muted"> · ${p.hand.length} in hand<span class="sw-tbl"> + ${table} on table</span> · ${p.total} pts</span></div>
        <div class="sw-ob">${[0, 1, 2, 3].map((i) => this.slot(p, i, false, false)).join('')}</div></div>`;
    }).join('');

    const cols = new Map<number, Card[]>();
    for (const c of me.hand) cols.set(c.rank, [...(cols.get(c.rank) ?? []), c]);
    const hand = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([rank, cs]) => {
      const off = cs.length <= 4 ? 18 : Math.max(5, Math.floor(72 / (cs.length - 1)));
      const playable = myTurn && g.pile.length > 0 && g.rankPlayable(rank);
      return `<div class="sw-col" style="--off:${off}px" data-action="sw-rank" data-rank="${rank}">${cs.map((c) =>
        this.card(c, `${this.selected.has(c.id) ? 'selected' : ''} ${playable ? 'playable' : ''}`, 'tabindex="-1"', 'div')).join('')}</div>`;
    }).join('') || '<span class="hint">No cards in hand</span>';

    const status = g.revealed && myTurn
      ? `You flipped ${cardLabel(g.revealed)}. Play it (add matching cards if you like).`
      : myTurn
        ? (g.canTake() ? 'Nothing you can play: take the pile.' : g.pile.length ? `Your turn: play ${rankName(top.rank)} or lower` : 'Your turn: the pile is empty, play anything')
        : g.status === 'playing' ? `${curName} is playing…` : '';
    const call = top ? `${run > 1 ? `${run}× ` : ''}${rankName(top.rank)}` : '';

    const revealedHtml = g.revealed ? `<div class="sw-rev"><span class="muted">Flipped</span>${this.card(g.revealed, 'flash', '', 'div')}</div>` : '';
    const last = this.log[0] ? env.esc(this.log[0]) : '';

    app.innerHTML = `
      <header>
        <div><b>Swoop</b> <span class="muted">Round ${g.roundNumber} · <span class="hide-sm">game ends at</span> ${g.target}<span class="hide-sm"> · lowest wins</span></span></div>
        <div class="hdr-actions">
          ${env.soundControls()}
          ${this.net ? '' : env.speedControl()}
          <button class="ghost small" data-action="sw-log">Log</button>
          <button class="ghost small" data-action="sw-scores">Scores</button>
          <button class="ghost small" data-action="sw-leave">${this.net ? 'Leave' : 'New game'}</button>
        </div>
      </header>
      <div class="sw-opps ${g.players.length > 5 ? 'many' : ''}">${opps}</div>
      <div class="sw-mid">
        <div class="sw-pilebox">
          <div class="sw-pile">${top ? this.card(top, `${this.flashIds.has(top.id) ? 'flash' : ''}`, '', 'div') : '<div class="swc empty">Empty</div>'}
            ${g.pile.length > 1 ? `<span class="sw-count">${g.pile.length}</span>` : ''}</div>
          <div class="sw-call">${call ? `<b>${env.esc(call)}</b>` : '<span class="muted">Empty pile</span>'}</div>
        </div>
        ${revealedHtml}
        <div class="sw-info"><div class="sw-status ${myTurn ? 'mine' : ''}">${env.esc(status)}</div><div class="sw-last muted">${last}</div>
          ${this.message ? `<div class="sw-msg">${env.esc(this.message)}</div>` : ''}</div>
      </div>
      <div class="sw-me ${myTurn ? 'turn' : ''}">
        <div class="sw-meh"><b>${env.esc(me.name)}</b><span class="muted"> · ${me.hand.length} in hand · ${me.total} pts</span></div>
        <div class="sw-board">${[0, 1, 2, 3].map((i) => this.slot(me, i, true, flippable.includes(i))).join('')}</div>
        <div class="sw-hand">${hand}</div>
        <div class="sw-actions">
          <button class="big" data-action="sw-play" ${canPlay ? '' : 'disabled'}>${canPlay ? `Play ${sel.length > 1 ? `${sel.length} × ` : ''}${rankName(sel[0].rank)}` : 'Play'}</button>
          ${this.armed !== null ? '<button class="big warn" data-action="sw-flip">Flip mystery card</button>' : ''}
          ${myTurn && g.canTake() ? '<button class="big warn" data-action="sw-take">Take the pile</button>' : ''}
        </div>
      </div>
      ${this.overlay()}`;
  }

  private table(): string {
    const g = this.g!;
    const order = g.players.slice().sort((a, b) => a.total - b.total || a.id - b.id);
    return `<table><tr><th>#</th><th>Player</th><th>${g.status === 'playing' ? '' : 'Round'}</th><th>Total</th></tr>${order.map((p, i) =>
      `<tr class="${p.id === this.me ? 'me' : ''}"><td>${i + 1}</td><td>${this.env.esc(p.name)}${g.status !== 'playing' && p.id === g.lastOut ? ' 🏁' : ''}</td>
        <td>${g.status === 'playing' ? '' : `+${g.lastRoundPoints[p.id] ?? 0}`}</td><td>${p.total}</td></tr>`).join('')}</table>`;
  }

  private overlay(): string {
    const g = this.g!;
    const e = this.env;
    if (g.status === 'playing') {
      if (this.panel === 'scores') return `<div class="overlay" data-action="sw-close"><div class="panel"><h2>Scores</h2><p class="muted">Lowest total wins. Game ends when someone reaches ${g.target}.</p>${this.table()}<button class="big" data-action="sw-close">Back to game</button></div></div>`;
      if (this.panel === 'log') return `<div class="overlay" data-action="sw-close"><div class="panel"><h2>Moves</h2><div class="plog">${this.log.slice(0, 40).map((l) => `<div>${e.esc(l)}</div>`).join('') || '<div>Nothing yet</div>'}</div><button class="big" data-action="sw-close">Close</button></div></div>`;
      return '';
    }
    if (this.overlayKey !== this.keyOf(g)) return '';
    const who = g.lastOut === null ? 'Nobody could go out' : `${e.esc(g.players[g.lastOut].name)} went out`;
    if (g.status === 'gameOver') {
      const names = g.winners.map((w) => e.esc(g.players[w].name)).join(' & ');
      const won = g.winners.includes(this.me);
      const buttons = this.net
        ? (e.isHost() ? '<button class="big" data-action="sw-lobby">Back to lobby</button>' : '<p class="muted">Waiting for the host…</p>') + '<button class="ghost" data-action="sw-leave">Leave</button>'
        : '<button class="big" data-action="sw-again">Play again</button>';
      return `<div class="overlay"><div class="panel"><h2>${won ? '🎉 You win!' : 'Game over'}</h2><p>${g.winners.length > 1 ? 'Winners' : 'Winner'}: <b>${names}</b></p><p class="muted">${who}</p>${this.table()}${buttons}</div></div>`;
    }
    return `<div class="overlay"><div class="panel"><h2>Round ${g.roundNumber} over</h2><p>${who}</p>${this.table()}<p class="muted">Target ${g.target}</p><button class="big" data-action="sw-next">Next round</button></div></div>`;
  }
}
