import { describe, expect, it } from 'vitest';
import { Card, Suit } from '../src/engine/cards';
import { decksFor, SwoopGame, swoopPoints } from '../src/swoop/engine';
import { swoopBotSteps } from '../src/swoop/bot';

let nextId = 5000;
const c = (rank: number, suit: Suit = 'S'): Card => ({ id: nextId++, rank, suit });

/** A game with hand-picked cards: everyone has only the given hands, 1 covered mystery slot each unless overridden. */
function rigged(hands: Card[][], opts: { board?: (Card | null)[][]; mystery?: (Card | null)[][]; target?: number } = {}) {
  const g = new SwoopGame(hands.map((_, i) => `P${i}`), { target: opts.target ?? 1000, seed: 1 });
  hands.forEach((h, i) => {
    g.players[i].hand = h;
    g.players[i].board = opts.board?.[i] ?? [null, null, null, null];
    g.players[i].mystery = opts.mystery?.[i] ?? [null, null, null, null];
  });
  g.pile = []; g.current = 0; g.fresh = true; g.revealed = null; g.status = 'playing';
  return g;
}

describe('setup and scoring', () => {
  it('deals 19 cards each and scales decks with players', () => {
    const g = new SwoopGame(['a', 'b', 'c']);
    for (const p of g.players) expect(p.hand.length + p.board.length + p.mystery.length).toBe(19);
    expect(decksFor(2)).toBe(2); expect(decksFor(5)).toBe(2); expect(decksFor(6)).toBe(3); expect(decksFor(8)).toBe(3); expect(decksFor(9)).toBe(4);
    const all = g.players.flatMap((p) => [...p.hand, ...p.board, ...p.mystery]).length + g.stackCount;
    expect(all).toBe(104);
  });
  it('scores A-9 = 5, J/Q/K = 10, the 10 (SWOOP) = 25', () => {
    expect(swoopPoints(c(1))).toBe(5); expect(swoopPoints(c(9))).toBe(5);
    expect(swoopPoints(c(11))).toBe(10); expect(swoopPoints(c(13))).toBe(10);
    expect(swoopPoints(c(10))).toBe(25);
  });
});

describe('playing', () => {
  it('requires equal or lower, same number only, and one SWOOP at a time', () => {
    const g = rigged([[c(5), c(5), c(8), c(10), c(10)], [c(9), c(2)]]);
    expect(() => g.play([g.players[0].hand[0], g.players[0].hand[2]].map((x) => x.id))).toThrow(); // mixed numbers
    g.play([g.players[0].hand[0].id, g.players[0].hand[1].id]); // two 5s
    expect(g.current).toBe(1);
    expect(g.checkPlay([g.players[1].hand[0].id])).not.toBeNull(); // 9 > 5
    g.play([g.players[1].hand[1].id]); // 2 is fine
    expect(g.current).toBe(0);
    const tens = g.players[0].hand.filter((x) => x.rank === 10);
    expect(g.checkPlay(tens.map((x) => x.id))).not.toBeNull(); // two SWOOPs together
  });
  it('a lone SWOOP clears the pile and the same player continues', () => {
    const g = rigged([[c(3), c(10)], [c(9), c(2)]]);
    g.pile = [c(7), c(6)];
    g.play([g.players[0].hand[1].id]);
    expect(g.pile.length).toBe(0);
    expect(g.current).toBe(0);
    expect(g.fresh).toBe(true);
  });
  it('four of a kind swoops, including when built across turns', () => {
    const g = rigged([[c(4), c(4), c(1)], [c(4), c(4), c(1)]]);
    g.play(g.players[0].hand.slice(0, 2).map((x) => x.id));
    expect(g.pile.length).toBe(2);
    g.play(g.players[1].hand.slice(0, 2).map((x) => x.id)); // 4 fours on the pile
    expect(g.pile.length).toBe(0);
    expect(g.current).toBe(1); // the player who completed it goes again
  });
  it('a card higher than the pile cannot be played, so the pile can be taken', () => {
    const g = rigged([[c(3)], [c(9), c(12)]]);
    g.pile = [c(2)];
    expect(g.canTake()).toBe(true);
  });
  it('take works when nothing is playable', () => {
    const g = rigged([[c(9), c(12)], [c(1)]]);
    g.pile = [c(2), c(2)];
    expect(g.canTake()).toBe(true);
    const shown = g.players[0].hand[0];
    g.take(shown.id);
    expect(g.pile.length).toBe(0);
    expect(g.players[0].hand.length).toBe(4); // 1 left in hand + shown card + 2 pile cards
    expect(g.current).toBe(1);
  });
  it('cannot take while holding a playable card', () => {
    const g = rigged([[c(1), c(12)], [c(1)]]);
    g.pile = [c(5)];
    expect(g.canTake()).toBe(false);
    expect(() => g.take(g.players[0].hand[1].id)).toThrow();
  });
});

