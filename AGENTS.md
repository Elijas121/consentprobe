# AGENTS.md for consentprobe

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
  identity.ts   how visits present themselves (regular Chromium instead of HeadlessChrome)
  input.ts      CLI input: URL normalization, millisecond options, --rules validation
  findings.ts   pure functions: requests/cookies/legal/consent -> findings; classification helpers
  classify.ts   registrable domain (tldts), third-party test, rule matching (host suffix + path segment)
  rules.ts      curated tracker rules, category severities, tracker/consent cookie patterns
  legal.ts      imprint/privacy link selection by score (needs >= 2 signals)
  report.ts     text and markdown formatters
  types.ts      all shared types
  index.ts      library exports
  version.ts    version string
  fixtures.ts   local test servers and fake banners (used by tests and `pnpm demo`; excluded from the npm package)
  demo.ts       `pnpm demo`: runs the CLI against the local fixture whose banner ignores reject
test/
  fixtures.ts   re-exports src/fixtures.ts (first party on "localhost", third party on "127.0.0.1")
  unit.test.ts  pure logic
  findings.test.ts, input.test.ts, labels.test.ts  pure logic added later (kept separate to avoid merge conflicts)
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
pnpm test                               # 109 tests, about two minutes, real browser
pnpm build
node dist/cli.js <url> --screenshots ../cp-runs/evidence
scripts/scan-list.sh ../cp-runs/urls.txt ../cp-runs/out   # real-site regression, then read ../cp-runs/out/*.json
```

Keep URL lists, reports and screenshots of real sites outside the repository (as above). They name real sites and must never be committed; `.gitignore` catches the common output names as a safety net.

Node versions: the tool runs on Node 20+, but pnpm 11 needs Node 22+ (`node:sqlite`). CI therefore installs with Node 22 and runs tests with the matrix version by calling `node node_modules/...` directly. This was found by the first real CI run.

pnpm trap: a `pnpm-workspace.yaml` in a parent directory makes pnpm treat this repo as part of that workspace. This repo has its own `pnpm-workspace.yaml` so pnpm does not walk up. Keep it.

## Design decisions (and why)

- **Three isolated visits in parallel.** Separate cookie jars so accept cannot contaminate reject. If only one click visit sees the banner, the other is repeated once with twice the banner wait; a click that stays untested is reported (info).
- **Regular browser identity.** Headless Chromium says "HeadlessChrome" in its user agent and client hints, and several large sites then hide the banner and load tracking at once. Every visit presents itself like the same Chromium in a normal window (`identity.ts`, set per page through CDP, which also covers cross-origin frames). `navigator.webdriver` stays true and HTTP 403 is still refused: the goal is the page a visitor sees, not hiding.
- **Plain controls.** After the role search (button, link), plain clickable elements inside an overlay are searched too (`<a>` without href, `onclick`, `tabindex`, `cursor: pointer`). The same strict whole-label rules decide; plain text is never clicked.
- **Consent walls.** A redirect to a separate consent page (host `consent.*` or a path such as `/consent-management/`) is reported as info; legal links are not judged on that page.
- **Exact click moment.** An init script in every frame reports the physical `pointerdown`/`mousedown` through a binding; only requests after that moment count as "after reject". A marker taken in Node right before `click()` was not enough: the heartbeat test fails 3/3 with it, because Playwright's click takes tens of milliseconds.
- **Cookies after reject = new or changed only.** Cookies are compared (name, domain, value hash) with a snapshot right before the click. Unchanged tracker cookies from before the click are info ("not removed"); the before-consent findings already cover them.
- **Google Consent Mode is shown, not guessed.** The only query parameter kept is a validated `gcs` value. `G100` pings before consent and after reject are a separate warning with the signal as evidence; a "granted" signal before or after reject is called out explicitly.
- **Nothing may wait forever.** Every page query goes through `ask()` (3 s limit, errors always handled, a thunk so nothing is sent to a dead frame). A frame that timed out once is skipped for the rest of the visit. Navigation waits for the HTML plus a bounded time for the rest. The whole scan has a hard deadline, and `browser.close()` is bounded too.
- **Incomplete is not "no banner".** If any page query timed out and no banner was found, the result is "search incomplete". A visible cookie overlay without automatable controls is "not automatable". Only a clean search may say "not recognized".
- **Strict labels.** Only labels that match a general reject/accept as a whole are clicked. A reject-like label for a single service (e.g. "für Partner X jetzt ablehnen") is reported, not clicked. Reason: clicking it produced a false finding on a real site.
- **Overlay requirement.** Text-matched controls must sit in a fixed/sticky ancestor, a dialog, or an overlay iframe (cross-origin CMP iframes such as Sourcepoint are handled through `frameElement`).
- **Legal links by score.** Label 3 + path 2 + footer 3, minimum 5. A first-keyword-hit picker chose an article teaser on a real site.
- **Error pages are not measured** (HTTP >= 400 throws `PageNotMeasurableError`). Otherwise a 403 page produced "no imprint" errors.
- **Unverifiable is not an error.** A link check that gets no response is info.
- **Tag manager = warn.** Consent Mode can block tags; analytics and advertising findings carry the real weight.
- **German rules only for German-looking sites** (`lang="de"` or .de/.at/.ch, or `--imprint always`): there a missing imprint or privacy link is an error. Elsewhere the imprint check is skipped (info) and a missing privacy link is a warning.
- **Legal link text.** `innerText`, or `textContent` when the link has a box but renders lazily (content-visibility). A link without a box keeps no label and ends up "uncertain".
- **Legal items without href.** Only when no real link matches: a visible, clickable element (onclick, tabindex, link or button role, `cursor: pointer`) whose whole text is the standard wording ("Impressum", "Datenschutz", …) counts as found. Its target cannot be checked, which is reported as info. Plain text that cannot be clicked never counts.
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
| **Ten false errors on a large site; banners missing on several** | the site hid its banner from "HeadlessChrome" and loaded tracking only for it | regular browser identity (user agent and client hints) |
| Banner missed although visible | its controls were links without `href` (no button or link role) | plain-control search inside overlays |
| "Geht klar", "Allen Zwecken zustimmen", "Einwilligung ablehnen" not recognized | wording unknown | patterns plus tests for look-alikes that must not match |
| "No imprint" error on a large site | footer rendered lazily, so `innerText` of its links was empty | `textContent` for links that have a box |
| "No imprint" and "no privacy link" on a large site | first visit redirected to a separate consent page | consent-wall detection, no legal checks there |
| Reject silently untested | only the accept visit saw the late banner | repeat the other visit once; report an untested click |
| "No imprint" and "no privacy link" on a small business site | page-builder footer items were clickable headings without href (URL set by a script) | clickable elements with the exact standard label count as found; target reported as not verifiable (info) |
| "Accept everything" not recognized | English wording unknown | pattern plus test |
| A reject control "found" that was the label of a category checkbox ("Essential", "Notwendige Cookies", "Erforderliche Cookies"); the click failed, and the missing-reject warning was not raised | the strict reject pattern matches bare category names, and the plain-control search took a clickable `<label>` for a control | checkbox labels, switches, tabs and accordion headers never count as a decision; tests break both search paths on purpose |
| "I Accept All" and "Accept Only Essential Cookies" not recognized | English wording unknown | patterns plus tests for mixed choices that must not match |
| "Search incomplete" on several large sites during a regression run | five scans in parallel overloaded the machine; queries hit their time limit | run large-site regressions with `CP_PARALLEL=2`; the tool degrades to "incomplete", never to a false claim |

Methods lesson: a ground truth from one neutral screenshot can be wrong. Two sample-3 disagreements were the tool being right (a banner that appeared after the screenshot; a banner hidden behind a location popup). Always check the click screenshots before blaming the tool, and report such corrections openly.

A theory that turned out wrong: a banner dialog looked like a marketing mock-up, but `--screenshots` showed it is real. Always look at the evidence screenshot before deciding a detection is wrong.

## Current status (2026-09-25)

- Core scanner, click test, evidence screenshots, first-party option, imprint mode, demo: done and tested (109 tests, about two minutes, zero unhandled rejections). The suite passes on Node 20, 22 and 26; the packed tarball installs and runs from a clean folder.
- Verified on real sites (names kept out of the repo on purpose): 71 small-business sites and 20 large German sites; see `docs/VALIDATION.md`.
- **Validation:** 71 real sites in three samples, two of them judged blind, each scanned three times. See `docs/VALIDATION.md` for method, numbers and limits. Raw results with site names are kept out of the repo.
- **Tracking after reject is verified on real sites:** three screenshot-checked cases (a HubSpot click pixel; Microsoft Clarity sending data after reject; Clarity loaded only after "Decline"). No site names in the repo.
- GitHub: public repo `Elijas121/consentprobe`. CI runs the tests on Node 20 and 22; `action-smoke` runs the composite action against https://example.com.
- Not done: npm publish, a blind validation judged by a person.

## Next steps

1. A blind validation with small and large sites, judged by a person from neutral screenshots.
2. npm publish.
3. Second banner layers ("Settings"), full-page consent walls, EU geolocation option.

## Definition of done for any change

- `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- New detection logic: unit test, integration test with a fixture, mutation check, real-site regression looked at.
- README and this file updated if behavior or decisions changed.
