import './style.css';
import { ClientMsg, mirrorGame, ServerMsg } from '../net/protocol';
import { clearSession, defaultServerUrl, loadSession, NetState, normalizeUrl, openSocket, saveServerUrl, saveSession, sendMsg } from '../net/client';
import { audio, SfxName } from './audio';
import {
  Card, cardLabel, DammitGame, extendMeld, findExtraMelds, findObjective, MeldRef, Requirement, RuleError,
  botTurnSteps, standings,
} from '../engine';

let HUMAN = 0; // my seat (always 0 in a solo game)
const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const BOT_NAMES = ['Ruby', 'Max', 'Ivy', 'Otis', 'Nora', 'Leo', 'Maya', 'Finn', 'Zoe', 'Hank', 'Lena', 'Jude', 'Cleo', 'Gus', 'Pearl', 'Walt', 'Dot', 'Ezra', 'Mabel', 'Ike'];
const MAX_BOTS = BOT_NAMES.length;
const clampBots = (n: number) => Math.min(MAX_BOTS, Math.max(1, Math.round(n) || 1));

// ---------- saved preferences (safe if storage is unavailable) ----------

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const flag = (k: string, d: boolean) => { const v = store.get(k); return v === null ? d : v === '1'; };

/** Bot speed 1 (slowest, 3.0s) to 10 (fastest, 0.7s) is the pause before each bot action. */
const delayFor = (speed: number) => Math.round(3000 - ((speed - 1) * 2300) / 9);

type Screen = 'setup' | 'game' | 'online' | 'lobby';
let screen: Screen = 'setup';
let game: DammitGame;
let selected = new Set<number>();   // cards chosen for an action (discard / lay down / lay on)
let kept = new Set<number>();       // cards marked "keeping for my goal"
let lastDrawnId: number | null = null;
let message = '';
let log: string[] = [];
let handStartLevels: number[] = [];
type SortMode = 'suit' | 'rank' | 'custom';
let sortMode: SortMode = (['suit', 'rank', 'custom'] as const).find((m) => m === store.get('sortMode')) ?? 'suit';
let handOrder: number[] = [];       // card ids in the player's own order (used in 'custom' mode)
let suppressClick = false;
let oppDetail: number | null = null;          // player whose details popup is open (phone)
let panel: 'levels' | 'log' | null = null;    // levels / move-log popup (phone)
const PHONE_Q = '(max-height: 560px) and (orientation: landscape), (max-width: 700px)';
const isPhone = () => window.matchMedia(PHONE_Q).matches;
let flashIds = new Set<number>();    // cards just played onto a meld (briefly highlighted)
let flashTimer = 0;
const meldCardIds = () => new Set(game.players.flatMap((p) => p.melds.flatMap((m) => m.cards.map((c) => c.id))));
function flash(ids: number[]) {
  if (!ids.length) return;
  ids.forEach((i) => flashIds.add(i));
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { flashIds.clear(); if (screen === 'game') render(); }, 1200);
}
let showPlayable = flag('showPlayable', true);
let showMelds = flag('showMelds', true);
let levelsOpen = true;
let showBoard = false;
let botSpeed = Number(store.get('botSpeed')) || 3;
let botTimer: number | undefined;
let botSteps: Generator<string, void> | null = null;
let drawnTimer: number | undefined;
let playerName = (store.get('playerName') || '').slice(0, 16);
let botCount = clampBots(Number(store.get('botCount')) || 3);

const app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---------- helpers ----------

const reqText = (reqs: Requirement[]) =>
  reqs.map((r) => `${r.type === 'set' ? 'Set' : 'Run'} of ${r.size}`).join(' + ') || 'Done';

function cardHtml(c: Card, extra = '', attrs = ''): string {
  const red = c.suit === 'H' || c.suit === 'D' ? 'red' : 'black';
  return `<button class="card ${red} ${extra}" ${attrs} aria-label="${RANK_LABEL[c.rank] ?? c.rank} of ${c.suit}">` +
    `<span class="r">${RANK_LABEL[c.rank] ?? c.rank}</span><span class="s">${SUIT_SYMBOL[c.suit]}</span></button>`;
}

function sortedHand(hand: Card[]): Card[] {
  const suitOrder = ['S', 'H', 'D', 'C'];
  const bySuit = (a: Card, b: Card) => suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit) || a.rank - b.rank;
  if (sortMode === 'rank') return hand.slice().sort((a, b) => a.rank - b.rank || suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit));
  if (sortMode === 'suit') return hand.slice().sort(bySuit);
  // custom: the player's own order first, any new cards (e.g. just drawn) go on the end
  const pos = new Map(handOrder.map((id, i) => [id, i]));
  const known = hand.filter((c) => pos.has(c.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  const fresh = hand.filter((c) => !pos.has(c.id)).sort(bySuit);
  return [...known, ...fresh];
}

/** -1 = not dealing; 0 = undealt deck showing; n = n cards dealt to each player so far. */
let dealStep = -1;
let dealTimer = 0;
let overlayKey = '';
const dealing = () => dealStep >= 0;
const isMyTurn = () => !dealing() && game.status === 'playing' && game.current === HUMAN;

/** Shows the undealt deck for a moment, then deals one card round at a time with a swish each. */
function runDeal() {
  window.clearTimeout(dealTimer);
  const total = game.players[HUMAN].hand.length;
  dealStep = 0;
  const step = () => {
    dealStep++;
    audio.sfx('draw');
    if (dealStep >= total) {
      dealStep = -1;
      render();
      if (game.current !== HUMAN) scheduleBots(); else audio.sfx('turn');
      return;
    }
    render();
    dealTimer = window.setTimeout(step, 150);
  };
  render();
  dealTimer = window.setTimeout(step, 2200);
}
const selectedCards = () => game.players[HUMAN].hand.filter((c) => selected.has(c.id));

/** The pink 'just drawn' highlight lasts about 3 seconds. */
function fadeDrawnHighlight(id: number) {
  window.clearTimeout(drawnTimer);
  drawnTimer = window.setTimeout(() => {
    if (lastDrawnId === id) lastDrawnId = null;
    app.querySelectorAll('.card.drawn').forEach((el) => el.classList.remove('drawn'));
  }, 3000);
}

/** Wraps card names like 9♥ in a chip coloured by suit (light chip so black suits stay readable). */
function colorCards(html: string): string {
  return html.replace(/(10|[2-9AJQK])([♠♥♦♣])/g, (_m, r: string, su: string) =>
    `<span class="cc ${su === '♥' || su === '♦' ? 'red' : 'black'}">${r}${su}</span>`);
}

const myName = () => game?.players[HUMAN]?.name ?? 'You';
function pushLog(lines: string[]) {
  log = [...lines.reverse(), ...log].slice(0, 60);
}

/** Cards in my hand that can be added directly to some meld on the table. */
function playableIds(): Set<number> {
  const ids = new Set<number>();
  for (const c of game.players[HUMAN].hand)
    if (game.players.some((p) => p.melds.some((m) => extendMeld(m, c) !== null))) ids.add(c.id);
  return ids;
}

/** Cards in my hand that already form something useful: my objective, or (after it) extra melds. */
function meldIds(): Set<number> {
  const me = game.players[HUMAN];
  if (!me.laidDown) {
    const groups = findObjective(me.hand, game.requirementsFor(me));
    return new Set(groups ? groups.flat() : []);
  }
  return new Set(findExtraMelds(me.hand).flat());
}

// ---------- hand animation (cards slide to their new spots) ----------

const SLIDE_MS = 220;
const SLIDE_EASE = 'cubic-bezier(.2,.8,.2,1)';

function captureHandRects(): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  app.querySelectorAll<HTMLElement>('.hand .hc').forEach((el) => m.set(el.dataset.id!, el.getBoundingClientRect()));
  return m;
}

