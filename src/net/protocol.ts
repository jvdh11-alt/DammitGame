import { Card, DammitGame } from '../engine';
import { LastPlay, SwoopGame, SwoopPlayer } from '../swoop/engine';

export type GameKind = 'dammit' | 'swoop';

export interface SeatInfo { name: string; bot: boolean; connected: boolean; host: boolean }

export type ClientMsg =
  | { t: 'create'; name: string; game?: GameKind }
  | { t: 'join'; code: string; name: string }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'addbot' }
  | { t: 'removebot'; seat: number }
  | { t: 'start'; target?: number }
  | { t: 'settarget'; target: number }
  | { t: 'tolobby' }
  | { t: 'next' }
  | { t: 'leave' }
  | { t: 'act'; a: 'draw'; from: 'deck' | 'discard' }
  | { t: 'act'; a: 'objective'; groups: number[][] }
  | { t: 'act'; a: 'meld'; ids: number[] }
  | { t: 'act'; a: 'discard'; id: number }
  | { t: 'act'; a: 'layon'; plays: { id: number; player: number; meld: number }[] }
  | { t: 'act'; a: 'splay'; ids: number[] }
  | { t: 'act'; a: 'sflip'; slot: number }
  | { t: 'act'; a: 'stake'; id: number };

export interface Snapshot {
  players: DammitGame['players'];
  drawPile: Card[];
  discardPile: Card[];
  current: number;
  phase: DammitGame['phase'];
  status: DammitGame['status'];
  handNumber: number;
  lastHandWinner: number | null;
  winners: number[];
  stalemate: boolean;
  levels: DammitGame['levels'];
}

export interface SwoopSnapshot {
  players: { id: number; name: string; hand: Card[]; board: (Card | null)[]; mystery: (Card | null)[]; total: number }[];
  pile: Card[];
  stackCount: number;
  current: number;
  status: SwoopGame['status'];
  roundNumber: number;
  target: number;
  winners: number[];
  lastOut: number | null;
  lastRoundPoints: number[];
  revealed: Card | null;
  fresh: boolean;
  lastPlay: LastPlay | null;
}

export type ServerMsg =
  | { t: 'joined'; code: string; seat: number; token: string }
  | { t: 'lobby'; code: string; seat: number; seats: SeatInfo[]; game: GameKind; target: number }
  | { t: 'state'; kind: GameKind; seat: number; snap: Snapshot | SwoopSnapshot; lines: string[]; flash: number[]; actor: number | null; drawn: number | null; resume: boolean; seats: SeatInfo[] }
  | { t: 'err'; msg: string }
  | { t: 'left' };

const hidden = (n: number, base: number): Card[] =>
  Array.from({ length: n }, (_, i) => ({ id: base - i, rank: 1, suit: 'S' as const }));

/** What one seat is allowed to see: its own hand, but only the sizes of other hands and of the draw pile. */
export function snapshotFor(game: DammitGame, seat: number): Snapshot {
  return {
    players: game.players.map((p) => (p.id === seat ? p : { ...p, hand: hidden(p.hand.length, -1 - p.id * 1000) })),
    drawPile: hidden(game.drawPile.length, -100000),
    discardPile: game.discardPile,
    current: game.current, phase: game.phase, status: game.status, handNumber: game.handNumber,
    lastHandWinner: game.lastHandWinner, winners: game.winners, stalemate: game.stalemate, levels: game.levels,
  };
}

/** Rebuilds a read-only game object (with all the query helpers) from a snapshot. */
export function mirrorGame(snap: Snapshot): DammitGame {
  return Object.assign(Object.create(DammitGame.prototype), snap) as DammitGame;
}

const hiddenSwoop = (n: number, base: number): Card[] => Array.from({ length: n }, (_, i) => ({ id: base - i, rank: 0, suit: 'S' as const }));

/** A seat's view of a Swoop table: own hand and everyone's face-up board cards; mystery cards are only "there or not". */
export function swoopSnapshotFor(g: SwoopGame, seat: number): SwoopSnapshot {
  return {
    players: g.players.map((p: SwoopPlayer) => ({
      id: p.id, name: p.name, total: p.total, board: p.board,
      hand: p.id === seat ? p.hand : hiddenSwoop(p.hand.length, -1 - p.id * 1000),
      mystery: p.mystery.map((c, i) => (c ? ({ id: -500 - p.id * 10 - i, rank: 0, suit: 'S' } as Card) : null)),
    })),
    pile: g.pile, stackCount: g.stackCount, current: g.current, status: g.status, roundNumber: g.roundNumber, target: g.target,
    winners: g.winners, lastOut: g.lastOut, lastRoundPoints: g.lastRoundPoints, revealed: g.revealed, fresh: g.fresh, lastPlay: g.lastPlay,
  };
}

export function mirrorSwoop(snap: SwoopSnapshot): SwoopGame {
  return Object.assign(Object.create(SwoopGame.prototype), snap) as SwoopGame;
}