describe('mystery cards', () => {
  it('only flip when uncovered and before playing; a playable flip must be played', () => {
    const m = c(3);
    const g = rigged([[c(7)], [c(1)]], { mystery: [[m, null, null, null], []], board: [[c(8), null, null, null], []] });
    expect(g.flippable()).toEqual([]); // covered by the 8
    g.play([g.players[0].board[0]!.id]); // play the board 8
    // turn passes; come back around
    g.pile = [];
    g.current = 0; g.fresh = true;
    expect(g.flippable()).toEqual([0]);
    const res = g.flip(0);
    expect(res.took).toBe(false);
    expect(g.revealed!.id).toBe(m.id);
    expect(g.checkPlay([g.players[0].hand[0].id])).not.toBeNull(); // must play the flipped card
    g.play([m.id]);
    expect(g.revealed).toBeNull();
  });
  it('too-high flip takes the pile', () => {
    const m = c(12);
    const g = rigged([[c(2)], [c(1)]], { mystery: [[m, null, null, null], []] });
    g.pile = [c(4), c(4)];
    const res = g.flip(0);
    expect(res.took).toBe(true);
    expect(g.pile.length).toBe(0);
    expect(g.players[0].hand.length).toBe(4); // 1 own + the flipped card + 2 pile cards
    expect(g.current).toBe(1);
  });
  it('cannot flip after playing a card', () => {
    const g = rigged([[c(3), c(3)], [c(1)]], { mystery: [[c(5), null, null, null], []] });
    g.pile = [c(9)];
    g.play([g.players[0].hand[0].id]);
    // turn passed to player 1; pretend still P0 mid-turn after swoop: not fresh
    g.current = 0; g.fresh = false;
    expect(g.flippable()).toEqual([]);
  });
});

describe('rounds and games', () => {
  it('going out scores 0 for the winner and ends the game at the target (lowest wins)', () => {
    const g = rigged([[c(5)], [c(13), c(1)], [c(2)]], { target: 15 });
    g.play([g.players[0].hand[0].id]);
    expect(g.status).toBe('gameOver');
    expect(g.lastRoundPoints).toEqual([0, 15, 5]);
    expect(g.winners).toEqual([0]);
  });
  it('round over below target allows a next round with a rotated starter', () => {
    const g = rigged([[c(5)], [c(13)]], { target: 500 });
    g.play([g.players[0].hand[0].id]);
    expect(g.status).toBe('roundOver');
    g.nextRound();
    expect(g.roundNumber).toBe(2);
    expect(g.current).toBe(1);
  });
});

describe('bots', () => {
  it('finish games for many player counts without errors and conserve cards', () => {
    for (const n of [2, 3, 4, 6, 9]) {
      for (let seed = 1; seed <= 5; seed++) {
        const g = new SwoopGame(Array.from({ length: n }, (_, i) => `B${i}`), { target: 120, seed: seed * 7 });
        const total = decksFor(n) * 52;
        let guard = 0;
        while (g.status !== 'gameOver' && guard++ < 20000) {
          if (g.status === 'roundOver') { g.nextRound(); continue; }
          for (const _ of swoopBotSteps(g)) { /* run the whole turn */ }
          const cards = g.players.flatMap((p) => [...p.hand, ...p.board.filter(Boolean), ...p.mystery.filter(Boolean)]).length + g.pile.length + g.stackCount + (g.revealed ? 1 : 0);
          expect(cards).toBe(total);
        }
        expect(g.status).toBe('gameOver');
        expect(g.winners.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('max four of a number', () => {
  it('cannot overfill: 2 nines onto 3 nines is refused, 1 nine swoops', () => {
    const g = rigged([[c(9), c(9), c(2)], [c(9), c(1)]]);
    g.pile = [c(9), c(9), c(9)];
    const nines = g.players[0].hand.filter((x) => x.rank === 9).map((x) => x.id);
    expect(g.checkPlay(nines)).not.toBeNull();
    g.play([nines[0]]);
    expect(g.pile.length).toBe(0); // swooped
  });
  it('cannot play five at once', () => {
    const g = rigged([[c(4), c(4), c(4), c(4), c(4)], [c(1)]]);
    expect(g.checkPlay(g.players[0].hand.map((x) => x.id))).not.toBeNull();
  });
});