/** After a re-render, slide every card that moved from where it was to where it is now. */
function playFlip(prev: Map<string, DOMRect>) {
  if (prev.size === 0) return;
  app.querySelectorAll<HTMLElement>('.hand .hc').forEach((el) => {
    const old = prev.get(el.dataset.id!);
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: SLIDE_EASE });
  });
}

// ---------- error panel (so a failure shows a message instead of a blank page) ----------

function showFatal(err: unknown) {
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(err);
  window.clearTimeout(botTimer);
  let box = document.getElementById('fatal');
  if (!box) { box = document.createElement('div'); box.id = 'fatal'; document.body.appendChild(box); }
  box.innerHTML = `<div class="overlay"><div class="panel"><h2>Something went wrong</h2>
    <p class="muted">Please send me the text below.</p><pre>${esc(msg.slice(0, 1800))}</pre>
    <button class="big" data-fatal="reload">Reload</button></div></div>`;
}
window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-fatal=reload]')) location.reload();
});

// ---------- sound ----------

let soundOpen = false;

function soundRows(): string {
  const row = (kind: 'music' | 'sfx', icon: string, label: string, on: boolean, vol: number) =>
    `<div class="srow"><button class="ghost small ${on ? 'on' : ''}" data-action="${kind}Toggle" aria-pressed="${on}">${icon} ${label}: ${on ? 'On' : 'Off'}</button>
      <input type="range" min="0" max="100" step="1" value="${Math.round(vol * 100)}" data-vol="${kind}" aria-label="${label} volume" ${on ? '' : 'disabled'}></div>`;
  return row('music', '🎵', 'Music', audio.musicOn, audio.musicVol) + row('sfx', '🔔', 'Effects', audio.sfxOn, audio.sfxVol);
}

/** Header: a Sound menu. Landing page: the same rows laid out inline. */
function soundControls(inline = false): string {
  if (inline) return `<div class="sound-rows">${soundRows()}</div>`;
  const fsOk = !!document.documentElement.requestFullscreen;
  const fsBtn = fsOk ? `<button class="ghost small" data-action="fullscreen">${document.fullscreenElement ? '⤢ Exit full screen' : '⛶ Full screen (hides the browser bar)'}</button>` : '';
  const toggles = `<div class="toggles">
      <label><input type="checkbox" data-toggle="showMelds" ${showMelds ? 'checked' : ''}> Highlight melds in my hand</label>
      <label><input type="checkbox" data-toggle="showPlayable" ${showPlayable ? 'checked' : ''}> Highlight cards I can play on melds</label>
    </div>`;
  return `<span class="soundwrap"><button class="ghost small" data-action="soundmenu" aria-expanded="${soundOpen}">⚙ Settings ▾</button>
    ${soundOpen ? `<div class="sound-pop">${toggles}${fsBtn}${soundRows()}</div>` : ''}</span>`;
}

/** Which effect (if any) matches a bot's action line. */
function sfxFor(step: string): SfxName | null {
  if (/ drew | took /.test(step)) return 'draw';
  if (/ discarded /.test(step)) return 'discard';
  if (/ laid (down|a new meld)/.test(step)) return 'lay';
  if (/ played .* onto /.test(step)) return 'tick';
  return null;
}

let announcedKey = '';
/** Plays the hand-won / game-won sounds once when a hand or game ends. */
function announceEnd() {
  if (game.status === 'playing') return;
  const key = `${game.handNumber}-${game.status}`;
  if (key === announcedKey) return;
  announcedKey = key;
  const name: SfxName = game.status === 'gameOver'
    ? (game.winners.includes(HUMAN) ? 'gameWon' : 'gameOver')
    : (game.lastHandWinner === HUMAN ? 'handWon' : 'handOver');
  window.setTimeout(() => audio.sfx(name), 350); // let the final card sound finish first
  window.setTimeout(() => { overlayKey = key; if (screen === 'game') render(); }, 3000); // let the jingle play before the popup
}

// ---------- rendering ----------

