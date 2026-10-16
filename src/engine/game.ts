import { buildDeck, Card, decksForPlayers, mulberry32, Rng, shuffle } from './cards';
import { DEFAULT_LEVELS, Level, Requirement } from './levels';
import { extendMeld, makeRun, makeSet, Meld } from './melds';

export const HAND_SIZE = 13;

export interface Player {
  id: number;
  name: string;
  /** Index into the level ladder. levels.length means the player has completed the final level. */
  level: number;
  hand: Card[];
  /** True once this player has laid down their level objective this hand. */
  laidDown: boolean;
  melds: Meld[];
  /** Hands won by actually going out (the first tiebreaker). */
  handsWon: number;
}

export type Phase = 'draw' | 'play';
export type Status = 'playing' | 'handOver' | 'gameOver';

export interface MeldRef {
  player: number;
  meld: number;
}

export interface Options {
  seed?: number;
  levels?: Level[];
}

export class RuleError extends Error {}

export class DammitGame {
  players: Player[];
  drawPile: Card[] = [];
  discardPile: Card[] = [];
  current = 0;
  phase: Phase = 'draw';
  status: Status = 'playing';
  handNumber = 0;
  /** Player who went out in the most recent hand (null = nobody, e.g. stalemate). */
  lastHandWinner: number | null = null;
  winners: number[] = [];
  /** Draw-pile recycles since anyone last laid a card; used to break true deadlocks. */
  private stallRecycles = 0;
  /** True if the last hand ended in a stalemate (no one went out). */
  stalemate = false;
  readonly levels: Level[];
  private rng: Rng;
  private firstSeat = 0;
  private decks: number;

  constructor(names: string[], opts: Options = {}) {
    if (names.length < 2) throw new RuleError('Need at least 2 players');
    this.levels = opts.levels ?? DEFAULT_LEVELS;
    this.rng = mulberry32(opts.seed ?? Date.now());
    this.firstSeat = opts.seed === undefined ? Math.floor(Math.random() * names.length) : 0; // random who starts (tests pass a seed: seat 0)
    this.decks = decksForPlayers(names.length);
    this.players = names.map((name, id) => ({
      id, name, level: 0, hand: [], laidDown: false, melds: [], handsWon: 0,
    }));
    this.deal();
  }

  // ---------- setup ----------

  private deal(): void {
    this.handNumber++;
    const deck = shuffle(buildDeck(this.decks), this.rng);
    for (const p of this.players) {
      p.hand = deck.splice(0, HAND_SIZE);
      p.laidDown = false;
      p.melds = [];
    }
    this.discardPile = [deck.pop()!];
    this.drawPile = deck;
    this.current = (this.firstSeat + this.handNumber - 1) % this.players.length;
    this.phase = 'draw';
    this.status = 'playing';
    this.stallRecycles = 0;
    this.stalemate = false;
  }

  nextHand(): void {
    if (this.status !== 'handOver') throw new RuleError('Hand is not over');
    this.deal();
  }

  // ---------- queries ----------

  get player(): Player {
    return this.players[this.current];
  }

  requirementsFor(p: Player): Requirement[] {
    return this.levels[p.level]?.requirements ?? [];
  }

  allCards(): Card[] {
    return [
      ...this.drawPile,
      ...this.discardPile,
      ...this.players.flatMap((p) => [...p.hand, ...p.melds.flatMap((m) => m.cards)]),
    ];
  }

  // ---------- turn actions ----------

  /**
   * Draw from the deck or the top of the discard pile.
   * Returns null if the hand ended in a stalemate (the draw pile was recycled twice with no progress).
   */
  draw(from: 'deck' | 'discard'): Card | null {
    this.assertTurn('draw');
    let card: Card | undefined;
    if (from === 'discard') {
      card = this.discardPile.pop();
    } else {
      if (this.drawPile.length === 0) {
        if (++this.stallRecycles > 2) {
          this.stalemate = true;
          this.endHand(null);
          return null;
        }
        this.recycleDiscards();
      }
      card = this.drawPile.pop();
    }
    if (!card) {
      this.stalemate = true;
      this.endHand(null);
      return null;
    }
    this.player.hand.push(card);
    this.phase = 'play';
    return card;
  }

  /** Lay down the current level's objective: one group of card ids per requirement. */
  layObjective(groups: number[][]): void {
    this.assertTurn('play');
    const p = this.player;
    if (p.laidDown) throw new RuleError('Objective already laid down');
    const reqs = this.requirementsFor(p);
    if (groups.length !== reqs.length) throw new RuleError(`Objective needs ${reqs.length} group(s)`);
    const cardGroups = groups.map((g) => this.takeFromHand(p, g, false));
    const melds = this.matchObjective(reqs, cardGroups);
    if (!melds) throw new RuleError('Cards do not satisfy the level objective');
    this.removeFromHand(p, groups.flat());
    p.melds.push(...melds);
    p.laidDown = true;
    this.stallRecycles = 0;
    this.checkOut();
  }

