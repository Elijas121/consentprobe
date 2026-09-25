# Validation

How well does consentprobe do what it claims? This file records the method, the numbers and the limits. Raw results name real companies and are therefore **not** in this repository.

Date: 2026-09-24/25. Version: 0.1.0.

## What was measured

For each site, three facts that a person can check on a screenshot:

- **B:** Is a cookie banner (or cookie notice) visible?
- **R:** Is a general reject control on the first layer ("Alle ablehnen", "Nur notwendige", "Decline" …)?
- **A:** Is a general accept control on the first layer?

Plus, for every click the tool made, whether it clicked the right control, and for every finding of type "after reject", whether the evidence holds.

## Samples

| Sample | Sites | Kind | Judged |
|---|---|---|---|
| 1 | 15 | carpenters, electricians, dental practices (Germany) | from screenshots, after the tool ran |
| 2 | 26 | hotels, law firms, coffee shops, physiotherapists, towns, UK bakeries | **blind**: judged from a neutral baseline screenshot before reading any tool output |
| 3 | 30 | Austrian restaurants, Swiss accountants, car workshops, driving schools, UK dentists, wine shops | **blind**, and only after all tuning was finished |

Sites were picked from web search results per category, not by whether they have a banner.

## Results

### Before tuning (the honest first numbers)

| Sample | B | R | A | Wrong clicks |
|---|---|---|---|---|
| 2 (blind, first run) | 25/26 | 22/24 | 20/23 | 0 of 26 clicks |

All misses were "not found". The tool never attributed a control that did not exist. The misses were fixed (see AGENTS.md, "Lessons"); sample 2 is therefore no longer blind.

### After tuning

| Sample | B | R | A |
|---|---|---|---|
| 3 (blind, not used for tuning), as judged blind | 26/28 | 26/28 | 25/27 |
| 3 after checking the two disagreements | 28/28 | 28/28 | 27/27 |
| All 71 sites, final version | 69/69 | 66/66 | 64/64 |

The two sample-3 disagreements were errors in the **ground truth**, not the tool: one banner appeared only after the baseline screenshot (the click screenshots show it), one banner sat behind a location popup (the tool found it and reported the click as blocked). Both corrections are listed here because they favour the tool.

Two further sites are counted separately: the tool reported **"search incomplete"** (a third-party frame never loaded) and made no claim either way. Before the fix, the tool hung on these two sites for more than 20 minutes.

### Clicks

70 clicks on 71 sites in the final run. Every clicked label was checked: all were general reject or accept controls. Zero wrong clicks.

### Tracking after reject

Three findings on real sites, each checked with the before/after screenshots (the general reject control was clicked and the banner disappeared):

1. A HubSpot click pixel fired after reject.
2. Microsoft Clarity kept sending data after reject.
3. Microsoft Clarity was loaded only after the visitor clicked "Decline".

Two further candidates were **downgraded** after inspection, because the tool had been too harsh: a Google request carrying `gcs=G100` (Consent Mode "denied" ping, now its own warning) and `_ga` cookies that were set before the click and never changed (now info).

### Legal links

Every imprint/privacy finding across the runs was checked by hand, five in total:

- **Three correct:** a missing imprint link, a missing privacy link, and a privacy link that answers 404 after a redirect.
- **Two false alarms, both fixed:** an imprint link without visible text in a collapsed menu (now "uncertain", a warning, not "missing"), and a privacy link that answered HTTP 502 once and 200 on every retry (transient server errors are now retried and never reported as broken).

After the fixes, a baseline scan of all sites produced exactly four legal findings: the three correct ones and the hidden-menu case as a warning.

### Reproducibility and robustness

- Each site was scanned three times. Error and warning findings were identical across runs, except the one transient 502 above (fixed).
- No scan ran into the 3-minute watchdog in the final runs. Two sites that used to hang now finish in 10-12 s.
- 72 automated tests with a real browser; every new guard was checked by breaking it on purpose (the test must turn red).

## Limits

- **One judge.** The ground truth was judged by the same person (an AI assistant) who tuned the heuristics. Sample 3 was blind and untouched by tuning, but an outside reviewer is still missing.
- **Small samples.** 71 sites, mostly German-speaking small businesses. Large sites, other languages and exotic consent tools are underrepresented.
- **One snapshot.** A banner that appears late can be missing from the baseline screenshot, as happened once.
- **First layer only.** Settings dialogs behind "Einstellungen" are not tested.
- **Location.** Scans ran from a single EU IP address. Sites that show banners only in some countries may behave differently elsewhere.

## Reproduce

`scripts/scan-list.sh <urls.txt> <out-dir>` scans a list with screenshots (`CP_PARALLEL` sets parallel scans, default 4). Build your own ground truth from `shots/<host>/baseline.png` **before** reading the JSON output, then compare `consent.banner` with it.