function render() {
  if (drag?.active) return; // never rebuild the screen under a card being dragged; endDrag re-renders
  app.className = screen === 'game' ? 'game' : 'setup-screen';
  if (screen === 'setup') return renderSetup();
  if (screen === 'online') return renderOnline();
  if (screen === 'lobby') return renderLobby();
  const me = game.players[HUMAN];
  const myTurn = isMyTurn();
  const reqs = game.requirementsFor(me);
  const sel = selectedCards();
  const oneSelected = sel.length === 1 ? sel[0] : null;
  const playing = myTurn && game.phase === 'play';
  kept = new Set([...kept].filter((id) => me.hand.some((c) => c.id === id)));

  const meldsFor = (pi: number): string => game.players[pi].melds.map((m, mi) => {
    const canDrop = playing && me.laidDown && oneSelected && extendMeld(m, oneSelected) !== null;
    return `<div class="meld ${canDrop ? 'target' : ''}" data-kind="${m.kind}" data-action="layon" data-p="${pi}" data-m="${mi}">
      ${m.cards.map((c) => cardHtml(c, `mini ${flashIds.has(c.id) ? 'flash' : ''}`, 'tabindex="-1"')).join('')}</div>`;
  }).join('');

  const opponents = game.players.filter((p) => p.id !== HUMAN).map((p) => `
    <div class="opp-col"><div class="opp ${p.laidDown ? 'laid' : ''} ${!dealing() && game.current === p.id && game.status === 'playing' ? 'active' : ''}" data-action="opp" data-p="${p.id}">
      ${!dealing() && game.current === p.id && game.status === 'playing' ? '<div class="think" aria-label="thinking"><i></i><i></i><i></i></div>' : ''}
      <div class="opp-name">${esc(p.name)}<span class="phone-only opp-short"> L${Math.min(p.level + 1, game.levels.length)} · ${dealing() ? Math.min(p.hand.length, dealStep) : p.hand.length}${p.laidDown ? ' ✔' : ''}</span></div>
      <div class="opp-meta opp-full">Level ${Math.min(p.level + 1, game.levels.length)} · ${dealing() ? Math.min(p.hand.length, dealStep) : p.hand.length} cards</div>
      <div class="opp-meta opp-full">${p.laidDown ? '✔ laid down' : reqText(game.requirementsFor(p))}</div>
      <div class="opp-meta opp-full">${p.handsWon} out</div>
    </div>
    <div class="melds opp-melds" data-p="${p.id}">${meldsFor(p.id)}</div></div>`).join('');

  const top = game.discardPile[game.discardPile.length - 1];
  const canDraw = myTurn && game.phase === 'draw';
  const piles = `
    <div class="piles">
      <button class="pile deck ${canDraw ? 'ready' : ''}" data-action="draw-deck" ${canDraw ? '' : 'disabled'}>
        <span>Deck</span><b>${game.drawPile.length + (dealing() ? (game.players[HUMAN].hand.length - dealStep) * game.players.length : 0)}</b></button>
      <div class="pile-col">
        ${top && !dealing() ? cardHtml(top, `discard-top ${canDraw ? 'ready' : ''}`, `data-action="draw-discard" ${canDraw ? '' : 'disabled'}`) : '<div class="pile empty"></div>'}
        <small>Discard</small>
      </div>
    </div>`;

  let status: string;
  if (game.status !== 'playing') status = '';
  else if (dealing()) status = 'Dealing…';
  else if (myTurn) status = game.phase === 'draw' ? 'Draw from the deck or the discard pile' : (me.laidDown
    ? 'Lay cards on melds, lay your own melds, then discard (or go out)'
    : `Make your objective (${reqText(reqs)}), or just discard`);
  else status = `${game.player.name} is playing…`;

  const playableNow = playing && me.laidDown ? playableIds() : new Set<number>();
  const L = (long: string, short: string) => `<span class="long">${long}</span><span class="short">${short}</span>`;
  const mover = sel.length === 1 && !dealing();
  const actions = `
    <div class="actions">
      ${!me.laidDown ? `<button data-action="objective" ${playing && sel.length ? '' : 'disabled'}>${L('Lay down objective', 'Lay down')}</button>
         <button class="ghost" data-action="hint" ${playing ? '' : 'disabled'}>${L('Select my objective', 'Auto-pick')}</button>` :
        `<button data-action="meld" ${playing && sel.length >= 3 ? '' : 'disabled'}>${L('Lay new meld', 'Meld')}</button>
         <button data-action="playall" ${playableNow.size ? '' : 'disabled'}>${L('Play all playable', 'Play all')}${playableNow.size ? ` (${playableNow.size})` : ''}</button>`}
      <button data-action="discard" ${playing && sel.length === 1 ? '' : 'disabled'}>Discard</button>
      <button class="ghost" data-action="sort" title="Cycle sort. Drag any card to arrange your own order.">${L(`Sort: ${sortMode}`, 'Sort')}</button>
      <button class="ghost mv phone-only" data-action="moveleft" aria-label="Move selected card left" ${mover ? '' : 'disabled'}>◀</button>
      <button class="ghost mv phone-only" data-action="moveright" aria-label="Move selected card right" ${mover ? '' : 'disabled'}>▶</button>
      ${kept.size ? `<button class="ghost" data-action="clearkeep">${L('Clear ★ marks', 'Clear ★')}</button>` : ''}
    </div>`;

  const melds = showMelds ? meldIds() : new Set<number>();
  const hand = (dealing() ? sortedHand(me.hand).slice(0, dealStep) : sortedHand(me.hand)).map((c) => {
    const cls = [
      selected.has(c.id) ? 'selected' : '',
      kept.has(c.id) ? 'kept' : '',
      c.id === lastDrawnId ? 'drawn' : '',
      showPlayable && playableNow.has(c.id) ? 'playable' : '',
      melds.has(c.id) ? 'meldhint' : '',
    ].join(' ');
    return `<div class="hc" data-id="${c.id}">${cardHtml(c, cls, `data-action="select" data-id="${c.id}"`)}
      <button class="star ${kept.has(c.id) ? 'on' : ''}" data-action="keep" data-id="${c.id}" title="Mark as keeping for my goal" aria-label="Mark as keeping for my goal">★</button></div>`;
  }).join('');

  const levelsList = game.levels.map((lv, i) => {
    const here = game.players.filter((p) => p.level === i).map((p) => p.name);
    const cls = i === me.level ? 'mine' : i < me.level ? 'past' : '';
    return `<li class="${cls}"><span class="n">${lv.id}</span><span class="g">${reqText(lv.requirements)}</span>
      <span class="who">${here.map(esc).join(', ')}</span></li>`;
  }).join('');

  const prevRects = captureHandRects();
  const panelScroll = app.querySelector<HTMLElement>('.overlay .panel')?.scrollTop ?? 0;
  const scrolls = ['.hand', '.opps'].map((q) => app.querySelector<HTMLElement>(q)?.scrollLeft ?? 0);
  app.innerHTML = `
    <header>
      <div><b>Dammit</b> <span class="muted">Hand ${game.handNumber}</span></div>
      <div class="hdr-actions">
        ${soundControls()}
        ${net ? '' : `<label class="speed"><span class="lbl">Bot speed</span> <input type="range" min="1" max="10" step="1" value="${botSpeed}" data-speed>
          <span data-speed-label>${speedLabel()}</span></label>`}
        <button class="ghost small phone-only" data-action="panel-levels">Levels</button>
        <button class="ghost small phone-only" data-action="panel-log">Log</button>
        <button class="ghost small" data-action="board">${isPhone() ? '🏆' : 'Leaderboard'}</button>
        <button class="ghost small" data-action="quit">${net ? 'Leave' : 'New game'}</button>
      </div>
    </header>
    <div class="rotate-hint">↻ Turn your phone sideways for the best view</div>
    <div class="layout">
      <div class="main">
        <section class="opps">${opponents}</section>
        ${piles}
        <section class="my-melds ${me.laidDown ? 'laid' : ''}"><div class="meld-owner">Your melds<span class="phone-only goal"> · Goal, level ${Math.min(me.level + 1, game.levels.length)}/${game.levels.length}: <b>${reqText(reqs)}</b>${me.laidDown ? ' ✔' : ''}</span></div><div class="melds">${meldsFor(HUMAN) || '<span class="hint">Nothing laid yet</span>'}</div></section>
        <div class="mine ${myTurn ? 'myturn' : ''}">
        <div class="status ${message ? 'err' : ''}">${esc(message || status)}</div>
        ${actions}
        <section class="hand">${hand}</section>
        </div>
        <div class="legend">
          <span><i class="sw sel"></i>selected</span><span><i class="sw keep"></i>★ keeping for goal</span>
          <span><i class="sw drawn"></i>just drawn</span><span><i class="sw meld"></i>meld in hand</span>
          <span><i class="sw play"></i>playable on a meld</span>
        </div>
      </div>
      <aside class="side">
        <section class="levels">
          <button class="ghost levels-toggle" data-action="levels">All levels ${levelsOpen ? '▾' : '▸'}</button>
          ${levelsOpen ? `<ol>${levelsList}</ol>` : ''}
        </section>
        <section class="log"><div class="log-title">Moves</div>${log.slice(0, 40).map((l) => `<div>${colorCards(esc(l))}</div>`).join('') || '<div>Nothing yet</div>'}</section>
      </aside>
    </div>
    ${overlayHtml()}`;
  document.title = myTurn ? '▶ Your turn — Dammit' : 'Dammit';
  ['.hand', '.opps'].forEach((q, i) => { const el = app.querySelector<HTMLElement>(q); if (el) el.scrollLeft = scrolls[i]; });
  const pn = app.querySelector<HTMLElement>('.overlay .panel');
  if (pn) pn.scrollTop = panelScroll; // keep a popup's scroll position across bot-move redraws
  fitHand();
  fitMelds();
  capOppMelds();
  if (!pn) playFlip(prevRects); // no card animations underneath an open popup
  announceEnd();
}

