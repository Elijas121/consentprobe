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
  cli.ts        argument parsing, exit codes (0 ok, 1 findings, 2 page not measurable, 3 usage or setup error)
  scan.ts       orchestration: baseline + reject + accept visits in parallel; PageNotMeasurableError
  consent.ts    banner detection (CMP selectors + strict whole-label text match + overlay check), clicking
  navigate.ts   navigation (HTML first, bounded wait for the rest), one-line navigation errors, consent-wall redirects
  record.ts     request recording: initiating frame, requests the browser blocked itself (CSP)
  bounded.ts    time limits for page queries: bounded(), ask(), dead-frame skipping
  identity.ts   how visits present themselves (regular Chromium instead of HeadlessChrome)
  input.ts      CLI input: URL normalization, millisecond options, --rules validation
  findings.ts   pure functions: requests/cookies/legal/consent -> findings; classification helpers
  classify.ts   registrable domain (tldts), third-party test incl. same-company domains, rule matching
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
pnpm install                            # also builds dist/ (prepare script)
node dist/cli.js --install-browser      # once
pnpm typecheck
pnpm test                               # 151 tests, about two and a half minutes, real browser
pnpm build
node dist/cli.js <url> --screenshots ../cp-runs/evidence
scripts/scan-list.sh ../cp-runs/urls.txt ../cp-runs/out   # real-site regression, then read ../cp-runs/out/*.json
```

Keep URL lists, reports and screenshots of real sites outside the repository (as above). They name real sites and must never be committed; `.gitignore` catches the common output names as a safety net.

Node versions: Node 22+ (Node 20 is end of life). CI installs with Node 22 and runs the tests on 22, 24 and 26 by calling `node node_modules/...` directly; a separate job installs the packed tarball in an empty project and runs the installed CLI.

pnpm trap: a `pnpm-workspace.yaml` in a parent directory makes pnpm treat this repo as part of that workspace. This repo has its own `pnpm-workspace.yaml` so pnpm does not walk up. Keep it.

## Design decisions (and why)

- **Three isolated visits in parallel.** Separate cookie jars so accept cannot contaminate reject. If only one click visit sees the banner, the other is repeated once with twice the banner wait; a click that stays untested is reported (info).
- **Regular browser identity.** Headless Chromium says "HeadlessChrome" in its user agent and client hints, and several large sites then hide the banner and load tracking at once. Every visit presents itself like the same Chromium in a normal window (`identity.ts`, set per page through CDP, which also covers cross-origin frames). `navigator.webdriver` stays true and HTTP 403 is still refused: the goal is the page a visitor sees, not hiding.
- **Plain controls.** After the role search (button, link), plain clickable elements inside an overlay are searched too (`<a>` without href, `onclick`, `tabindex`, `cursor: pointer`). The same strict whole-label rules decide; plain text is never clicked.
- **Consent walls.** A redirect to a separate consent page (host `consent.*` or a path such as `/consent-management/`) is reported as info; legal links are not judged on that page, and its controls count without an overlay, so reject and accept are clicked there like on a banner.
- **Exact click moment.** An init script in every frame reports the physical `pointerdown`/`mousedown` through a binding; only requests after that moment count as "after reject". A marker taken in Node right before `click()` was not enough: the heartbeat test fails 3/3 with it, because Playwright's click takes tens of milliseconds.
- **Cookies after reject = new or changed only.** Cookies are compared (name, domain, value hash) with a snapshot right before the click. Unchanged tracker cookies from before the click are info ("not removed"); the before-consent findings already cover them.
- **Google Consent Mode is shown, not guessed.** The only query parameter kept is a validated `gcs` value. `G100` pings before consent and after reject are a separate warning with the signal as evidence; a "granted" signal before or after reject is called out explicitly.
- **Nothing may wait forever.** Every page query goes through `ask()` (3 s limit, errors always handled, a thunk so nothing is sent to a dead frame). A frame that timed out once is skipped for the rest of the visit. Navigation waits for the HTML plus a bounded time for the rest. The whole scan has a hard deadline, and `browser.close()` is bounded too.
- **Incomplete is not "no banner".** If any page query timed out and no banner was found, the result is "search incomplete". A visible cookie overlay without automatable controls is "not automatable". Only a clean search may say "not recognized".
- **Strict labels.** Only labels that match a general reject/accept as a whole are clicked (German, English, French, Italian, Spanish, Dutch, Polish; plus the refusal wording of Google Funding Choices, InMobi and Klaro). A reject-like label for a single service (e.g. "für Partner X jetzt ablehnen") or a reject that requires a subscription ("Rifiuta e abbonati") is reported, not clicked. Reason: clicking it produced a false finding on a real site. Bare "Autoriser" is left out (push prompts). A bare "OK" / "Okay!" counts as accept only when a general reject sits in the same overlay; on a pure notice it is never clicked (nothing to consent to).
- **Overlay requirement.** Text-matched controls must sit in a fixed/sticky ancestor, a dialog, an overlay iframe (cross-origin CMP iframes such as Sourcepoint are handled through `frameElement`), or a container whose id, class or tag says cookie/consent/gdpr (inline consent bars). A fixed wrapper that holds `<main>`, more than 100 links, a visible text field, or at least 60 % of the page's elements (pages with 40 or more) is the page, not an overlay (smooth-scroll and app shells). An element whose id or class names a content blocker (video, map, embed, placeholder, blocker, opt-out) is never an overlay, also when fixed: consent tools put "load this video" placeholders in the page and in lightboxes. The walk crosses open shadow roots. On a consent-wall page the whole page counts.
- **Consent context.** A matched control counts only if its overlay mentions cookies, consent, privacy or tracking; the walk stops at the outermost overlay (a sticky button row inside a banner is not the banner), so the page's own footer does not count. Button labels do not count as context unless they name cookies or consent themselves: a newsletter prompt with "Zustimmen" / "Ablehnen" is no banner. Push and newsletter prompts use the same verbs ("Erlauben", "Ablehnen"). Known gap: an age or terms gate whose text mentions the privacy policy passes this check.
- **Choice parts are no decisions.** Checkbox labels, switches, tabs and accordion headers ("Essential", "Notwendige Cookies") are never taken for a control.
- **Label re-check.** Controls are found by position; right before the click the label is read again and the click is skipped if it changed.
- **Same company is not a third party.** A small, hand-written map of company-run domains (Google, Microsoft, Meta, Amazon, Apple, Spotify, Wikimedia, Automattic, X, TikTok) treats e.g. Google Fonts on youtube.com as first party and lists such services as info. Customer hosting (blogspot.com, cloudfront.net, github.io …) is deliberately absent.
- **Embeds load their own files.** Every request remembers its frame. Fonts and CDN files requested inside a third-party frame (video player, map, captcha) are not blamed on the site; other services from inside an embed are marked in the message.
- **Blocked is not contacted.** Requests the browser stopped itself (the page's CSP, mixed content) never left the machine and are not reported.
- **Legal links by score.** Label 3 + path 2 + footer 3, minimum 5. A first-keyword-hit picker chose an article teaser on a real site.
- **Error pages are not measured** (HTTP >= 400 throws `PageNotMeasurableError`, a bot check with HTTP 200 throws `PageChallengedError`). Otherwise a 403 page produced "no imprint" errors. 401 is explained as a login wall; credentials in the URL are used as basic auth and removed from the result.
- **Unverifiable is not an error.** A legal link counts as broken only on 404 or 410. No response, a transient error or a refusal of the plain HTTP client (401, 403 …) is info. The check never requests local or private addresses for a public page, and cookies are read before it runs.
- **Tag manager = warn.** Consent Mode can block tags; analytics and advertising findings carry the real weight.
- **German rules only for German-looking sites** (`lang="de"`, .de/.at/.li, a .ch domain without another page language, or `--imprint always`). A missing privacy link is then an error. A missing imprint is an error only on a .de/.at/.ch/.li domain (or with `--imprint always`); on a German-language page elsewhere it is a warning, because consentprobe asks for German content and many international sites serve it. Elsewhere the imprint check is skipped (info) and a missing privacy link is a warning.
- **Legal link text.** `innerText`, or `textContent` when the link has a box but renders lazily (content-visibility). A link without a box keeps no label and ends up "uncertain".
- **Legal items without href.** Only when no real link matches: a visible, clickable element (onclick, tabindex, link or button role, `cursor: pointer`) whose whole text is the standard wording ("Impressum", "Datenschutz", …) counts as found. Its target cannot be checked, which is reported as info. Plain text that cannot be clicked never counts.
- **Query strings are stripped** from recorded request URLs, the final URL and legal links. Page text in reports and errors is reduced to printable characters (no line breaks, escape sequences or bidi overrides).
- **Reproducible results.** Each result records the browser and Playwright version. `--install-browser` installs the browser build of the bundled Playwright.

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
| "No imprint" error on international sites (a large code host, a software vendor, a video platform) | consentprobe asks for German content, the sites served it, and German language alone triggered the imprint rule | error only on .de/.at/.ch/.li domains, a warning otherwise |
| "YouTube contacted before consent" on youtube.com, "Google Fonts" on google.com | the operator's own domains counted as third parties | same-company domain map; such services listed as info |
| "Google Fonts: self-host them" on a site with only a YouTube embed or reCAPTCHA | Google's own iframes load Roboto for themselves | requests remember their frame; fonts/CDN files from third-party frames are not blamed on the site |
| A tracker "contacted" that never left the browser | the page's own CSP blocked it, but Chromium still fires a request event | requests failed with `csp`/`mixed-content` are dropped |
| "Imprint link does not resolve (HTTP 403)" | bot protection refused the plain HTTP link check | only 404/410 count as broken; refusals are unverified (info) |
| A bot-check page measured as if it were the site ("privacy link missing") | a challenge page answered HTTP 200 | challenge pages are refused like HTTP 403 |
| No banner on a large vendor's site that clearly shows one | the consent bar is part of the page flow (not fixed) | containers named cookie/consent/gdpr count as banner surfaces |
| Banners in French and Italian not automatable | wording unknown | whole-label patterns in five more languages, "reject and subscribe" deliberately excluded |
| French/Italian Swiss sites got German imprint errors | a .ch domain alone triggered German rules | .ch only without another page language; French/Italian legal labels known |
| "Search incomplete" on several large sites during a regression run | five scans in parallel overloaded the machine; queries hit their time limit | run large-site regressions with `CP_PARALLEL=2`; the tool degrades to "incomplete", never to a false claim |

Methods lesson: a ground truth from one neutral screenshot can be wrong. Two sample-3 disagreements were the tool being right (a banner that appeared after the screenshot; a banner hidden behind a location popup). Always check the click screenshots before blaming the tool, and report such corrections openly.

A theory that turned out wrong: a banner dialog looked like a marketing mock-up, but `--screenshots` showed it is real. Always look at the evidence screenshot before deciding a detection is wrong.

## Current status (2026-09-26)

- Core scanner, click test, evidence screenshots, first-party option, imprint mode, demo: done and tested (142 tests, about two minutes, zero unhandled rejections). CI runs the suite on Node 22, 24 and 26 and installs the packed tarball in an empty project.
- Verified on real sites (names kept out of the repo on purpose): 71 small-business sites and 20 large German sites; see `docs/VALIDATION.md`.
- **Validation:** 71 real sites in three samples, two of them judged blind, each scanned three times. See `docs/VALIDATION.md` for method, numbers and limits. Raw results with site names are kept out of the repo.
- **Tracking after reject is verified on real sites:** three screenshot-checked cases (a HubSpot click pixel; Microsoft Clarity sending data after reject; Clarity loaded only after "Decline"). No site names in the repo.
- **Blind validation by a person** (48 small and large sites) and a hostile review in eight lenses (false findings, clicks, robustness, security, docs, packaging, ethics, tests) are done; see `docs/VALIDATION.md`.
- GitHub: public repo `Elijas121/consentprobe`. CI: tests on Node 22/24/26, `package` installs the tarball, `action-smoke` runs the composite action against https://example.com.
- Not done: npm publish (needs the maintainer's npm account and a trusted publisher for `release.yml`).

## Next steps

1. npm publish.
2. A second person judging a blind sample independently.
3. Second banner layers ("Settings"), EU geolocation option.

## Definition of done for any change

- `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- New detection logic: unit test, integration test with a fixture, mutation check, real-site regression looked at.
- README and this file updated if behavior or decisions changed.
