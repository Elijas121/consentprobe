# AGENTS.md — consentprobe

Read this file first. It is the single hand-over document for any AI agent or human working on this repository.

## What this project is

`consentprobe` is a Node/TypeScript CLI (plus library and agent skill) that loads a website in Playwright three times, each with a fresh cookie jar (baseline, reject click, accept click), and reports technical privacy findings with evidence. It gives **no legal advice**.

Maintainer: Elias Delil. Code, comments, commits and docs are in English.

Prior art and the tracker-data license decisions: `docs/RESEARCH.md`. How accuracy was measured: `docs/VALIDATION.md`.

## Non-negotiable rules

1. **Precision beats recall.** A false accusation about a real company is the worst failure. When unsure, report "not found" or an info finding. Never guess which button to click.
2. **Every heuristic needs a test and a real-site check.** Real sites found six false alarms that unit tests did not (see "Lessons"). After any change to detection, run the real-site regression (see "Commands").
3. **Do a mutation check for new guards:** temporarily break the guard and confirm a test turns red.
4. **No legal conclusions in output.** Findings are measurements. Wording stays neutral ("contacted", "present", "not found").
5. **Do not publish scan results of real, named companies.** Not in the repo, not in issues or pull requests. Use local fixtures or sites you own for examples.
6. **Ask the user before anything outward-facing:** `git push`, tags and releases, `npm publish`, contacting anyone, scanning a site the user does not own or have permission to test.
7. **Ask before adding a dependency,** with size, maintenance and license. Current runtime deps: `playwright`, `tldts`.
8. **Never bundle CC BY-NC-SA or GPL data** (DuckDuckGo Tracker Radar, Disconnect, Ghostery TrackerDB are CC BY-NC-SA 4.0, verified from their LICENSE files). WhoTracks.me code is MIT but no license for its data was found, so it is unused.
9. Secrets never in the repo. Feature branches, small commits in English imperative mood, never work directly on `main`.

## Layout

```
src/
  cli.ts        argument parsing, exit codes (0 ok, 1 findings, 2 error)
  scan.ts       orchestration: baseline + reject + accept visits in parallel; PageNotMeasurableError
  consent.ts    banner detection (CMP selectors + strict whole-label text match + overlay check), clicking
  navigate.ts   navigation (HTML first, bounded wait for the rest) and one-line navigation errors
  bounded.ts    time limits for page queries: bounded(), ask(), dead-frame skipping
  findings.ts   pure functions: requests/cookies/legal/consent -> findings; classification helpers
  classify.ts   registrable domain (tldts), third-party test, rule matching (host suffix + path segment)
  rules.ts      curated tracker rules, category severities, tracker/consent cookie patterns
  legal.ts      imprint/privacy link selection by score (needs >= 2 signals)
  report.ts     text and markdown formatters
  types.ts      all shared types
  index.ts      library exports
  version.ts    version string
test/
  fixtures.ts   local servers (first party on "localhost", third party on "127.0.0.1") and fake banners
  unit.test.ts  pure logic
  scan.test.ts  baseline with a real browser
  consent.test.ts  click test with a real browser
scripts/scan-list.sh  scan a list of URLs in parallel for regression checks
skills/consentprobe/SKILL.md  agent skill
action.yml      composite GitHub Action (smoke-tested in CI)
docs/RESEARCH.md    prior art and tracker-data licenses
docs/VALIDATION.md  validation method, numbers and limits
```

## Commands

```bash
pnpm install
pnpm exec playwright install chromium   # once
pnpm typecheck
pnpm test                               # 72 tests, ~100 s, real browser
pnpm build
node dist/cli.js <url> --screenshots ../cp-runs/evidence
scripts/scan-list.sh ../cp-runs/urls.txt ../cp-runs/out   # real-site regression, then read ../cp-runs/out/*.json
```

Keep URL lists, reports and screenshots of real sites outside the repository (as above). They name real sites and must never be committed; `.gitignore` catches the common output names as a safety net.

Node versions: the tool runs on Node 20+, but pnpm 11 needs Node 22+ (`node:sqlite`). CI therefore installs with Node 22 and runs tests with the matrix version by calling `node node_modules/...` directly. This was found by the first real CI run.

pnpm trap: a `pnpm-workspace.yaml` in a parent directory makes pnpm treat this repo as part of that workspace. This repo has its own `pnpm-workspace.yaml` so pnpm does not walk up. Keep it.

## Design decisions (and why)

- **Three isolated visits in parallel.** Separate cookie jars so accept cannot contaminate reject.
- **Exact click moment.** An init script in every frame reports the physical `pointerdown`/`mousedown` through a binding; only requests after that moment count as "after reject". A marker taken in Node right before `click()` was not enough: the heartbeat test fails 3/3 with it, because Playwright's click takes tens of milliseconds.
- **Cookies after reject = new or changed only.** Cookies are compared (name, domain, value hash) with a snapshot right before the click. Unchanged tracker cookies from before the click are info ("not removed"); the before-consent findings already cover them.
- **Google Consent Mode is shown, not guessed.** The only query parameter kept is a validated `gcs` value. `G100` pings after reject are a separate warning with the signal as evidence; a "granted" signal before or after reject is called out explicitly.
- **Nothing may wait forever.** Every page query goes through `ask()` (3 s limit, errors always handled, a thunk so nothing is sent to a dead frame). A frame that timed out once is skipped for the rest of the visit. Navigation waits for the HTML plus a bounded time for the rest. The whole scan has a hard deadline, and `browser.close()` is bounded too.
- **Incomplete is not "no banner".** If any page query timed out and no banner was found, the result is "search incomplete". A visible cookie overlay without automatable controls is "not automatable". Only a clean search may say "not recognized".
- **Strict labels.** Only labels that match a general reject/accept as a whole are clicked. A reject-like label for a single service (e.g. "für Partner X jetzt ablehnen") is reported, not clicked. Reason: clicking it produced a false finding on a real site.
- **Overlay requirement.** Text-matched controls must sit in a fixed/sticky ancestor, a dialog, or an overlay iframe (cross-origin CMP iframes such as Sourcepoint are handled through `frameElement`).
- **Legal links by score.** Label 3 + path 2 + footer 3, minimum 5. A first-keyword-hit picker chose an article teaser on a real site.
- **Error pages are not measured** (HTTP >= 400 throws `PageNotMeasurableError`). Otherwise a 403 page produced "no imprint" errors.
- **Unverifiable is not an error.** A link check that gets no response is info.
- **Tag manager = warn.** Consent Mode can block tags; analytics and advertising findings carry the real weight.
- **Imprint only for German-looking sites** (`lang="de"` or .de/.at/.ch), otherwise info.
- **Query strings are stripped** from recorded URLs.