/** Phone layout: cards overlap like a real hand so the whole hand fits on one row. */
function fitHand() {
  const hand = app.querySelector<HTMLElement>('.hand');
  if (!hand) return;
  const cards = Array.from(hand.querySelectorAll<HTMLElement>('.hc'));
  cards.forEach((c, i) => { c.style.marginLeft = ''; c.style.zIndex = c.querySelector('.selected') ? '40' : String(i + 1); });
  if (!isPhone() || cards.length < 2) return;
  const cs = getComputedStyle(hand);
  const avail = hand.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const cw = cards[0].offsetWidth;
  const total = cw * cards.length;
  if (total <= avail) return;
  const MIN_STRIP = 15;
  const overlap = Math.min((total - avail) / (cards.length - 1), cw - MIN_STRIP);
  cards.slice(1).forEach((c) => { c.style.marginLeft = `-${overlap.toFixed(1)}px`; });
}

/** Phone layout: an opponent's meld area never grows past its box; extra melds collapse into a "+N" chip. */
function capOppMelds() {
  if (!isPhone()) return;
  app.querySelectorAll<HTMLElement>('.opp-melds').forEach((box) => {
    const melds = Array.from(box.querySelectorAll<HTMLElement>(':scope > .meld'));
    const limit = box.clientHeight;
    if (!melds.length || box.scrollHeight <= limit + 1) return;
    const chip = document.createElement('span');
    chip.className = 'more';
    chip.dataset.action = 'opp';
    chip.dataset.p = box.dataset.p ?? '0';
    box.appendChild(chip);
    let hidden = 0;
    const top = box.getBoundingClientRect().top;
    const fits = (el: HTMLElement) => el.getBoundingClientRect().bottom - top <= limit + 1;
    for (let i = melds.length - 1; i >= 0; i--) {
      chip.textContent = `+${hidden}`;
      if (hidden > 0 && fits(chip) && fits(melds[i])) break;
      if (hidden === 0 && fits(melds[i])) { chip.remove(); return; }
      melds[i].style.display = 'none';
      hidden++;
    }
    chip.textContent = `+${hidden}`;
  });
}

/** A meld too wide for its column compresses: sets show only the top card, runs show just the two end cards. */
function fitMelds() {
  app.querySelectorAll<HTMLElement>('.meld').forEach((m) => {
    if (m.scrollWidth <= m.clientWidth + 1) return;
    const cards = Array.from(m.querySelectorAll<HTMLElement>('.card'));
    if (cards.length < 3) return;
    const isRun = m.dataset.kind === 'run';
    const hidden = isRun ? cards.slice(1, -1) : cards.slice(0, -1);
    hidden.forEach((c) => { c.style.display = 'none'; });
    const badge = document.createElement('span');
    badge.className = 'cnt';
    badge.textContent = isRun ? `⋯${cards.length}⋯` : `×${cards.length}`;
    if (isRun) cards[cards.length - 1].before(badge); else cards[cards.length - 1].after(badge);
    if (cards.some((c) => c.classList.contains('flash'))) m.classList.add('flashmeld');
  });
}

function speedLabel(): string {
  return `${(delayFor(botSpeed) / 1000).toFixed(1)}s`;
}

function renderSetup() {
  app.innerHTML = `
    <div class="setup">
      <div class="s-left"><h1>Dammit</h1>
      <p class="muted">Ten levels. Finish each one before moving on. First to clear level 10 wins.</p></div>
      <div class="s-right">
      ${soundControls(true)}
      <label class="opp-count">Your name
        <input type="text" maxlength="16" value="${esc(playerName)}" placeholder="You" data-pname aria-label="Your name">
      </label>
      <label class="opp-count">Opponents
        <input type="number" inputmode="numeric" min="1" max="${MAX_BOTS}" value="${botCount}" data-botcount aria-label="Number of opponents">
      </label>
      <button class="big" data-action="start">Deal me in</button>
      <button class="ghost" data-action="online">Play with friends</button>
      </div>
      <details><summary>How to play</summary>
        <ul>
          <li>You get 13 cards. Draw one card, then discard one, every turn.</li>
          <li>Each level has an objective (like a set of 3 or a run of 4). Lay it down to complete the level for this hand.</li>
          <li>Sets are same rank. Runs are same suit and wrap around, with aces high and low (J-Q-K-A-2-3-4).</li>
          <li>Once your objective is down, play cards onto anyone's melds, or lay new melds (set of 3+, run of 4+).</li>
          <li>Empty your hand to go out. Everyone who laid down their objective that hand moves up a level.</li>
          <li>Ties are broken by hands won by going out, then by winning the final hand.</li>
        </ul>
      </details>
    </div>`;
}

function standingsTable(): string {
  const order = standings(game);
  const rows = order.map((p, i) => `<tr class="${p.id === HUMAN ? 'me' : ''}"><td>${i + 1}</td><td>${esc(p.name)}${p.id === game.lastHandWinner ? ' 🏁' : ''}</td>
    <td>${p.level >= game.levels.length ? 'Finished ★' : `${p.level + 1} / ${game.levels.length}`}</td><td>${p.handsWon}</td></tr>`).join('');
  return `<table><tr><th>#</th><th>Player</th><th>Level</th><th>Out</th></tr>${rows}</table>
    <p class="muted small-note">Ranked by level, then hands won by going out, then who won the latest hand. 🏁 = went out last hand.</p>`;
}

