import { DammitGame, Player } from './game';

/**
 * Leaderboard order: highest level first. Ties are broken by hands won by going out,
 * then by who won the most recent hand, then by seat order.
 */
export function standings(game: DammitGame): Player[] {
  return game.players.slice().sort((a, b) =>
    b.level - a.level ||
    b.handsWon - a.handsWon ||
    Number(b.id === game.lastHandWinner) - Number(a.id === game.lastHandWinner) ||
    a.id - b.id);
}
