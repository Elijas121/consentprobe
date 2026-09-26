# Background: prior art and data licenses

Checked on 2026-09-24 on GitHub and on the projects' own pages.

## Why a consent scanner

- The open-source scanners that were checked are either not EU-focused (blacklight-collector) or showed no recent activity (CookieScanner: last push 2023; gdpr-cli: last push 2024).
- Webbkoll (dataskydd.net) measures only the first page load without interaction, per its own about page.
- Clicking banners is not new: DuckDuckGo's autoconsent (MPL-2.0) and Consent-O-Matic answer banners for the visitor, and research crawlers (for example on top of OpenWPM) have measured reject behaviour at scale. What was missing is a tool for a site owner: reject and accept each compared with an untouched baseline, with screenshots as evidence, runnable locally, in CI and by a coding agent.
- § 25 TDDDG generally requires consent before non-essential information is stored on or read from a visitor's device, and the GDPR requires a legal basis for sending personal data such as the IP address to third parties. What loads after "reject" is therefore a question a site owner should be able to answer. In Germany, competitors can pursue some GDPR violations under unfair-competition law (UWG), which makes false alarms costly. That is why consentprobe reports measurements, not verdicts.

## Known risks and how the design answers them

- **False positives** are the main risk, hence precision over recall; see AGENTS.md "Lessons".
- **A finding read as a legal verdict.** The tool reports technical findings only and never says a law is violated.

## Tracker data licenses (verified from the LICENSE files)

DuckDuckGo Tracker Radar, Disconnect and Ghostery TrackerDB: CC BY-NC-SA 4.0 (non-commercial, share-alike): not bundled. WhoTracks.me: code MIT, no license found for its data: not used. The built-in list in `src/rules.ts` is hand-written.