function overlayHtml(): string {
  if (game.status !== 'playing' && overlayKey !== `${game.handNumber}-${game.status}`) return '';
  if (game.status === 'playing' && oppDetail !== null) {
    const p = game.players[oppDetail];
    const melds = p.melds.map((m) => `<div class="meld big-meld">${m.cards.map((c) => cardHtml(c, 'mini', 'tabindex="-1"')).join('')}</div>`).join('');
    return `<div class="overlay" data-action="closeopp"><div class="panel"><h2>${esc(p.name)}</h2>
      <p class="muted">Level ${Math.min(p.level + 1, game.levels.length)}: ${reqText(game.requirementsFor(p))}${p.laidDown ? ' · ✔ laid down' : ''}<br>${p.hand.length} cards in hand · ${p.handsWon} hands won by going out</p>
      <div class="melds center">${melds || '<span class="hint">No melds yet</span>'}</div>
      <button class="big" data-action="closeopp">Close</button></div></div>`;
  }
  if (game.status === 'playing' && panel) {
    const me = game.players[HUMAN];
    const body = panel === 'levels'
      ? `<ol class="plist">${game.levels.map((lv, i) => `<li class="${i === me.level ? 'mine' : i < me.level ? 'past' : ''}"><span class="n">${lv.id}</span> ${reqText(lv.requirements)}<small>${game.players.filter((p) => p.level === i).map((p) => esc(p.name)).join(', ')}</small></li>`).join('')}</ol>`
      : `<div class="plog">${log.slice(0, 40).map((l) => `<div>${colorCards(esc(l))}</div>`).join('') || '<div>Nothing yet</div>'}</div>`;
    return `<div class="overlay" data-action="closepanel"><div class="panel"><h2>${panel === 'levels' ? 'All levels' : 'Moves'}</h2>${body}
      <button class="big" data-action="closepanel">Close</button></div></div>`;
  }
  if (game.status === 'playing') {
    return showBoard
      ? `<div class="overlay"><div class="panel"><h2>Leaderboard</h2>${standingsTable()}
          <button class="big" data-action="closeboard">Back to game</button></div></div>`
      : '';
  }
  const rows = game.players.map((p, i) => {
    const moved = p.level > handStartLevels[i];
    return `<tr><td>${esc(p.name)}${i === game.lastHandWinner ? ' 🏁' : ''}</td>
      <td>${Math.min(handStartLevels[i] + 1, game.levels.length)} → ${Math.min(p.level + 1, game.levels.length)}${p.level >= game.levels.length ? ' ★' : ''}</td>
      <td>${moved ? '<span class="up">Advanced</span>' : '<span class="stuck">Dammit!</span>'}</td><td>${p.handsWon}</td></tr>`;
  }).join('');
  const who = game.lastHandWinner === null ? 'Stalemate: nobody could go out' : `${esc(game.players[game.lastHandWinner].name)} went out`;
  if (game.status === 'gameOver') {
    const names = game.winners.map((w) => esc(game.players[w].name)).join(' & ');
    const youWon = game.winners.includes(HUMAN);
    return `<div class="overlay"><div class="panel"><h2>${youWon ? '🎉 You win!' : 'Game over'}</h2>
      <p>${game.winners.length > 1 ? 'Winners' : 'Winner'}: <b>${names}</b></p><p class="muted">${who}</p>
      <table><tr><th>Player</th><th>Level</th><th></th><th>Out</th></tr>${rows}</table>
      ${net ? (net.seats[HUMAN]?.host ? '<button class="big" data-action="netlobby">Back to lobby</button>' : '<p class="muted">Waiting for the host…</p>') + '<button class="ghost" data-action="quit">Leave</button>' : '<button class="big" data-action="quit">Play again</button>'}</div></div>`;
  }
  return `<div class="overlay"><div class="panel"><h2>Hand ${game.handNumber} over</h2><p>${who}</p>
    <table><tr><th>Player</th><th>Level</th><th></th><th>Out</th></tr>${rows}</table>
    <button class="big" data-action="next">Next hand</button></div></div>`;
}

// ---------- game flow ----------

function startGame() {
  window.clearTimeout(botTimer); window.clearTimeout(dealTimer); dealStep = -1; botSteps = null; announcedKey = ''; overlayKey = '';
  const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5).slice(0, botCount); // different bots each game
  game = new DammitGame([playerName.trim() || 'You', ...names]);
  selected.clear(); kept.clear(); lastDrawnId = null; handOrder = game.players[HUMAN].hand.map((c) => c.id); sortMode = 'custom'; message = ''; log = []; showBoard = false; oppDetail = null; panel = null;
  handStartLevels = game.players.map((p) => p.level);
  screen = 'game';
  runDeal();
}

/** Bots act one action at a time (draw, lay down, play on a meld, discard), paced by the speed slider. */
function scheduleBots() {
  window.clearTimeout(botTimer);
  if (net) return; // online: the server plays the bots
  if (screen !== 'game' || dealing() || game.status !== 'playing' || game.current === HUMAN) { botSteps = null; return; }
  botTimer = window.setTimeout(() => {
   try {
    botSteps ??= botTurnSteps(game);
    const before = meldCardIds();
    const step = botSteps.next();
    if (step.done) {
      botSteps = null;
      if (game.status === 'playing' && game.current === HUMAN) audio.sfx('turn');
    } else {
      pushLog([step.value]);
      if (/ played .* onto | laid down /.test(step.value)) flash([...meldCardIds()].filter((i) => !before.has(i)));
      const fx = sfxFor(step.value);
      if (fx) audio.sfx(fx);
    }
    render();
    scheduleBots();
   } catch (e) { showFatal(e); }
  }, delayFor(botSpeed));
}

function attempt(fn: () => void) {
  try {
    fn();
    message = '';
  } catch (e) {
    message = e instanceof RuleError ? e.message : String(e);
  }
  render();
  scheduleBots();
}

const wentOut = () => { selected.clear(); if (game.status !== 'playing') pushLog([`${myName()} went out!`]); };

