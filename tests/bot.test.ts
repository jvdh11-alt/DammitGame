import { describe, expect, it } from 'vitest';
import { DammitGame, findObjective, takeBotTurn, DEFAULT_LEVELS, Card } from '../src/engine';

const c = (id: number, rank: number, suit: Card['suit'] = 'S'): Card => ({ id, rank, suit });

describe('findObjective', () => {
  it('finds set + run with disjoint cards', () => {
    const hand = [c(1, 7), c(2, 7, 'H'), c(3, 7, 'D'), c(4, 11, 'C'), c(5, 12, 'C'), c(6, 13, 'C'), c(7, 1, 'C'), c(8, 9)];
    const g = findObjective(hand, DEFAULT_LEVELS[3].requirements)!;
    expect(g).toHaveLength(2);
    expect(new Set(g.flat()).size).toBe(g.flat().length);
  });
  it('returns null when impossible', () => {
    expect(findObjective([c(1, 7), c(2, 7), c(3, 9)], DEFAULT_LEVELS[0].requirements)).toBeNull();
  });
  it('handles two sets of the same rank from many decks', () => {
    const hand = Array.from({ length: 6 }, (_, i) => c(i, 5, 'SHDCSH'[i] as Card['suit']));
    expect(findObjective(hand, DEFAULT_LEVELS[2].requirements)).not.toBeNull();
  });
});

describe('bot simulation', () => {
  for (const players of [2, 3, 4, 6, 8]) {
    it(`${players} bots finish a full game`, () => {
      const results: number[] = [];
      for (let seed = 1; seed <= 4; seed++) {
        const g = new DammitGame(Array.from({ length: players }, (_, i) => `B${i}`), { seed });
        const total = g.allCards().length;
        let turns = 0;
        while (g.status !== 'gameOver') {
          if (g.status === 'handOver') { g.nextHand(); continue; }
          takeBotTurn(g);
          expect(g.allCards()).toHaveLength(total);
          if (++turns > 40000) throw new Error(`game did not finish (seed ${seed})`);
        }
        expect(g.winners.length).toBeGreaterThan(0);
        results.push(g.handNumber);
      }
    }, 60_000);
  }
});

import { botTurnSteps } from '../src/engine';
describe('botTurnSteps', () => {
  it('performs and reports one action at a time, ending with the turn passing on', () => {
    const g = new DammitGame(['A', 'B', 'C'], { seed: 11 });
    const start = g.current;
    const it = botTurnSteps(g);
    const first = it.next();
    expect(first.done).toBe(false);
    expect(g.phase).toBe('play');            // the draw has happened, nothing else yet
    expect(g.player.hand.length).toBe(14);
    let steps = 1;
    while (!it.next().done) steps++;
    expect(steps).toBeGreaterThanOrEqual(2);  // at least draw + discard
    expect(g.current).not.toBe(start);
  });
});
