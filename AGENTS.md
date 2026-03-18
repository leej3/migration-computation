# AGENTS.md

## Project Overview

This repository contains a static financial planning dashboard built with Vite, TypeScript, and browser APIs only.

The purpose is to compare house-sale timing, transfer strategies, debt carry, and liquidity trade-offs during an international move.

## Non-Negotiable Constraints

- Keep the app static. Do not add a backend, database, auth layer, or server-side storage.
- Keep personal values out of the source tree. Use generic demo defaults only.
- Persist user-entered data in browser local storage.
- Preserve backwards compatibility for stored profiles when adding new fields. Missing values should fall back to defaults.
- Treat the live FX fetch as optional context. The app must still work if that request fails.
- Keep the Cloudflare Pages deployment workflow intact unless there is a clear deployment bug.

## Architecture

- `src/app.ts`: UI rendering, event wiring, chart mounting, profile management.
- `src/lib/finance.ts`: scenario engine and month-by-month simulation.
- `src/lib/storage.ts`: local-storage persistence, import/export, default merging.
- `src/lib/defaults.ts`: generic demo values and source links.
- `src/lib/market.ts`: optional live FX lookup.
- `.github/workflows/deploy.yml`: Cloudflare Pages deployment via GitHub Actions.

## Development Guidance

- Prefer small, explicit functions over framework-heavy abstractions.
- Keep the UI desktop-first, but do not break basic mobile usability.
- Use plain language in the interface and docs.
- When changing the model, update the assumptions text if user-facing behavior changes.
- When changing storage shape, make sure old saved profiles still load.

## Verification

Run these after meaningful changes:

```bash
npm run lint
npm run test:unit
npm run test:e2e
npm run build
```

For UI changes, prefer checking the real app in Playwright rather than relying only on unit tests.