function onAction(el: HTMLElement) {
  const a = el.dataset.action!;
  const me = game?.players[HUMAN];
  if (screen === 'online' || screen === 'lobby') return onlineAction(a, el);
  if (net && screen === 'game' && netAction(a, el)) return;
  switch (a) {
    case 'start': {
      const nm = app.querySelector<HTMLInputElement>('[data-pname]');
      if (nm) { playerName = nm.value.trim().slice(0, 16); store.set('playerName', playerName); }
      const box = app.querySelector<HTMLInputElement>('[data-botcount]');
      if (box) { botCount = clampBots(Number(box.value)); store.set('botCount', String(botCount)); }
      return startGame();
    }
    case 'quit': if (net) return leaveRoom(); window.clearTimeout(botTimer); botSteps = null; screen = 'setup'; showBoard = false; return render();
    case 'musicToggle': audio.setMusicOn(!audio.musicOn); return render();
    case 'sfxToggle': audio.setSfxOn(!audio.sfxOn); return render();
    case 'soundmenu': soundOpen = !soundOpen; return render();
    case 'sort': {
      const next: SortMode = sortMode === 'suit' ? 'rank' : sortMode === 'rank' ? 'custom' : 'suit';
      if (next === 'custom' && handOrder.length === 0) handOrder = sortedHand(me.hand).map((c) => c.id);
      sortMode = next; store.set('sortMode', sortMode);
      return render();
    }
    case 'fullscreen': {
      const d = document;
      (d.fullscreenElement ? d.exitFullscreen() : d.documentElement.requestFullscreen({ navigationUI: 'hide' })).catch(() => {});
      soundOpen = false;
      return render();
    }
    case 'online': screen = 'online'; onlineErr = ''; return render();
    case 'levels': levelsOpen = !levelsOpen; return render();
    case 'opp': oppDetail = Number(el.dataset.p); return render();
    case 'closeopp': oppDetail = null; return render();
    case 'panel-levels': panel = 'levels'; return render();
    case 'panel-log': panel = 'log'; return render();
    case 'closepanel': panel = null; return render();
    case 'moveleft': case 'moveright': {
      const id = [...selected][0];
      if (selected.size !== 1) return;
      const order = sortedHand(me.hand).map((c) => c.id);
      const i = order.indexOf(id), j = a === 'moveleft' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      handOrder = order; sortMode = 'custom'; store.set('sortMode', sortMode);
      return render();
    }
    case 'board': showBoard = true; return render();
    case 'closeboard': showBoard = false; return render();
    case 'clearkeep': kept.clear(); return render();
    case 'next':
      attempt(() => {
        game.nextHand(); selected.clear(); kept.clear(); lastDrawnId = null; handOrder = game.players[HUMAN].hand.map((c) => c.id); sortMode = 'custom'; dealStep = 0;
        handStartLevels = game.players.map((p) => p.level);
        pushLog([`Hand ${game.handNumber} dealt`]);
      });
      return runDeal();
    case 'select': {
      if (!isMyTurn()) return;
      const id = Number(el.dataset.id);
      selected.has(id) ? selected.delete(id) : selected.add(id);
      message = '';
      return render();
    }
    case 'keep': {
      const id = Number(el.dataset.id);
      kept.has(id) ? kept.delete(id) : kept.add(id);
      return render();
    }
    case 'draw-deck':
    case 'draw-discard':
      return attempt(() => {
        const c = game.draw(a === 'draw-deck' ? 'deck' : 'discard');
        if (c) {
          lastDrawnId = c.id;
          fadeDrawnHighlight(c.id);
          audio.sfx('draw');
          pushLog([`${myName()} drew ${cardLabel(c)} ${a === 'draw-deck' ? 'from the deck' : 'from the discard pile'}`]);
        } else {
          pushLog(['Stalemate: nobody can make progress']);
        }
      });
    case 'hint': {
      const groups = findObjective(me.hand, game.requirementsFor(me));
      if (!groups) { message = 'No objective available in your hand yet'; return render(); }
      selected = new Set(groups.flat()); message = ''; return render();
    }
    case 'objective':
      return attempt(() => {
        const groups = findObjective(selectedCards(), game.requirementsFor(me));
        if (!groups) throw new RuleError('Selected cards do not make your objective');
        const lvl = me.level + 1;
        game.layObjective(groups);
        flash(groups.flat());
        audio.sfx('lay');
        pushLog([`${myName()} laid down level ${lvl}`]);
        wentOut();
      });
    case 'meld':
      return attempt(() => { const ids = [...selected]; game.layMeld(ids); flash(ids); audio.sfx('lay'); pushLog([`${myName()} laid a new meld`]); wentOut(); });
    case 'discard':
      return attempt(() => {
        const c = me.hand.find((h) => h.id === [...selected][0])!;
        game.discard(c.id);
        audio.sfx('discard');
        lastDrawnId = null;
        pushLog([`${myName()} discarded ${cardLabel(c)}`]);
        wentOut();
      });
    case 'layon': {
      if (selected.size !== 1) { message = 'Select exactly one card to play on a meld'; return render(); }
      const ref: MeldRef = { player: Number(el.dataset.p), meld: Number(el.dataset.m) };
      return attempt(() => {
        const c = me.hand.find((h) => h.id === [...selected][0])!;
        game.layOn(c.id, ref);
        audio.sfx('tick');
        flash([c.id]);
        pushLog([`${myName()} played ${cardLabel(c)} onto ${game.players[ref.player].name}'s meld`]);
        wentOut();
      });
    }
    case 'playall':
      return attempt(() => {
        let count = 0;
        for (let progress = true; progress && game.status === 'playing';) {
          progress = false;
          for (const c of me.hand) {
            const ref = game.players.flatMap((p, pi) => p.melds.map((m, mi) => ({ pi, mi, m })))
              .find((t) => extendMeld(t.m, c) !== null);
            if (!ref) continue;
            game.layOn(c.id, { player: ref.pi, meld: ref.mi });
            flash([c.id]);
            pushLog([`${myName()} played ${cardLabel(c)} onto ${game.players[ref.pi].name}'s meld`]);
            window.setTimeout(() => audio.sfx('tick'), Math.min(count, 6) * 80);
            count++; progress = true;
            break;
          }
        }
        if (!count) throw new RuleError('No cards can be played on the melds right now');
        wentOut();
      });
  }
}

// ---------- online play (friends) ----------

let net: NetState | null = null;
let onlineErr = '';
let onlineBusy = false;
let prefillCode = '';
const netBar = document.createElement('div');
netBar.className = 'netbar';
netBar.hidden = true;
document.body.appendChild(netBar);
const updateNetBar = () => {
  const lost = !!net && !!net.code && !net.online && (screen === 'game' || screen === 'lobby');
  netBar.hidden = !lost;
  netBar.textContent = 'Connection lost — reconnecting…';
};

function openNet(n: NetState, first: ClientMsg, tries = 0) {
  n.ws = openSocket(n.url, {
    onOpen: () => { n.online = true; updateNetBar(); sendMsg(n.ws, first); },
    onMsg: (m) => { if (net === n) onNet(n, m); },
    onClose: () => {
      if (net !== n) return;
      n.online = false;
      if (!n.code) { net = null; onlineBusy = false; onlineErr = "Couldn't reach the server. Check the server address below."; render(); return; }
      if (screen === 'setup' && tries >= 3) { net = null; render(); return; } // gave up resuming on app start
      updateNetBar();
      window.setTimeout(() => { if (net === n && !n.online) openNet(n, { t: 'rejoin', code: n.code, token: n.token }, tries + 1); }, 2000);
    },
  });
}

function connect(first: ClientMsg) {
  const inp = app.querySelector<HTMLInputElement>('[data-server]');
  const url = normalizeUrl(inp?.value || defaultServerUrl());
  saveServerUrl(url);
  net = { ws: null, url, code: '', token: '', seat: 0, seats: [], inGame: false, online: false };
  onlineErr = ''; onlineBusy = true;
  render();
  openNet(net, first);
}

function resumeSession() {
  const s = loadSession();
  if (!s) return;
  net = { ws: null, url: s.url, code: s.code, token: s.token, seat: 0, seats: [], inGame: false, online: false };
  openNet(net, { t: 'rejoin', code: s.code, token: s.token });
}

function leaveRoom() {
  if (net) { sendMsg(net.ws, { t: 'leave' }); const ws = net.ws; net = null; window.setTimeout(() => ws?.close(), 300); }
  clearSession(); HUMAN = 0; screen = 'setup'; showBoard = false; updateNetBar(); render();
}

function onNet(n: NetState, m: ServerMsg) {
  switch (m.t) {
    case 'joined':
      n.code = m.code; n.token = m.token; n.seat = m.seat; HUMAN = m.seat; onlineBusy = false;
      saveSession({ url: n.url, code: m.code, token: m.token });
      return;
    case 'lobby':
      n.seats = m.seats; n.seat = m.seat; HUMAN = m.seat; n.inGame = false; onlineBusy = false;
      window.clearTimeout(dealTimer); dealStep = -1;
      screen = 'lobby'; updateNetBar(); return render();
    case 'state': return onNetState(n, m);
    case 'err':
      if (m.msg === 'That room has ended') { clearSession(); net = null; HUMAN = 0; screen = 'setup'; onlineErr = m.msg; return render(); }
      onlineBusy = false;
      if (screen === 'game') message = m.msg; else onlineErr = m.msg;
      return render();
  }
}

