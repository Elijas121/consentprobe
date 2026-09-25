# consentprobe

Measure what a website does before and after a visitor answers the cookie banner.

`consentprobe` loads a page in a real browser three times, each visit with its own empty cookie jar:

1. **Baseline:** no interaction. Which third parties are contacted, which cookies are set?
2. **Reject:** click the banner's reject control. Does tracking stop?
3. **Accept:** click accept. What does accepting load?

It reports technical findings with evidence. It gives no legal advice and does not decide whether a law is violated.

> Status: early (0.1.0), not yet on npm. Run it from source, see below.

## Why another scanner?

Most open-source privacy scanners measure only the first page load. Under § 25 TDDDG and the GDPR the interesting part is often what happens after the visitor clicks "reject". `consentprobe` tests that path and compares it with the baseline.

## Example

A local test page whose banner ignores the reject click (not a real site). Run it yourself with `pnpm demo`.

![consentprobe run against a local test page: the banner's reject click is ignored and tracking continues](docs/demo.gif)

```
consentprobe 0.1.0  http://localhost:PORT/banner-bad
Phase: before-consent (no interaction with any cookie banner), then reject and accept visits
Consent banner: recognized | reject: found ("Alle ablehnen") | accept: found ("Alle akzeptieren")
2 error, 0 warn, 1 info | before consent: 0 third-party host(s), 1 request(s), 0 cookie(s)

[ERROR] Demo Analytics (analytics): 1 request(s) after the reject control was clicked.
        http://127.0.0.1:PORT/analytics.js
[ERROR] Google Analytics cookie(s) set or changed after the reject control was clicked.
        _ga (localhost)
[INFO] Accepting loaded 1 known service(s) (Demo Analytics) and 0 further unclassified third-party host(s).

Technical findings only. This is not legal advice and does not assess whether a data-protection or accessibility law is violated.
```

## What it checks

| Check | Severity |
|---|---|
| Analytics, advertising or external fonts contacted before consent | error |
| Known tracker cookies before consent (`_ga`, `_fbp`, Adobe, Hotjar, …) | error |
| Tracker requests or cookies set after the reject click | error |
| Tag manager, social, chat, maps, video or public CDNs before consent | warn |
| Google Consent Mode "denied" pings (`gcs=G100`) before consent or after reject | warn |
| An accept control, but no general reject control on the first layer | warn |
| Imprint (Impressum) link missing or broken | error |
| Privacy policy link missing or broken | error on German-language sites, warn elsewhere |
| A legal link that only weakly matches (shown as a candidate to check) | warn |
| Unknown third parties that appear only after the reject click | info |
| What accepting loads, unclassified third parties, consent-platform and Cloudflare cookies | info |
| A cookie overlay whose controls cannot be automated (e.g. a checkbox plus "save") | info |
| A redirect to a separate consent page; legal links are not judged there | info |
| Parts of the page did not respond, so the banner search is incomplete | info |
| A click that could not be tested (the banner appeared in one visit only) | info |

"German-language" means `<html lang="de">` or a `.de`, `.at` or `.ch` domain. On other sites the imprint check is skipped; `--imprint always` applies the German rules anyway.

## Install and run (from source)

The CLI runs on Node 20+. Building from source needs Node 22+ and pnpm 11 (pnpm 11 itself requires Node 22).

```bash
git clone https://github.com/Elijas121/consentprobe.git && cd consentprobe
pnpm install
pnpm exec playwright install chromium
pnpm build
node dist/cli.js example.com
```

`https://` is added when the URL has none. If no browser is installed, the tool tells you to run `npx playwright install chromium`.

Common options:

```bash
node dist/cli.js example.de --format md --out reports/example.md
node dist/cli.js example.de --format json --fail-on warn
node dist/cli.js example.de --screenshots ../evidence
node dist/cli.js example.de --first-party assets.example-cdn.de
```

| Option | Meaning |
|---|---|
| `--format text\|json\|md` | Output format (default `text`) |
| `--out <file>` | Write the report to a file (missing folders are created) |
| `--fail-on error\|warn\|never` | Exit code 1 at this severity or above (default `error`) |
| `--no-click-test` | Baseline only, skip the reject and accept visits |
| `--screenshots <dir>` | Save evidence screenshots before and after each click |
| `--first-party <domain>` | Extra domain of the site operator, e.g. its own asset CDN (repeatable) |
| `--imprint auto\|always\|never` | German rules: `auto` decides by language and domain, `always` forces them, `never` skips the imprint check |
| `--settle <ms>` / `--timeout <ms>` / `--banner-wait <ms>` | Timing, in whole milliseconds |
| `--browser chromium\|chrome` | Bundled Chromium or your installed Chrome |
| `--rules <file>` | JSON file with extra tracker rules |

Exit codes: `0` passed, `1` findings at or above `--fail-on`, `2` usage error or page not measurable.

### Extra tracker rules

```json
[
  { "id": "my-crm", "name": "My CRM widget", "category": "chat", "hosts": ["widget.my-crm.example"] }
]
```

Categories: `analytics`, `advertising`, `tag-manager`, `social`, `fonts`, `maps`, `video`, `chat`, `cdn`, `captcha`, `consent-platform`. An optional `pathPrefix` limits a rule to a path. A malformed file stops the run with a message that names the rule.

## Use it in CI

`action.yml` is a composite GitHub Action. It installs the tool, scans the URL and writes the Markdown report into the job summary; if the page cannot be measured, the summary says why. In a public repository the job summary is public, so point it only at sites you own or are authorized to test:

```yaml
- uses: Elijas121/consentprobe@main
  with:
    url: https://staging.example.de
    fail-on: error
```

## Use it as a library

```ts
import { scan, formatText } from "consentprobe";

const result = await scan("https://example.de", { screenshotDir: "./evidence" });
console.log(formatText(result));
if (result.summary.error > 0) process.exitCode = 1;
```

`scan` returns the same object as `--format json`. Types are included.

## Use it with a coding agent

`skills/consentprobe/SKILL.md` teaches Claude Code and similar agents to run the scan, read the JSON and explain each finding with a concrete fix, without legal conclusions.

## Limits

- **Location.** A banner may not appear from your IP address (some sites show one only in the EU). "No banner recognized" does not mean the site has none.
- **Browser identity.** Headless Chromium calls itself "HeadlessChrome", and many large sites then hide their banner and behave differently. `consentprobe` therefore presents itself like the same Chromium in a normal window (user agent and client hints). It does not hide that the browser is automated, and a site that answers with HTTP 403 is not measured.
- **First layer only.** Choices behind "Settings" are not explored. Full-page consent walls are recognized but not clicked.
- **One page per run.** No logins, no crawling.
- **Wording.** Controls are matched by known consent-platform selectors and by whole German or English labels, and only inside a real overlay. Unusual wording is reported as "not found", never guessed.
- **The tracker list is hand-curated and incomplete.** Unknown hosts appear as info. Lists such as DuckDuckGo Tracker Radar, Disconnect and Ghostery TrackerDB are CC BY-NC-SA and therefore not bundled.
- **Consent Mode.** A tag manager can load before consent and still block its tags, so tag managers are warnings; the analytics and advertising findings show what was actually sent.
- **Time.** Every question to the page has a time limit and the whole scan has a hard deadline. A frame that never loads leads to "search incomplete", not to a stuck CI job.
- **A finding is a measurement, not a verdict.** Use `--screenshots` to see what was clicked, and check the site yourself before you tell anyone it violates something.

## How accurate is it?

Tested on 71 real websites of small businesses in three samples, two of them judged blind, plus a blind sample of 48 small and large sites judged by a person (method and limits in [docs/VALIDATION.md](docs/VALIDATION.md)):

- Banner, reject control and accept control detected correctly on 69/69, 66/66 and 64/64 sites. On a blind sample before tuning it was 25/26, 22/24 and 20/23; every miss was "not found", never a wrong claim.
- 70 clicks, none on the wrong control.
- Person-judged blind sample (48 sites): 47/47, 36/39 and 36/39 in the blind first run. The errors: three category checkbox labels ("Essential", "Notwendige Cookies") taken for a reject control (all three clicks failed, so nothing was measured after a wrong click, but the missing-reject warning was not raised), and two accept labels not recognized. All fixed; on the same sites the tool now gets 46/46, 38/38 and 37/38.
- Three real cases of tracking after reject, each confirmed with before/after screenshots.

That sample had no large sites. A later check of 21 large German sites found that several of them treat headless browsers differently; the fixes are in this version, and [docs/VALIDATION.md](docs/VALIDATION.md) describes what was found. Treat the numbers as evidence, not as a benchmark.

## Privacy of the tool

Everything runs on your machine. Query strings are removed from recorded URLs because they can contain personal data. Nothing is sent to any service.

## Development

```bash
pnpm test           # unit tests plus real-browser tests against local fixtures
pnpm typecheck
pnpm build
pnpm demo           # the README example against local fixtures
vhs docs/demo.tape  # re-record docs/demo.gif (needs https://github.com/charmbracelet/vhs)
```

`AGENTS.md` has the conventions, `CONTRIBUTING.md` explains how to contribute, `docs/VALIDATION.md` how accuracy was measured and `docs/RESEARCH.md` the prior art and data licenses.

## License

MIT
