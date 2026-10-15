import { Card, cardLabel } from '../engine/cards';
import { describePlay, rankName, SWOOP_RANK, SwoopGame } from './engine';

const groupByRank = (cards: Card[]): Map<number, Card[]> => {
  const m = new Map<number, Card[]>();
  for (const c of cards) m.set(c.rank, [...(m.get(c.rank) ?? []), c]);
  return m;
};

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
      const extra = r.rank === SWOOP_RANK ? [] : g.available(me).filter((c) => c.rank === r.rank && c.id !== r.id).map((c) => c.id);
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
      if (finisher) pick = finisher[1];
    }
    // 2) a SWOOP card when the pile is big, or when it is all we can play.
    if (!pick && swoops.length && (g.pile.length >= 6 || numbers.length === 0)) pick = [swoops[0]];
    // 3) otherwise: lead low on an empty pile (squeeze the next player), dump the highest legal number on a live pile.
    if (!pick && numbers.length) pick = top === null ? numbers[0][1] : numbers[numbers.length - 1][1];
    if (!pick) pick = [swoops[0]];

    yield describePlay(me.name, g.play(pick.map((c) => c.id)));
  }
}

/** Plays the whole bot turn at once (used by tests and simulations). */
export const takeSwoopBotTurn = (g: SwoopGame): string[] => [...swoopBotSteps(g)];

export { rankName };