function onNetState(n: NetState, m: Extract<ServerMsg, { t: 'state' }>) {
  const prevHand = n.inGame ? game.handNumber : -1;
  const prevMine = n.inGame && game.status === 'playing' && game.current === HUMAN;
  game = mirrorGame(m.snap);
  HUMAN = m.seat; n.seat = m.seat; n.seats = m.seats; onlineBusy = false;
  screen = 'game'; updateNetBar();
  const first = !n.inGame;
  n.inGame = true;
  const mine = game.players[HUMAN];
  if (first || game.handNumber !== prevHand) {
    selected.clear(); kept.clear(); lastDrawnId = null; message = ''; showBoard = false; oppDetail = null; panel = null;
    handOrder = mine.hand.map((c) => c.id); sortMode = 'custom';
    handStartLevels = game.players.map((p) => p.level);
    if (first) log = [];
    pushLog(m.lines);
    if (m.resume) {
      window.clearTimeout(dealTimer); dealStep = -1;
      announcedKey = overlayKey = `${game.handNumber}-${game.status}`;
      return render();
    }
    announcedKey = ''; overlayKey = '';
    return runDeal();
  }
  pushLog(m.lines);
  m.lines.slice(0, 6).forEach((l, i) => { const fx = sfxFor(l); if (fx) window.setTimeout(() => audio.sfx(fx), i * 90); });
  flash(m.flash);
  if (m.drawn !== null) { lastDrawnId = m.drawn; fadeDrawnHighlight(m.drawn); }
  if (m.actor === HUMAN && !m.lines.length) { /* nothing */ }
  if (m.actor === HUMAN) selected.clear();
  if (!prevMine && !dealing() && game.status === 'playing' && game.current === HUMAN) audio.sfx('turn');
  render();
}

/** Game-screen actions in an online game: the server decides, we just ask. Returns true if handled. */
function netAction(a: string, el: HTMLElement): boolean {
  if (!net) return false;
  const me = game.players[HUMAN];
  const send = (m: ClientMsg) => { message = ''; sendMsg(net!.ws, m); };
  const say = (t: string) => { message = t; render(); };
  switch (a) {
    case 'next': send({ t: 'next' }); return true;
    case 'netlobby': send({ t: 'tolobby' }); return true;
    case 'draw-deck': case 'draw-discard':
      send({ t: 'act', a: 'draw', from: a === 'draw-deck' ? 'deck' : 'discard' }); return true;
    case 'objective': {
      const groups = findObjective(selectedCards(), game.requirementsFor(me));
      if (!groups) { say('Selected cards do not make your objective'); return true; }
      send({ t: 'act', a: 'objective', groups }); return true;
    }
    case 'meld':
      if (!selected.size) { say('Select the cards for a new meld'); return true; }
      send({ t: 'act', a: 'meld', ids: [...selected] }); return true;
    case 'discard':
      if (selected.size !== 1) { say('Select one card to discard'); return true; }
      send({ t: 'act', a: 'discard', id: [...selected][0] }); return true;
    case 'layon':
      if (selected.size !== 1) { say('Select exactly one card to play on a meld'); return true; }
      send({ t: 'act', a: 'layon', plays: [{ id: [...selected][0], player: Number(el.dataset.p), meld: Number(el.dataset.m) }] }); return true;
    case 'playall': {
      const melds = game.players.map((p) => p.melds.slice());
      const plays: { id: number; player: number; meld: number }[] = [];
      const left = me.hand.slice();
      for (let progress = true; progress;) {
        progress = false;
        for (let ci = 0; ci < left.length; ci++) {
          const c = left[ci];
          let hit: { pi: number; mi: number; ext: NonNullable<ReturnType<typeof extendMeld>> } | null = null;
          for (let pi = 0; pi < melds.length && !hit; pi++)
            for (let mi = 0; mi < melds[pi].length && !hit; mi++) {
              const ext = extendMeld(melds[pi][mi], c);
              if (ext) hit = { pi, mi, ext };
            }
          if (!hit) continue;
          melds[hit.pi][hit.mi] = hit.ext;
          plays.push({ id: c.id, player: hit.pi, meld: hit.mi });
          left.splice(ci, 1);
          progress = true;
          break;
        }
      }
      if (!plays.length) { say('No cards can be played on the melds right now'); return true; }
      send({ t: 'act', a: 'layon', plays }); return true;
    }
  }
  return false;
}

function onlineAction(a: string, el: HTMLElement) {
  const nameInput = app.querySelector<HTMLInputElement>('[data-pname]');
  if (nameInput) { playerName = nameInput.value.trim().slice(0, 16); store.set('playerName', playerName); }
  const name = playerName || 'Player';
  switch (a) {
    case 'backsetup': onlineErr = ''; screen = 'setup'; return render();
    case 'create': if (!onlineBusy) connect({ t: 'create', name }); return;
    case 'join': {
      const code = (app.querySelector<HTMLInputElement>('[data-code]')?.value ?? '').trim().toUpperCase();
      if (code.length !== 4) { onlineErr = 'Enter the 4-letter room code'; return render(); }
      if (!onlineBusy) connect({ t: 'join', code, name });
      return;
    }
    case 'addbot': return sendMsg(net?.ws ?? null, { t: 'addbot' });
    case 'removebot': return sendMsg(net?.ws ?? null, { t: 'removebot', seat: Number(el.dataset.seat) });
    case 'netstart': return sendMsg(net?.ws ?? null, { t: 'start' });
    case 'quit': return leaveRoom();
    case 'invite': {
      const url = `${location.origin}${location.pathname}?room=${net?.code}`;
      const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> };
      if (nav.share) nav.share({ title: 'Dammit', text: `Join my Dammit game! Room code ${net?.code}`, url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => { onlineErr = 'Invite link copied'; render(); }).catch(() => {});
      return;
    }
  }
}

function renderOnline() {
  app.innerHTML = `
    <div class="setup">
      <div class="s-left"><h1>Dammit</h1><p class="muted">Play with friends. One person creates a room, everyone else joins with its code. Empty seats can be filled with bots.</p></div>
      <div class="s-right">
        <label class="opp-count">Your name
          <input type="text" maxlength="16" value="${esc(playerName)}" placeholder="Player" data-pname aria-label="Your name">
        </label>
        <button class="big" data-action="create" ${onlineBusy ? 'disabled' : ''}>Create a room</button>
        <label class="opp-count">Room code
          <input type="text" class="codebox" maxlength="4" value="${esc(prefillCode)}" placeholder="ABCD" data-code autocapitalize="characters" aria-label="Room code">
        </label>
        <button class="big" data-action="join" ${onlineBusy ? 'disabled' : ''}>${onlineBusy ? 'Connecting…' : 'Join room'}</button>
        ${onlineErr ? `<p class="neterr">${esc(onlineErr)}</p>` : ''}
        <button class="ghost small" data-action="backsetup">Back</button>
        <details><summary>Server address</summary>
          <input type="text" data-server value="${esc(defaultServerUrl())}" aria-label="Server address" autocapitalize="off" spellcheck="false">
        </details>
      </div>
    </div>`;
}

