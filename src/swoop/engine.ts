import { buildDeck, Card, mulberry32, Rng, shuffle } from '../engine/cards';

/** House rules: ordinary decks; Ace is low (1) ... K is high (13); the 10 is the SWOOP card. */
export const SWOOP_RANK = 10;
export const CARDS_EACH = 19; // 4 mystery + 4 board + 11 hand
export const DEFAULT_TARGET = 300;

export class SwoopError extends Error {}

export const swoopPoints = (c: Card): number => (c.rank === SWOOP_RANK ? 25 : c.rank >= 11 ? 10 : 5);
export const decksFor = (players: number): number => Math.max(2, Math.ceil((players * CARDS_EACH) / 52));

export interface SwoopPlayer {
  id: number;
  name: string;
  hand: Card[];
  /** Four face-up cards; each covers the mystery card in the same slot. null = already played. */
  board: (Card | null)[];
  /** Four face-down cards; null = already played. */
  mystery: (Card | null)[];
  total: number;
}

export type SwoopStatus = 'playing' | 'roundOver' | 'gameOver';

export interface LastPlay { player: number; ids: number[]; rank: number; count: number; swoop: boolean; took: boolean }

export interface SwoopOptions { target?: number; seed?: number }

const MAX_TURNS_PER_ROUND = 3000;

export class SwoopGame {
  players: SwoopPlayer[];
  pile: Card[] = [];
  stackCount = 0;
  current = 0;
  status: SwoopStatus = 'playing';
  roundNumber = 0;
  target: number;
  winners: number[] = [];
  /** Who went out last round (null = nobody, e.g. stalemate). */
  lastOut: number | null = null;
  lastRoundPoints: number[] = [];
  /** A flipped mystery card that must now be played. */
  revealed: Card | null = null;
  /** True until the current player plays a card this turn (or after a swoop): mystery cards may be flipped. */
  fresh = true;
  lastPlay: LastPlay | null = null;
  /** The whole pile as it stood when it was last swooped (so the table can show it for a moment). */
  swooped: Card[] | null = null;
  private turns = 0;
  private rng: Rng;
  private decks: number;

  constructor(names: string[], opts: SwoopOptions = {}) {
    if (names.length < 2) throw new SwoopError('Need at least 2 players');
    this.target = Math.max(1, Math.round(opts.target ?? DEFAULT_TARGET));
    this.rng = mulberry32(opts.seed ?? Date.now());
    this.decks = decksFor(names.length);
    this.players = names.map((name, id) => ({ id, name, hand: [], board: [], mystery: [], total: 0 }));
    this.deal();
  }

  // ---------- setup ----------

  private deal(): void {
    this.roundNumber++;
    const deck = shuffle(buildDeck(this.decks), this.rng);
    for (const p of this.players) {
      p.mystery = deck.splice(0, 4);
      p.board = deck.splice(0, 4);
      p.hand = deck.splice(0, 11);
    }
    this.stackCount = deck.length;
    this.pile = [];
    this.current = (this.roundNumber - 1) % this.players.length;
    this.status = 'playing';
    this.revealed = null;
    this.fresh = true;
    this.lastPlay = null;
    this.turns = 0;
  }

  nextRound(): void {
    if (this.status !== 'roundOver') throw new SwoopError('The round is not over');
    this.deal();
  }

  // ---------- queries ----------

  get player(): SwoopPlayer { return this.players[this.current]; }

  /** Rank of the card on top of the pile, or null if the pile is empty. */
  topRank(): number | null { return this.pile.length ? this.pile[this.pile.length - 1].rank : null; }

  /** How many cards of the top number sit together on top of the pile ("three 4s"). */
  topRun(): number {
    let n = 0;
    for (let i = this.pile.length - 1; i >= 0 && this.pile[i].rank === this.pile[this.pile.length - 1].rank; i--) n++;
    return n;
  }

  /** Most cards of this number that can be played now: the pile never holds more than four of one number. */
  maxCount(rank: number): number {
    if (rank === SWOOP_RANK) return 1;
    const already = this.topRank() === rank ? this.topRun() : 0;
    return Math.max(0, 4 - already);
  }

