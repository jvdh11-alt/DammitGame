import { Card, RANKS, Suit } from './cards';

export const MIN_SET = 3;
export const MIN_RUN = 4;

export type Meld =
  | { kind: 'set'; rank: number; cards: Card[] }
  /** A circular same-suit run. `start` is the first rank in order; cards are stored in run order. */
  | { kind: 'run'; suit: Suit; start: number; cards: Card[] };

const wrap = (r: number) => ((r - 1 + RANKS) % RANKS) + 1;

export function isSet(cards: Card[], min = MIN_SET): boolean {
  return cards.length >= min && cards.every((c) => c.rank === cards[0].rank);
}

/**
 * Orders cards as a circular same-suit run (A is high and low; K→A→2 wraps).
 * Returns the cards in run order, or null if they don't form a run of at least `min`.
 * A run cannot repeat a rank, so its maximum length is 13 (full circle).
 */
export function orderRun(cards: Card[], min = MIN_RUN): Card[] | null {
  const n = cards.length;
  if (n < min || n > RANKS) return null;
  const suit = cards[0].suit;
  if (!cards.every((c) => c.suit === suit)) return null;
  const byRank = new Map<number, Card>();
  for (const c of cards) {
    if (byRank.has(c.rank)) return null;
    byRank.set(c.rank, c);
  }
  if (n === RANKS) {
    // Full circle: any rotation is valid; start at Ace.
    return Array.from({ length: RANKS }, (_, i) => byRank.get(i + 1)!);
  }
  // Exactly one rank whose predecessor is missing marks the start of a single contiguous arc.
  const starts = [...byRank.keys()].filter((r) => !byRank.has(wrap(r - 1)));
  if (starts.length !== 1) return null;
  const ordered: Card[] = [];
  for (let i = 0; i < n; i++) ordered.push(byRank.get(wrap(starts[0] + i))!);
  return ordered;
}

export function makeSet(cards: Card[], min = MIN_SET): Meld | null {
  return isSet(cards, min) ? { kind: 'set', rank: cards[0].rank, cards: cards.slice() } : null;
}

export function makeRun(cards: Card[], min = MIN_RUN): Meld | null {
  const ordered = orderRun(cards, min);
  return ordered ? { kind: 'run', suit: ordered[0].suit, start: ordered[0].rank, cards: ordered } : null;
}

/** Can `card` be added to `meld`? Returns the extended meld or null. */
export function extendMeld(meld: Meld, card: Card): Meld | null {
  if (meld.kind === 'set') {
    return card.rank === meld.rank ? { ...meld, cards: [...meld.cards, card] } : null;
  }
  if (card.suit !== meld.suit || meld.cards.length >= RANKS) return null;
  const end = wrap(meld.start + meld.cards.length - 1);
  if (card.rank === wrap(end + 1)) return { ...meld, cards: [...meld.cards, card] };
  if (card.rank === wrap(meld.start - 1)) return { ...meld, start: card.rank, cards: [card, ...meld.cards] };
  return null;
}
