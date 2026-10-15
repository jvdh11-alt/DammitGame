import { Card, DammitGame } from '../engine';

export interface SeatInfo { name: string; bot: boolean; connected: boolean; host: boolean }

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'addbot' }
  | { t: 'removebot'; seat: number }
  | { t: 'start' }
  | { t: 'tolobby' }
  | { t: 'next' }
  | { t: 'leave' }
  | { t: 'act'; a: 'draw'; from: 'deck' | 'discard' }
  | { t: 'act'; a: 'objective'; groups: number[][] }
  | { t: 'act'; a: 'meld'; ids: number[] }
  | { t: 'act'; a: 'discard'; id: number }
  | { t: 'act'; a: 'layon'; plays: { id: number; player: number; meld: number }[] };

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

export type ServerMsg =
  | { t: 'joined'; code: string; seat: number; token: string }
  | { t: 'lobby'; code: string; seat: number; seats: SeatInfo[] }
  | { t: 'state'; seat: number; snap: Snapshot; lines: string[]; flash: number[]; actor: number | null; drawn: number | null; resume: boolean; seats: SeatInfo[] }
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
