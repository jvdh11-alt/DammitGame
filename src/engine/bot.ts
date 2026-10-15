import { Card, cardLabel, RANKS } from './cards';
import { DammitGame, MeldRef } from './game';
import { Requirement } from './levels';
import { extendMeld, MIN_RUN, MIN_SET, Meld } from './melds';

const wrap = (r: number) => ((r - 1 + RANKS) % RANKS) + 1;

/** All candidate melds (as card-id lists) of exactly `size` cards that can be made from `cards`. */
function candidates(cards: Card[], type: 'set' | 'run', size: number): number[][] {
  const out: number[][] = [];
  if (type === 'set') {
    const byRank = new Map<number, Card[]>();
    for (const c of cards) byRank.set(c.rank, [...(byRank.get(c.rank) ?? []), c]);
    for (const group of byRank.values()) if (group.length >= size) out.push(group.slice(0, size).map((c) => c.id));
    return out;
  }
  if (size > RANKS) return out;
  const bySuit = new Map<string, Map<number, Card>>();
  for (const c of cards) {
    const m = bySuit.get(c.suit) ?? new Map<number, Card>();
    if (!m.has(c.rank)) m.set(c.rank, c);
    bySuit.set(c.suit, m);
  }
  for (const ranks of bySuit.values()) {
    if (ranks.size < size) continue;
    for (let start = 1; start <= RANKS; start++) {
      const ids: number[] = [];
      for (let i = 0; i < size; i++) {
        const c = ranks.get(wrap(start + i));
        if (!c) break;
        ids.push(c.id);
      }
      if (ids.length === size) out.push(ids);
      if (size === RANKS) break; // full circle: every rotation is the same set of cards
    }
  }
  return out;
}

/** Finds one group of card ids per requirement, using disjoint cards, or null if impossible. */
export function findObjective(hand: Card[], reqs: Requirement[]): number[][] | null {
  const solve = (i: number, pool: Card[]): number[][] | null => {
    if (i === reqs.length) return [];
    for (const ids of candidates(pool, reqs[i].type, reqs[i].size)) {
      const used = new Set(ids);
      const rest = solve(i + 1, pool.filter((c) => !used.has(c.id)));
      if (rest) return [ids, ...rest];
    }
    return null;
  };
  return solve(0, hand);
}

/** Largest own meld (set of 3+, run of 4+) that can be laid from the hand, as card ids. */
function bestExtraMeld(hand: Card[]): number[] | null {
  let best: number[] | null = null;
  for (let size = RANKS; size >= MIN_RUN; size--) {
    const run = candidates(hand, 'run', size)[0];
    if (run) { best = run; break; }
  }
  const byRank = new Map<number, Card[]>();
  for (const c of hand) byRank.set(c.rank, [...(byRank.get(c.rank) ?? []), c]);
  for (const g of byRank.values()) {
    if (g.length >= MIN_SET && (!best || g.length > best.length)) best = g.map((c) => c.id);
  }
  return best;
}

/** Partial-meld options for one requirement: cards from the pool that count toward it, plus how many are missing. */
function partials(pool: Card[], req: Requirement): { ids: number[]; missing: number }[] {
  const out: { ids: number[]; missing: number }[] = [{ ids: [], missing: req.size }];
  if (req.type === 'set') {
    const byRank = new Map<number, Card[]>();
    for (const c of pool) byRank.set(c.rank, [...(byRank.get(c.rank) ?? []), c]);
    for (const g of byRank.values()) {
      const take = g.slice(0, req.size);
      out.push({ ids: take.map((c) => c.id), missing: req.size - take.length });
    }
    return out;
  }
  const bySuit = new Map<string, Map<number, Card>>();
  for (const c of pool) {
    const m = bySuit.get(c.suit) ?? new Map<number, Card>();
    if (!m.has(c.rank)) m.set(c.rank, c);
    bySuit.set(c.suit, m);
  }
  for (const ranks of bySuit.values()) {
    for (let start = 1; start <= RANKS; start++) {
      const ids: number[] = [];
      for (let i = 0; i < req.size && i < RANKS; i++) {
        const c = ranks.get(wrap(start + i));
        if (c) ids.push(c.id);
      }
      if (ids.length > 0) out.push({ ids, missing: req.size - ids.length });
    }
  }
  return out;
}

/** Fewest additional cards needed to complete the objective from this hand (0 = can lay down now). */
export function objectiveDistance(hand: Card[], reqs: Requirement[]): number {
  const solve = (i: number, pool: Card[]): number => {
    if (i === reqs.length) return 0;
    let best = Infinity;
    for (const opt of partials(pool, reqs[i])) {
      if (opt.missing >= best) continue;
      const used = new Set(opt.ids);
      const rest = solve(i + 1, used.size ? pool.filter((c) => !used.has(c.id)) : pool);
      best = Math.min(best, opt.missing + rest);
    }
    return best;
  };
  return solve(0, hand);
}

