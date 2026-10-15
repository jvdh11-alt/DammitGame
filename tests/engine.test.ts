import { describe, expect, it } from 'vitest';
import { Card, Suit, DammitGame, extendMeld, makeRun, makeSet, orderRun, RuleError, DEFAULT_LEVELS } from '../src/engine';

let nextId = 1000;
const c = (rank: number, suit: Suit = 'S'): Card => ({ id: nextId++, rank, suit });
const run = (suit: Suit, ...ranks: number[]) => ranks.map((r) => c(r, suit));

describe('runs', () => {
  it('accepts circular same-suit runs with ace high and low', () => {
    expect(orderRun(run('S', 1, 2, 3, 4))).not.toBeNull();
    expect(orderRun(run('S', 11, 12, 13, 1))).not.toBeNull();
    const wrap = orderRun(run('H', 4, 11, 1, 12, 13, 2, 3))!; // J Q K A 2 3 4 shuffled
    expect(wrap.map((x) => x.rank)).toEqual([11, 12, 13, 1, 2, 3, 4]);
  });
  it('rejects gaps, mixed suits, duplicates, short runs', () => {
    expect(orderRun(run('S', 1, 2, 3, 5))).toBeNull();
    expect(orderRun([c(1, 'S'), c(2, 'S'), c(3, 'H'), c(4, 'S')])).toBeNull();
    expect(orderRun(run('S', 1, 2, 3, 3, 4))).toBeNull();
    expect(orderRun(run('S', 1, 2, 3))).toBeNull();
    expect(orderRun(run('S', 5, 6, 7, 9, 10, 11, 12))).toBeNull(); // two arcs
  });
  it('allows a full 13-card circle', () => {
    expect(orderRun(run('D', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13))).not.toBeNull();
  });
  it('extends at both ends, wrapping', () => {
    const m = makeRun(run('S', 12, 13, 1, 2))!;
    expect(extendMeld(m, c(11, 'S'))).not.toBeNull();
    expect(extendMeld(m, c(3, 'S'))).not.toBeNull();
    expect(extendMeld(m, c(3, 'H'))).toBeNull();
    expect(extendMeld(m, c(6, 'S'))).toBeNull();
  });
});

describe('sets', () => {
  it('needs 3+ of one rank, suits may repeat', () => {
    expect(makeSet([c(7, 'S'), c(7, 'S'), c(7, 'H')])).not.toBeNull();
    expect(makeSet([c(7), c(7)])).toBeNull();
    expect(makeSet([c(7), c(7), c(8)])).toBeNull();
  });
});

function gameWith(hands: Card[][], seed = 1) {
  const g = new DammitGame(hands.map((_, i) => `P${i}`), { seed });
  hands.forEach((h, i) => (g.players[i].hand = h));
  g.current = 0; g.phase = 'play';
  return g;
}

describe('turn flow', () => {
  it('lays objective, extras and goes out by laying the last card', () => {
    const g = gameWith([[...[7, 7, 7].map((r) => c(r)), ...[9, 9, 9].map((r) => c(r, 'H'))], [c(2)]]);
    const [a, b, d, e, f, h] = g.players[0].hand;
    g.layObjective([[a.id, b.id, d.id]]);
    expect(g.players[0].laidDown).toBe(true);
    g.layMeld([e.id, f.id, h.id]);
    expect(g.status).toBe('handOver');
    expect(g.lastHandWinner).toBe(0);
    expect(g.players[0].level).toBe(1);
    expect(g.players[0].handsWon).toBe(1);
  });
  it('blocks laying on before own objective is down', () => {
    const g = gameWith([[c(7), c(5)], [c(2)]]);
    g.players[1].melds = [makeSet([c(7), c(7), c(7)])!];
    expect(() => g.layOn(g.players[0].hand[0].id, { player: 1, meld: 0 })).toThrow(RuleError);
  });
  it('lets a laid-down player shed onto another player\'s meld', () => {
    const g = gameWith([[...[7, 7, 7].map((r) => c(r)), c(4), c(5)], [c(2), c(3)]]);
    g.players[1].melds = [makeSet([c(4), c(4), c(4)])!];
    const h = g.players[0].hand;
    g.layObjective([[h[0].id, h[1].id, h[2].id]]);
    g.layOn(h[3].id, { player: 1, meld: 0 });
    expect(g.players[1].melds[0].cards).toHaveLength(4);
    expect(() => g.layOn(h[4].id, { player: 1, meld: 0 })).toThrow(RuleError);
  });
  it('players who did not finish stay on their level; others advance', () => {
    const g = gameWith([[...[7, 7, 7].map((r) => c(r)), c(9)], [c(2), c(3)], [c(4)]]);
    g.players[2].laidDown = true; // finished objective on an earlier turn
    const h = g.players[0].hand;
    g.layObjective([[h[0].id, h[1].id, h[2].id]]);
    g.discard(h[3].id); // goes out via discard
    expect(g.players.map((p) => p.level)).toEqual([1, 0, 1]);
    expect(g.players.map((p) => p.handsWon)).toEqual([1, 0, 0]);
  });
});