function renderLobby() {
  const n = net!;
  const host = n.seats[n.seat]?.host;
  const rows = n.seats.map((s, i) => `<li class="${i === n.seat ? 'me' : ''}">
      <span>${esc(s.name)}${i === n.seat ? ' (you)' : ''}${s.host ? ' ★' : ''}${s.bot ? ' <small class="muted">bot</small>' : ''}${!s.connected ? ' <small class="muted">offline</small>' : ''}</span>
      ${host && s.bot ? `<button class="ghost small" data-action="removebot" data-seat="${i}" aria-label="Remove ${esc(s.name)}">✕</button>` : ''}</li>`).join('');
  app.innerHTML = `
    <div class="setup">
      <div class="s-left"><h1>Room</h1><div class="roomcode" aria-label="Room code">${esc(n.code)}</div>
        <p class="muted">Friends join with this code.</p>
        <button class="ghost small" data-action="invite">Share invite link</button>${onlineErr ? `<p class="neterr">${esc(onlineErr)}</p>` : ''}</div>
      <div class="s-right">
        <ul class="seatlist">${rows}</ul>
        ${host ? `<button class="ghost" data-action="addbot" ${n.seats.length >= 10 ? 'disabled' : ''}>＋ Add a bot</button>
          <button class="big" data-action="netstart" ${n.seats.length < 2 ? 'disabled' : ''}>Start game</button>`
          : '<p class="muted">Waiting for the host to start…</p>'}
        <button class="ghost small" data-action="quit">Leave room</button>
      </div>
    </div>`;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && net && net.code && !net.online) openNet(net, { t: 'rejoin', code: net.code, token: net.token });
});

{
  const q = new URLSearchParams(location.search).get('room');
  if (q) { prefillCode = q.toUpperCase().slice(0, 4); screen = 'online'; history.replaceState(null, '', location.pathname); }
}

// Browsers only allow audio after a user gesture.
window.addEventListener('pointerdown', () => audio.unlock(), { passive: true });

document.addEventListener('click', (ev) => {
  if (soundOpen && !(ev.target as HTMLElement).closest('.soundwrap')) { soundOpen = false; render(); }
});

app.addEventListener('click', (ev) => {
  if (suppressClick) return;
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (el?.classList.contains('overlay') && ev.target !== el) return; // clicks inside a popup don't dismiss it
  if (el && !(el as HTMLButtonElement).disabled) onAction(el);
});

app.addEventListener('input', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset.vol) {
    const v = Number(t.value) / 100;
    if (t.dataset.vol === 'music') audio.setMusicVol(v); else audio.setSfxVol(v);
    return;
  }
  if (t.hasAttribute('data-botcount')) {
    // Typing is free-form; the value is clamped when it's committed (blur/Enter) or the game starts.
    const n = Number(t.value);
    if (n >= 1) botCount = clampBots(n);
    return;
  }
  if (t.hasAttribute('data-speed')) {
    // Update in place (no full re-render) so dragging the slider isn't interrupted.
    botSpeed = Number(t.value);
    store.set('botSpeed', String(botSpeed));
    const label = app.querySelector('[data-speed-label]');
    if (label) label.textContent = speedLabel();
  }
});

app.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset.vol === 'sfx') audio.sfx('draw'); // preview the new effects volume
  if (t.hasAttribute('data-botcount')) {
    botCount = clampBots(Number(t.value));
    t.value = String(botCount);
    store.set('botCount', String(botCount));
    return;
  }
  const key = t.dataset.toggle;
  if (key === 'showMelds') { showMelds = t.checked; store.set(key, t.checked ? '1' : '0'); render(); }
  if (key === 'showPlayable') { showPlayable = t.checked; store.set(key, t.checked ? '1' : '0'); render(); }
});

// ---------- drag to reorder the hand (mouse, pen and touch: drag straight away) ----------

let drag: { el: HTMLElement; startX: number; startY: number; grabX: number; grabY: number; active: boolean; touch: boolean; timer: number; lastX: number; lastY: number } | null = null;

/** Picks the card up: settles any slide animation, measures where it was grabbed, and lifts it. */
function activateDrag(d: NonNullable<typeof drag>) {
  d.active = true;
  d.el.getAnimations().forEach((a) => a.cancel());
  const r = d.el.getBoundingClientRect();
  d.grabX = d.startX - r.left;
  d.grabY = d.startY - r.top;
  d.el.classList.add('dragging');
  if (d.touch && navigator.vibrate) navigator.vibrate(12);
}

app.addEventListener('pointerdown', (ev) => {
  const t = ev.target as HTMLElement;
  const hc = t.closest<HTMLElement>('.hand .hc');
  if (!hc || t.closest('.star') || ev.button > 0) return;
  const touch = ev.pointerType === 'touch';
  const d = { el: hc, startX: ev.clientX, startY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, grabX: 0, grabY: 0, active: false, touch, timer: 0 };
  drag = d;
});

function moveDrag(d: NonNullable<typeof drag>, x: number, y: number) {
  const ev = { clientX: x, clientY: y };
  const container = d.el.parentElement!;
  const others = Array.from(container.querySelectorAll<HTMLElement>('.hc')).filter((x) => x !== d.el);
  // Where does the pointer sit among the other cards? (offset* ignores in-flight slide animations)
  const px = ev.clientX - container.getBoundingClientRect().left + container.scrollLeft;
  const want = others.filter((o) => o.offsetLeft + o.offsetWidth / 2 < px).length;
  const all = Array.from(container.querySelectorAll<HTMLElement>('.hc'));
  if (all.indexOf(d.el) !== want) {
    const before = new Map(others.map((o) => [o, o.getBoundingClientRect()]));
    container.insertBefore(d.el, others[want] ?? null);
    for (const o of others) {
      const b = before.get(o)!, n = o.getBoundingClientRect();
      const dx = b.left - n.left;
      if (Math.abs(dx) >= 1) o.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: SLIDE_EASE });
    }
  }
  // The dragged card follows the pointer.
  d.el.style.transform = 'none';
  const nat = d.el.getBoundingClientRect();
  d.el.style.transform = `translate(${ev.clientX - d.grabX - nat.left}px, ${ev.clientY - d.grabY - nat.top}px)`;
}

window.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const d = drag;
  d.lastX = ev.clientX; d.lastY = ev.clientY;
  if (!d.active) {
    if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < (d.touch ? 6 : 8)) return; // small movement = still a tap
    activateDrag(d);
  }
  ev.preventDefault();
  moveDrag(d, ev.clientX, ev.clientY);
}, { passive: false });

const endDrag = () => {
  if (!drag) return;
  const d = drag;
  window.clearTimeout(d.timer);
  drag = null;
  if (!d.active) return;
  handOrder = Array.from(d.el.parentElement!.querySelectorAll<HTMLElement>('.hc')).map((x) => Number(x.dataset.id));
  sortMode = 'custom';
  store.set('sortMode', sortMode);
  suppressClick = true;
  window.setTimeout(() => { suppressClick = false; }, 0);
  render(); // the dropped card glides from where it was released into its slot
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

let resizeTimer = 0;
document.addEventListener('fullscreenchange', () => { if (screen === 'game') render(); });
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { if (screen === 'game') render(); }, 150);
});
document.addEventListener('contextmenu', (e) => { if ((e.target as HTMLElement).closest?.('.hand')) e.preventDefault(); });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

if (new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__dammit = { game: () => game, render };
render();
if (screen === 'setup') resumeSession();
