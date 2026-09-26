# Contributing

Thanks for helping. consentprobe measures what websites do with consent, and a wrong finding about a real company is the worst thing it can produce. That shapes how changes are made.

## Before you start

- Read `AGENTS.md`: rules, layout, design decisions and the lessons learned from real sites.
- For anything larger than a small fix, open an issue first and describe the problem with a local test page, not with a real site's name.

## Development

```bash
pnpm install
node dist/cli.js --install-browser
pnpm typecheck
pnpm test      # unit tests and real-browser tests against local fixtures
pnpm build
```

Node 22+ and pnpm 11. `pnpm install` also builds `dist/`.

## What a pull request needs

- `pnpm typecheck`, `pnpm test` and `pnpm build` pass.
- New detection logic comes with a unit test and, where a browser is involved, a local fixture in `src/fixtures.ts` with an integration test.
- A mutation check for every new guard: break the guard on purpose and confirm a test fails. Say in the pull request that you did it.
- Precision before recall: when in doubt, report "not found" or an info finding. Never guess which button to click.
- Findings stay neutral ("contacted", "present", "not found"). No legal conclusions in code, messages or docs.
- No new runtime dependency without discussing size, maintenance and license first. Tracker data under CC BY-NC-SA or GPL cannot be bundled.
- README and `AGENTS.md` are updated when behavior changes.

## Real websites

Do not name real websites or companies in code, tests, commits, issues or pull requests, and do not post their scan results. If a change was checked against real sites, describe the kind of site ("a large retail site"), not the site.