describe('game end and tiebreaks', () => {
  const finalHand = (winnerIdx: number, wins: number[], laid: boolean[]) => {
    const g = gameWith([[c(1)], [c(2)], [c(3)]]);
    g.players.forEach((p, i) => { p.level = g.levels.length - 1; p.handsWon = wins[i]; p.laidDown = laid[i]; });
    g.players[winnerIdx].laidDown = true;
    g.current = winnerIdx;
    g.players[winnerIdx].hand = [c(5)];
    g.discard(g.players[winnerIdx].hand[0].id);
    return g;
  };
  it('single finisher wins', () => {
    const g = finalHand(0, [0, 0, 0], [false, false, false]);
    expect(g.status).toBe('gameOver');
    expect(g.winners).toEqual([0]);
  });
  it('tie broken by most hands won by going out', () => {
    const g = finalHand(0, [2, 5, 0], [false, true, false]);
    expect(g.winners).toEqual([1]);
  });
  it('then by winning the final hand', () => {
    const g = finalHand(0, [2, 3, 0], [false, true, false]); // P0 wins final hand -> 3 wins each
    expect(g.winners).toEqual([0]);
  });
  it('final-hand winner takes a tie on hands won', () => {
    const g = finalHand(2, [3, 3, 2], [true, true, false]); // P2 reaches 3 wins too, and won the final hand
    expect(g.winners).toEqual([2]);
  });
  it('still tied after both tiebreakers: all tied players win', () => {
    const g = finalHand(2, [3, 3, 0], [true, true, false]); // P2 goes out with only 1 win; P0 and P1 tie at 3
    expect(g.winners.sort()).toEqual([0, 1]);
  });
});

describe('invariants', () => {
  it('conserves cards through many draw/discard turns incl. reshuffles', () => {
    const g = new DammitGame(['a', 'b', 'c', 'd'], { seed: 7 });
    const total = g.allCards().length;
    for (let i = 0; i < 150; i++) {
      g.draw(i % 3 === 0 ? 'discard' : 'deck');
      g.discard(g.player.hand[0].id);
      expect(g.allCards()).toHaveLength(total);
    }
    expect(new Set(g.allCards().map((x) => x.id)).size).toBe(total);
  });
  it('has 10 levels by default', () => expect(DEFAULT_LEVELS).toHaveLength(10));
});

import { standings } from '../src/engine';
describe('standings', () => {
  it('ranks by level, then hands won, then most recent winner', () => {
    const g = new DammitGame(['a', 'b', 'c', 'd'], { seed: 3 });
    g.players[0].level = 2; g.players[0].handsWon = 1;
    g.players[1].level = 4; g.players[1].handsWon = 0;
    g.players[2].level = 2; g.players[2].handsWon = 3;
    g.players[3].level = 2; g.players[3].handsWon = 1;
    g.lastHandWinner = 3;
    expect(standings(g).map((p) => p.name)).toEqual(['b', 'c', 'd', 'a']);
  });
});
