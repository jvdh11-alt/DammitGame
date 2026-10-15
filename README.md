# Dammit

A 10-level rummy-style card game. Web-first (PWA), TypeScript, no runtime dependencies.

## Run it
```
npm install
npm run dev      # play at http://localhost:5173
npm test         # rules engine + bot simulations
npm run build    # static site in dist/ (host anywhere; installable on phones)
```

## Layout
- `src/engine/` pure rules engine (no UI): cards, melds, levels (edit `levels.ts` for the real goals), game, bot
- `src/ui/` web UI (vanilla TS + CSS)
- `public/` PWA manifest, service worker, icon
- `tests/` unit tests and full bot-vs-bot game simulations

## Rules
See the project doc `dammit-rules-draft.md` in the Claude project "Things to build".
