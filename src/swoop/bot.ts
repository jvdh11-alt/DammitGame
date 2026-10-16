import { Card, cardLabel } from '../engine/cards';
import { describePlay, rankName, SWOOP_RANK, SwoopGame } from './engine';

const groupByRank = (cards: Card[]): Map<number, Card[]> => {
  const m = new Map<number, Card[]>();
  for (const c of cards) m.set(c.rank, [...(m.get(c.rank) ?? []), c]);
  return m;
};

const SWOOP_THRESHOLD = 4;

/**
 * How much a bot wants to spend its SWOOP card right now (higher = more). It is a judgement call, not a hard rule:
 * a swoop clears a big pile (so nobody, me included, gets stuck taking it), gives the bot a free extra play on an
 * empty pile, and gets a 25-point liability out of the hand. Against that, a normal card that fits is usually
 * the better play, so it needs real reasons to burn the 10 while one is available.
 */
export function swoopWorth(g: SwoopGame, playable: number[]): number {
  const me = g.player;
  let w = 0;
  w += g.pile.length * 0.35;                         // the bigger the pile, the nastier it is for whoever gets stuck
  const left = me.hand.length + me.board.filter(Boolean).length + me.mystery.filter(Boolean).length;
  if (left <= 6) w += 3;                             // near the end a stuck 10 costs 25 points; shed it
  const top = g.topRank();
  const best = Math.max(...playable);
  if (top !== null && top <= 4 && best <= top) w += 2; // pile is low and I only have low cards: I'm about to be squeezed
  const tens = g.available(me).filter((c) => c.rank === SWOOP_RANK).length;
  if (tens >= 2) w += 2;                             // more than one 10: no need to hoard them
  if (best >= 11) w -= 1.5;                          // a high card that fits is exactly what I want to shed
  const threat = g.players.some((p) => p.id !== me.id && p.hand.length + p.board.filter(Boolean).length + p.mystery.filter(Boolean).length <= 3);
  if (threat) w -= 1.5;                              // someone is nearly out: a big pile is what might trip them, don't clear it for them
  return w;
}

/**
 * One bot turn, one action at a time (so a UI can pace and show each), yielding a log line per action.
 * A turn can contain several actions because a SWOOP lets the same player carry on.
 */
export function* swoopBotSteps(g: SwoopGame): Generator<string, void> {
  const me = g.player;
  for (let guard = 0; guard < 60; guard++) {
    if (g.status !== 'playing' || g.current !== me.id) return;

    // A flipped mystery card must be played (plus any matching cards).
    if (g.revealed) {
      const r = g.revealed;
      const extra = r.rank === SWOOP_RANK ? [] : g.available(me).filter((c) => c.rank === r.rank && c.id !== r.id).slice(0, Math.max(0, g.maxCount(r.rank) - 1)).map((c) => c.id);
      yield describePlay(me.name, g.play([r.id, ...extra]));
      continue;
    }

    const groups = groupByRank(g.available(me).filter((c) => g.rankPlayable(c.rank)));
    const top = g.topRank();
    const slots = g.flippable(me);

    // Nothing playable: flip a mystery card if possible (it is no worse than taking the pile), else take it.
    if (groups.size === 0) {
      if (slots.length) {
        const card = me.mystery[slots[0]]!;
        const res = g.flip(slots[0]);
        yield res.took
          ? `${me.name} flipped ${cardLabel(card)}: too high, took the pile (${g.lastPlay!.count} cards)`
          : `${me.name} flipped a mystery card: ${cardLabel(card)}`;
        continue;
      }
      const shown = me.board.find((c): c is Card => c !== null) ?? me.hand[0];
      yield describePlay(me.name, g.take(shown.id));
      return;
    }

    // An empty pile is a free chance to get rid of a hidden card (it can always be played).
    if (top === null && slots.length) {
      const card = me.mystery[slots[0]]!;
      g.flip(slots[0]);
      yield `${me.name} flipped a mystery card: ${cardLabel(card)}`;
      continue;
    }

    const numbers = [...groups.entries()].filter(([rank]) => rank !== SWOOP_RANK).sort((a, b) => a[0] - b[0]);
    const swoops = groups.get(SWOOP_RANK) ?? [];
    let pick: Card[] | null = null;

    // 1) finish four-of-a-kind on the pile.
    if (top !== null) {
      const run = g.topRun();
      const finisher = numbers.find(([rank, cs]) => rank === top && run + cs.length >= 4);
      if (finisher) pick = finisher[1].slice(0, 4 - run);
    }
    // 2) a SWOOP card when it is worth it (see swoopWorth), or when it is all we can play.
    if (!pick && swoops.length && (numbers.length === 0 || swoopWorth(g, numbers.map(([r]) => r)) >= SWOOP_THRESHOLD)) pick = [swoops[0]];
    // 3) otherwise: get rid of the highest legal number first (high cards are the hardest to shed later).
    if (!pick && numbers.length) { const [rank, cs] = numbers[numbers.length - 1]; pick = cs.slice(0, g.maxCount(rank)); }
    if (!pick) pick = [swoops[0]];

    yield describePlay(me.name, g.play(pick.map((c) => c.id)));
  }
}

/** Plays the whole bot turn at once (used by tests and simulations). */
export const takeSwoopBotTurn = (g: SwoopGame): string[] => [...swoopBotSteps(g)];

export { rankName };
