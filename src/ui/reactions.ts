/** Emoji reactions for online games. Lives outside the game screens so re-renders never disturb it. */
import { REACTIONS } from '../net/protocol';

export function initReactions(opts: { app: HTMLElement; active: () => boolean; send: (e: string) => void }) {
  const layer = document.createElement('div');
  layer.className = 'react-layer';
  layer.innerHTML = `<div class="react-pop" hidden>${REACTIONS.map((e) => `<button type="button" data-react="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
    <button type="button" class="react-btn" aria-label="Reactions" hidden>😀</button><div class="react-float"></div>`;
  document.body.appendChild(layer);
  const btn = layer.querySelector<HTMLButtonElement>('.react-btn')!;
  const pop = layer.querySelector<HTMLElement>('.react-pop')!;
  const float = layer.querySelector<HTMLElement>('.react-float')!;

  const sync = () => {
    const on = opts.active();
    btn.hidden = !on;
    if (!on) pop.hidden = true;
  };
  new MutationObserver(sync).observe(opts.app, { childList: true });
  sync();

  btn.addEventListener('click', () => { pop.hidden = !pop.hidden; });
  pop.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-react]');
    if (!b) return;
    opts.send(b.dataset.react!);
    pop.hidden = true;
  });

  return {
    sync,
    show(name: string, emoji: string) {
      if (!REACTIONS.includes(emoji)) return;
      const el = document.createElement('div');
      el.className = 'react-bubble';
      el.style.left = `${12 + Math.random() * 66}%`;
      const who = document.createElement('small');
      who.textContent = name;
      el.append(emoji, who);
      float.appendChild(el);
      window.setTimeout(() => el.remove(), 3200);
    },
  };
}