  rankPlayable(rank: number): boolean {
    const top = this.topRank();
    return rank === SWOOP_RANK || top === null || rank <= top;
  }

  /** Cards the current player may play right now: hand + face-up board (+ the revealed mystery card). */
  available(p: SwoopPlayer = this.player): Card[] {
    const board = p.board.filter((c): c is Card => c !== null);
    return [...p.hand, ...board, ...(this.revealed && p === this.player ? [this.revealed] : [])];
  }

  hasLegalPlay(p: SwoopPlayer = this.player): boolean {
    return this.available(p).some((c) => this.rankPlayable(c.rank));
  }

  /** Mystery slots the current player may flip right now. */
  flippable(p: SwoopPlayer = this.player): number[] {
    if (this.status !== 'playing' || !this.fresh || this.revealed || p !== this.player) return [];
    return [0, 1, 2, 3].filter((i) => p.board[i] === null && p.mystery[i] !== null);
  }

  /** Can the current player take the pile instead (nothing legal to play, nothing mandatory)? */
  canTake(): boolean {
    return this.status === 'playing' && !this.revealed && this.pile.length > 0 && !this.hasLegalPlay()
      && this.available().length > 0;
  }

  /** Why a selection can't be played, or null if it can. */
  checkPlay(ids: number[]): string | null {
    if (this.status !== 'playing') return 'The round is over';
    if (!ids.length) return 'Select the card(s) to play';
    const have = this.available();
    const cards: Card[] = [];
    for (const id of new Set(ids)) {
      const c = have.find((h) => h.id === id);
      if (!c) return 'That card is not available';
      cards.push(c);
    }
    if (cards.length !== ids.length) return 'Duplicate card in selection';
    if (this.revealed && !ids.includes(this.revealed.id)) return 'You must play the card you flipped';
    const rank = cards[0].rank;
    if (cards.some((c) => c.rank !== rank)) return 'Play cards of the same number';
    if (rank === SWOOP_RANK && cards.length > 1) return 'Play one SWOOP card at a time';
    if (!this.rankPlayable(rank)) return 'Play the same number or lower than the pile';
    if (cards.length > this.maxCount(rank)) return this.maxCount(rank) === 4 ? 'Only four of a number can be played at once' : `Only ${this.maxCount(rank)} more ${rankName(rank)}${this.maxCount(rank) > 1 ? 's' : ''} can go on this pile (four makes a SWOOP)`;
    return null;
  }

  // ---------- actions ----------

  /** Flip a face-down card. If it can't be played the pile is taken at once. Returns the card and what happened. */
  flip(slot: number): { card: Card; took: boolean } {
    this.assertPlaying();
    if (!this.flippable().includes(slot)) {
      throw new SwoopError(this.revealed ? 'Play the card you flipped first'
        : !this.fresh ? 'Mystery cards can only be flipped before you play a card'
        : 'That mystery card is still covered');
    }
    const p = this.player;
    const card = p.mystery[slot]!;
    p.mystery[slot] = null;
    this.fresh = false;
    if (this.rankPlayable(card.rank)) {
      this.revealed = card;
      return { card, took: false };
    }
    // Too high: it goes on the pile and you take the lot.
    this.takeInto(p, card);
    return { card, took: true };
  }

  /** Play one or more cards of the same number (a lone SWOOP card, or 4+ of a kind building up, clears the pile). */
  play(ids: number[]): LastPlay {
    this.assertPlaying();
    const err = this.checkPlay(ids);
    if (err) throw new SwoopError(err);
    const p = this.player;
    const set = new Set(ids);
    const cards = this.available().filter((c) => set.has(c.id));
    p.hand = p.hand.filter((c) => !set.has(c.id));
    p.board = p.board.map((c) => (c && set.has(c.id) ? null : c));
    if (this.revealed && set.has(this.revealed.id)) this.revealed = null;
    this.pile.push(...cards);
    this.fresh = false;
    const rank = cards[0].rank;
    const swoop = rank === SWOOP_RANK || this.topRun() >= 4;
    const play: LastPlay = { player: p.id, ids: cards.map((c) => c.id), rank, count: this.topRun(), swoop, took: false };
    this.lastPlay = play;
    if (swoop) {
      this.swooped = [...this.pile];
      this.stackCount += this.pile.length;
      this.pile = [];
      this.fresh = true; // same player carries on
    }
    if (this.isOut(p)) { this.endRound(p.id); return play; }
    if (!swoop) this.advance();
    else this.countTurn();
    return play;
  }

