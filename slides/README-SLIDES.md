# Slides (a PPTist fork for Mail Workspace)

This is [PPTist](https://github.com/pipipi-pikachu/PPTist) (AGPL-3.0, © 2020-present pipipi-pikachu)
adapted to run as the Slides space of Mail Workspace (this repository). It is based on upstream
commit 04e06cb of https://github.com/pipipi-pikachu/PPTist and keeps that project's AGPL-3.0 licence (LICENSE here).

What changed:
- English interface (`scripts/i18n-extract.mjs`, `scripts/i18n/en.json`); Chinese code comments remain.
- No server features: AI PPT, AI writing via pptist.cn, the online image library, the mobile view.
- Formulas are rendered by MathJax (`src/utils/latex.ts`), filled glyph outlines in one path.
- Chrome colours are CSS variables (`src/assets/styles/theme.css`), light and dark; a host can override them.
- `src/bridge/`: `window.pptist`, the API a hosting page uses (deck in/out, change events, selection,
  slide pictures, named editor actions, hooks for saving exports, agent rewrites and "Discuss in chat").
- Fixed build names: `npm run build-only` writes `dist/app.js` and `dist/app.css`.

Build: `npm ci && npm run build-only` here, then `node scripts/vendor.mjs` at the repository root copies
`dist/` into the add-on. `npx vite` runs it alone with a blank deck.
