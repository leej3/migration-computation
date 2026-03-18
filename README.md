# Migration Computation

Migration Computation is a small personal planning tool for thinking through the financial side of a move from Ireland to the United States.

It focuses on a few linked questions:

- when a house sale closes
- how and when EUR proceeds move into USD
- what debt carry costs while you wait
- how much liquidity to preserve on both sides of the Atlantic

The app is static and browser-only. It does not use a backend. Inputs are stored in browser local storage so personal numbers do not need to be committed into the codebase.

## Running locally

Requirements:

- Node.js 20+
- npm

Commands:

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run lint
npm run test:unit
npm run test:e2e
npm run build
```

## Deployment

The project is set up for Cloudflare Pages with GitHub Actions.

- Pull requests deploy preview builds.
- Pushes to `main` deploy production.
- The workflow expects a Cloudflare Pages project named `migration-computation`.
- The repository secret `CF_API_KEY` must be set with permission to deploy to Pages.

## Notes

- Demo values in the app are illustrative only.
- The live FX panel is optional context, not a dependency for the core calculations.
- This is a planning aid, not financial advice.
