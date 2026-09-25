---
name: consentprobe
description: Measure what a website does before and after the cookie banner (third-party requests, tracker cookies, reject and accept behavior, imprint and privacy links) with the consentprobe CLI, then explain the findings and concrete fixes. Use when the user asks to check a site for cookie consent, GDPR/TDDDG behavior, tracking before consent, Google Fonts, or a pre-launch privacy check.
---

# consentprobe

Runs a real browser against a URL in three isolated visits (baseline, reject click, accept click) and reports technical findings. It measures behavior. It is **not** legal advice.

## When to use it

- The user wants a pre-launch or pre-delivery privacy check of a website.
- The user asks whether a site tracks before consent or whether "reject" works.
- Scan only sites the user owns, operates or has permission to check. Never publish results about a site or company the user does not own or operate (not in repos, issues, posts or public CI summaries).

## How to run it

From the consentprobe checkout (built with `pnpm build`), or via `npx consentprobe` once published:

```bash
node dist/cli.js <url> --format json --screenshots ./evidence --fail-on never
```

Useful options: `--first-party <domain>` for the operator's own asset CDN, `--imprint always` to force the imprint check, `--no-click-test` for a quick baseline, `--browser chrome` to use installed Chrome.

Exit codes: 0 passed, 1 findings, 2 error or page not measurable (for example HTTP 403 bot protection). On exit 2, say the site could not be measured. Do not fill the gap with guesses.

## How to read the result

The JSON has `findings[]` (`id`, `severity`, `message`, `evidence[]`), `consent.banner`, and the recorded `requests` and `cookies`.

| Finding id starts with | Meaning | Typical fix |
|---|---|---|
| `third-party-before-consent:*` | A known service was contacted before any click | Load it only after consent; self-host fonts and libraries |
| `tracker-cookie-before-consent:*` | A known tracking cookie exists before any click | Set it only after consent |
| `third-party-after-reject:*`, `tracker-cookie-after-reject:*` | Still active after the reject click | Check that the consent tool really blocks the script; look at the screenshots |
| `consent-mode-ping-after-reject:*` | Google Consent Mode "denied" pings (`gcs=G100`) after reject | Disputed; decide deliberately whether cookieless pings are acceptable after a reject |
| `tracker-cookies-not-removed-after-reject` | Tracker cookies from before the click are still there, unchanged | Context: the before-consent findings are the real issue |
| `no-reject-control-on-first-layer` | Accept found, no general reject on the first layer | Add an equally prominent reject control, or explain the flow |
| `imprint-*`, `privacy-*` | Legal page link missing, broken, uncertain (e.g. hidden in a menu) or not verifiable | Add or fix the footer link |
| `consent-detection-incomplete` | Parts of the page did not respond, so the banner search is incomplete | Say so; do not claim there is no banner |
| `consent-overlay-not-automatable` | A cookie overlay is visible but has no automatable reject/accept | Check the screenshots by hand |
| `consent-unlocks`, `unclassified-third-party`, `consent-management-detected`, `infrastructure-cookies-*`, `*-skipped` | Context only | Review manually |

## Rules for the answer

1. **Verify before you accuse.** For any "after reject" finding, open the evidence screenshots (`reject-1-before-click.png`, `reject-2-after-click.png`) and confirm the clicked control really was the general reject. If not, say the finding is unreliable.
2. **No legal conclusions.** Say "the scan measured X", never "this violates the GDPR". Recommend a legal review for anything that matters.
3. **Say what was not tested:** banners can depend on location, only the first banner layer is tested, one page per run, and the tracker list is hand-curated and incomplete.
4. **Group the fixes** by effort: quick wins (self-host Google Fonts, fix footer links) before consent-tool configuration.
5. If the banner was "not recognized", say so plainly. It does not mean there is none.
