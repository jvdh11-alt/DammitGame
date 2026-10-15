export type Suit = 'S' | 'H' | 'D' | 'C';
export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

/** Rank 1..13 where 1 = Ace, 11 = J, 12 = Q, 13 = K. Ranks are circular (K→A→2). */
export const RANKS = 13;

export interface Card {
  /** Unique id so multiple decks can contain identical rank/suit cards. */
  id: number;
  rank: number;
  suit: Suit;
}

/** Number of 52-card decks: always at least 2 (so melds can keep growing), more as players are added. */
export function decksForPlayers(players: number): number {
  return Math.max(2, Math.ceil((players * 13 + 30) / 52));
}

export function buildDeck(decks: number): Card[] {
  const cards: Card[] = [];
  let id = 0;
  for (let d = 0; d < decks; d++)
    for (const suit of SUITS)
      for (let rank = 1; rank <= RANKS; rank++) cards.push({ id: id++, rank, suit });
  return cards;
}

/** Small seeded PRNG (mulberry32) so games are reproducible/testable. */
export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RANK_LABEL: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const cardLabel = (c: Card) => `${RANK_LABEL[c.rank] ?? c.rank}${SUIT_SYMBOL[c.suit]}`;