## Lessons from real-site scans (do not repeat these mistakes)

| Symptom | Cause | Fix |
|---|---|---|
| Wrong button clicked on a real site | substring match on "ablehnen" | strict whole-label patterns |
| "No imprint" on a real site | HTTP 403 page measured | refuse to measure error pages |
| Article link taken as privacy policy on a real site | first keyword hit | scored selection, >= 2 signals |
| Banner missed inside a cross-origin CMP iframe | its accept wording was not in the patterns | added wording; verified in iframe |
| Accept missed on a real site | pattern `akzeptieren` does not match `akzeptiere` | pattern `akzeptier` |
| Consent platform scripts shown as unknown | not in rules | category `consent-platform` (info) |
| Reject "Nur essenzielle" missed on a real site | the accessible-name pre-filter did not contain `essenziell` or `stimme zu` | shared `CANDIDATE_LABEL` plus an invariant test: every label the strict patterns accept must pass the pre-filter |
| Imprint "missing" on a Jimdo site | label "Impressum" linked to `/about/`, no footer element | exact standard label counts alone; footer also by id/class or bottom quarter |
| `__cmpcc` / `__cf_bm` reported as third-party cookies | consent-platform and Cloudflare cookies | `consentmanager` consent pattern, `INFRA_COOKIE_PATTERNS` (info) |
| "Alles akzeptieren" missed | pattern had `alle` only | `alles?` |
| "No banner" on a site with a checkbox-and-save overlay | no automatable control | `overlayHint`: report "not automatable" instead of "no banner" |
| GA "request after reject" (error) on a real site | request carried `gcs=G100`, a Consent Mode denied ping | keep validated `gcs`, separate warning |
| `_ga` "after reject" (error) | cookie set before the click, unchanged | compare with a pre-click snapshot |
| HubSpot pixel after reject rated only "warn" | `track-eu1.hubspot.com` was in the chat rule | separate `hubspot-tracking` rule (analytics). First verified real "tracking after reject" case (screenshot-checked) |
| A blind sample of 26 sites: 5 misses, 0 wrong clicks | "Alles ablehnen", "Ja, ich stimme zu und akzeptiere alle", "Accept & close", Shopify's renamed buttons, 30 px notice bar | patterns, Shopify element ids, lower overlay height; newsletter "No thanks" guarded by a test |
| One whole scan failed on a slow resource | waited for the `load` event | wait for HTML, bound the rest |
| **Scan hung for 20+ minutes on two real sites (reproducible)** | an iframe whose server never answers: Playwright's `isVisible()`/`count()` on that frame never return | `ask()` time limits, dead-frame skipping, hard deadline; now 10-12 s with "search incomplete" |
| Unhandled rejections after a deadline | the query promise was created before the dead-frame check | `ask()` takes a thunk and always attaches error handling |
| Requests during the screenshot counted as "after reject" | marker set before the slow screenshot | exact press marker (see design decisions) |

Methods lesson: a ground truth from one neutral screenshot can be wrong. Two sample-3 disagreements were the tool being right (a banner that appeared after the screenshot; a banner hidden behind a location popup). Always check the click screenshots before blaming the tool, and report such corrections openly.

A theory that turned out wrong: a banner dialog looked like a marketing mock-up, but `--screenshots` showed it is real. Always look at the evidence screenshot before deciding a detection is wrong.

## Current status (2026-09-25)

- Core scanner, click test, evidence screenshots, first-party option, imprint mode: done and tested (72 tests, ~100 s, zero unhandled rejections). The suite passes on Node 20, 22 and 26; the packed tarball installs and runs from a clean folder.
- Verified on real sites (names kept out of the repo on purpose): a OneTrust shop where reject works with no findings; several sites without a general reject on the first layer; a site that blocks headless browsers; the sites of seven consent vendors detected.
- **Validation:** 71 real sites in three samples, two of them judged blind, each scanned three times. See `docs/VALIDATION.md` for method, numbers and limits. Raw results with site names are kept out of the repo.
- **Tracking after reject is verified on real sites:** three screenshot-checked cases (a HubSpot click pixel; Microsoft Clarity sending data after reject; Clarity loaded only after "Decline"). No site names in the repo.
- GitHub: public repo `Elijas121/consentprobe`. CI runs the tests on Node 20 and 22; `action-smoke` runs the composite action against https://example.com.
- Not done: npm publish, demo GIF.

## Next steps

1. Demo GIF from a local fixture (never a real site), then npm publish.
2. A third-party review of the validation (someone other than the person who tuned the heuristics).
3. Second banner layers ("Settings"), EU geolocation option.

## Definition of done for any change

- `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- New detection logic: unit test, integration test with a fixture, mutation check, real-site regression looked at.
- README and this file updated if behavior or decisions changed.