  /** After your objective is down, lay your own extra meld (set of 3+, run of 4+). */
  layMeld(cardIds: number[]): void {
    this.assertTurn('play');
    const p = this.player;
    if (!p.laidDown) throw new RuleError('Lay down your objective first');
    const cards = this.takeFromHand(p, cardIds, false);
    const meld = makeSet(cards) ?? makeRun(cards);
    if (!meld) throw new RuleError('Not a valid set (3+) or run (4+)');
    this.removeFromHand(p, cardIds);
    p.melds.push(meld);
    this.stallRecycles = 0;
    this.checkOut();
  }

  /** Add a card from your hand to any laid-down meld (requires your own objective to be down). */
  layOn(cardId: number, target: MeldRef): void {
    this.assertTurn('play');
    const p = this.player;
    if (!p.laidDown) throw new RuleError('Lay down your objective first');
    const [card] = this.takeFromHand(p, [cardId], false);
    const meld = this.players[target.player]?.melds[target.meld];
    if (!meld) throw new RuleError('No such meld');
    const extended = extendMeld(meld, card);
    if (!extended) throw new RuleError('Card does not extend that meld');
    this.removeFromHand(p, [cardId]);
    this.players[target.player].melds[target.meld] = extended;
    this.stallRecycles = 0;
    this.checkOut();
  }

  /** Discard ends your turn. Discarding your last card also goes out. */
  discard(cardId: number): void {
    this.assertTurn('play');
    const p = this.player;
    const [card] = this.takeFromHand(p, [cardId], false);
    this.removeFromHand(p, [cardId]);
    this.discardPile.push(card);
    if (this.checkOut()) return;
    this.current = (this.current + 1) % this.players.length;
    this.phase = 'draw';
  }

  // ---------- internals ----------

  private assertTurn(phase: Phase): void {
    if (this.status !== 'playing') throw new RuleError(`Game is ${this.status}`);
    if (this.phase !== phase) throw new RuleError(`Expected phase '${this.phase}'`);
  }

  private recycleDiscards(): void {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile.pop()!;
    this.drawPile = shuffle(this.discardPile, this.rng);
    this.discardPile = [top];
  }

  private takeFromHand(p: Player, ids: number[], _remove: boolean): Card[] {
    const seen = new Set<number>();
    return ids.map((id) => {
      if (seen.has(id)) throw new RuleError('Duplicate card in selection');
      seen.add(id);
      const c = p.hand.find((h) => h.id === id);
      if (!c) throw new RuleError('Card not in hand');
      return c;
    });
  }

  private removeFromHand(p: Player, ids: number[]): void {
    const set = new Set(ids);
    p.hand = p.hand.filter((c) => !set.has(c.id));
  }

  /** Assigns each card group to a distinct requirement (type match, size >= required). */
  private matchObjective(reqs: Requirement[], groups: Card[][]): Meld[] | null {
    const used = new Array(groups.length).fill(false);
    const result: Meld[] = new Array(reqs.length);
    const solve = (ri: number): boolean => {
      if (ri === reqs.length) return true;
      const r = reqs[ri];
      for (let gi = 0; gi < groups.length; gi++) {
        if (used[gi]) continue;
        const meld = r.type === 'set' ? makeSet(groups[gi], r.size) : makeRun(groups[gi], r.size);
        if (!meld) continue;
        used[gi] = true;
        result[ri] = meld;
        if (solve(ri + 1)) return true;
        used[gi] = false;
      }
      return false;
    };
    return solve(0) ? result : null;
  }

  private checkOut(): boolean {
    if (this.player.hand.length > 0) return false;
    this.endHand(this.current);
    return true;
  }

  private endHand(winner: number | null): void {
    this.lastHandWinner = winner;
    if (winner !== null) this.players[winner].handsWon++;
    // Everyone who completed their objective advances; others stay stuck on their level.
    for (const p of this.players) if (p.laidDown) p.level++;
    const finishers = this.players.filter((p) => p.level >= this.levels.length);
    if (finishers.length > 0) {
      this.winners = this.pickWinners(finishers);
      this.status = 'gameOver';
    } else {
      this.status = 'handOver';
    }
  }

  /**
   * Tiebreakers among players who completed the final level:
   * 1) most hands won by going out, 2) won the final hand. If still tied, they all win.
   */
  private pickWinners(finishers: Player[]): number[] {
    const most = Math.max(...finishers.map((p) => p.handsWon));
    let top = finishers.filter((p) => p.handsWon === most);
    if (top.length > 1) {
      const wonFinal = top.filter((p) => p.id === this.lastHandWinner);
      if (wonFinal.length > 0) top = wonFinal;
    }
    return top.map((p) => p.id);
  }
}