  /** Can't play: show one card, then pick up the whole pile. */
  take(cardId: number): LastPlay {
    this.assertPlaying();
    if (!this.canTake()) throw new SwoopError(this.revealed ? 'Play the card you flipped' : 'You can play, so you cannot take the pile');
    const p = this.player;
    const card = this.available(p).find((c) => c.id === cardId);
    if (!card) throw new SwoopError('Pick a card from your hand or board to show');
    p.hand = p.hand.filter((c) => c.id !== cardId);
    p.board = p.board.map((c) => (c && c.id === cardId ? null : c));
    this.takeInto(p, card);
    return this.lastPlay!;
  }

  // ---------- internals ----------

  private assertPlaying() {
    if (this.status !== 'playing') throw new SwoopError('The round is over');
  }

  private takeInto(p: SwoopPlayer, shown: Card) {
    this.pile.push(shown);
    this.lastPlay = { player: p.id, ids: [shown.id], rank: shown.rank, count: this.pile.length, swoop: false, took: true };
    p.hand.push(...this.pile);
    this.pile = [];
    this.advance();
  }

  private isOut(p: SwoopPlayer): boolean {
    return p.hand.length === 0 && p.board.every((c) => c === null) && p.mystery.every((c) => c === null) && !this.revealed;
  }

  private advance() {
    this.current = (this.current + 1) % this.players.length;
    this.fresh = true;
    this.revealed = null;
    this.countTurn();
  }

  private countTurn() {
    if (++this.turns > MAX_TURNS_PER_ROUND && this.status === 'playing') this.endRound(null);
  }

  private endRound(out: number | null) {
    this.lastOut = out;
    this.revealed = null;
    this.lastRoundPoints = this.players.map((p) => {
      if (p.id === out) return 0;
      const rest = [...p.hand, ...p.board.filter((c): c is Card => c !== null), ...p.mystery.filter((c): c is Card => c !== null)];
      return rest.reduce((s, c) => s + swoopPoints(c), 0);
    });
    this.players.forEach((p, i) => { p.total += this.lastRoundPoints[i]; });
    if (this.players.some((p) => p.total >= this.target)) {
      const low = Math.min(...this.players.map((p) => p.total));
      this.winners = this.players.filter((p) => p.total === low).map((p) => p.id);
      this.status = 'gameOver';
    } else {
      this.status = 'roundOver';
    }
  }
}

// ---------- wording helpers shared by the bot, server and UI ----------

export const rankName = (rank: number): string => (rank === SWOOP_RANK ? 'SWOOP' : ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as Record<number, string>)[rank] ?? String(rank));
const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/** "Ann played three 4s", "Ann played a SWOOP", "Ann took the pile (7 cards)". */
export function describePlay(name: string, p: LastPlay): string {
  if (p.took) return `${name} couldn't play, showed ${rankName(p.rank)} and took the pile (${p.count} cards)`;
  if (p.rank === SWOOP_RANK) return `${name} played a SWOOP`;
  const what = `${countWord(p.ids.length)} ${rankName(p.rank)}${p.ids.length > 1 ? 's' : ''}`;
  if (p.swoop) return `${name} played ${what}: ${countWord(p.count)} ${rankName(p.rank)}s SWOOP the pile!`;
  return `${name} played ${what}` + (p.count > p.ids.length ? ` (${countWord(p.count)} ${rankName(p.rank)}s in the pile)` : '');
}