/** Best card to discard when still working toward the objective: minimises remaining distance. */
function pickObjectiveDiscard(hand: Card[], reqs: Requirement[]): { card: Card; distance: number } {
  let best: { card: Card; distance: number; keep: number } | null = null;
  for (const card of hand) {
    const rest = hand.filter((c) => c.id !== card.id);
    const d = objectiveDistance(rest, reqs);
    const keep = keepScore(card, hand);
    if (!best || d < best.distance || (d === best.distance && keep < best.keep)) best = { card, distance: d, keep };
  }
  return { card: best!.card, distance: best!.distance };
}

/** Heuristic: how much does keeping this card help? Higher = keep. */
function keepScore(card: Card, hand: Card[]): number {
  let s = 0;
  for (const o of hand) {
    if (o.id === card.id) continue;
    if (o.rank === card.rank) s += 3;
    if (o.suit === card.suit) {
      const d = Math.min((o.rank - card.rank + RANKS) % RANKS, (card.rank - o.rank + RANKS) % RANKS);
      if (d === 1) s += 3;
      else if (d === 2) s += 1.5;
    }
  }
  return s;
}

function meldTargets(game: DammitGame): { ref: MeldRef; meld: Meld }[] {
  return game.players.flatMap((p, pi) => p.melds.map((meld, mi) => ({ ref: { player: pi, meld: mi }, meld })));
}

/**
 * Plays one bot turn one action at a time. Each action is performed, then its description is yielded,
 * so a UI can pace the actions (draw, lay down, play on a meld, discard) and show them separately.
 */
export function* botTurnSteps(game: DammitGame): Generator<string, void> {
  const me = game.player;
  const name = me.name;
  const reqs = game.requirementsFor(me);

  // --- draw ---
  const top = game.discardPile[game.discardPile.length - 1];
  let takeDiscard = false;
  if (top) {
    if (!me.laidDown) {
      const now = objectiveDistance(me.hand, reqs);
      takeDiscard = pickObjectiveDiscard([...me.hand, top], reqs).distance < now;
    }
    else takeDiscard = meldTargets(game).some((t) => extendMeld(t.meld, top) !== null);
  }
  const drawn = game.draw(takeDiscard ? 'discard' : 'deck');
  if (!drawn) {
    yield 'Stalemate: nobody can make progress, so the hand ends with no winner';
    return;
  }
  yield takeDiscard ? `${name} took ${cardLabel(drawn)} from the discard pile` : `${name} drew from the deck`;
  if (game.status !== 'playing') return;

  // --- lay objective ---
  if (!me.laidDown) {
    const groups = findObjective(me.hand, reqs);
    if (groups) {
      const lvl = me.level + 1;
      game.layObjective(groups);
      yield `${name} laid down level ${lvl}`;
      if (game.status !== 'playing') return;
    }
  }

  // --- shed cards ---
  if (me.laidDown) {
    let progress = true;
    while (progress && game.status === 'playing') {
      progress = false;
      for (const card of me.hand) {
        const t = meldTargets(game).find((m) => extendMeld(m.meld, card) !== null);
        if (t) {
          game.layOn(card.id, t.ref);
          yield `${name} played ${cardLabel(card)} onto ${game.players[t.ref.player].name}'s meld`;
          progress = true;
          break;
        }
      }
      if (progress) continue;
      const extra = me.hand.length > 0 ? bestExtraMeld(me.hand) : null;
      if (extra) {
        game.layMeld(extra);
        yield `${name} laid down a new meld`;
        progress = true;
      }
    }
    if (game.status !== 'playing') {
      yield `${name} went out!`;
      return;
    }
  }

  // --- discard the least useful card ---
  const worst = me.laidDown
    ? me.hand.reduce((a, b) => (keepScore(b, me.hand) < keepScore(a, me.hand) ? b : a))
    : pickObjectiveDiscard(me.hand, reqs).card;
  game.discard(worst.id);
  yield `${name} discarded ${cardLabel(worst)}`;
  if (game.status !== 'playing') yield `${name} went out!`;
  return;
}

/** Plays one full turn at once and returns the log lines (used by simulations and tests). */
export function takeBotTurn(game: DammitGame): string[] {
  return [...botTurnSteps(game)];
}

/** Every extra meld (set of 3+, run of 4+) that could be laid from this hand, greedily, as lists of card ids. */
export function findExtraMelds(hand: Card[]): number[][] {
  const out: number[][] = [];
  let rest = hand;
  for (;;) {
    const m = rest.length ? bestExtraMeld(rest) : null;
    if (!m) return out;
    out.push(m);
    const used = new Set(m);
    rest = rest.filter((c) => !used.has(c.id));
  }
}
