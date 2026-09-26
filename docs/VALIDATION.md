# Validation

How well does consentprobe do what it claims? This file records the method, the numbers and the limits. Raw results name real companies and are therefore **not** in this repository.

Date: 2026-09-24/25. Version: 0.1.0. The blind sample judged by a person is described in its own section below.

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

## Large sites (2026-09-25)

The 71 sites above are small businesses. A later scan of 20 large German sites (retail, travel, news, portals) showed problems that small sites never triggered. Each one was checked against screenshots; this check was not blind and was done by the same AI assistant.

- **Headless browsers are treated differently.** Two sites showed no banner to the headless browser, although a normal browser gets one. One of them loaded eight tracking services only for the headless browser, and the tool reported ten errors that a regular visitor never triggers. Two more sites refused the headless browser with HTTP 403. Fix: visits present themselves like Chromium in a normal window; all four sites are measured correctly now.
- **Controls that are not buttons.** One banner built its controls from links without `href`; they have no button or link role and were missed. Fix: plain clickable elements inside the overlay are searched too, with the same whole-label rules.
- **Wording.** "Geht klar", "Allen Zwecken zustimmen" and "Einwilligung ablehnen" were unknown. Added, with tests for similar wording that must not match.
- **Lazy footer.** One footer rendered only when scrolled into view, so its link text read as empty and a false "no imprint" error followed. Fix: a link that takes up space counts with its text content.
- **Consent wall.** One site redirected the first visit to a separate consent page, and the tool judged that page's missing footer links. Fix: such redirects are recognized and legal links are not judged there.
- **Late banner.** On one site only the accept visit saw the banner, so reject was never tested, and the report did not say so. Fix: the other visit is repeated once with a longer wait, and an untested click is reported.

After these fixes the tool recognized the banner on all 17 of the 20 large sites that show one; of the other three, one redirects to a consent wall, one has no banner and one still refuses automated browsers (HTTP 403) and is not measured. A blind sample judged by a person, with small and large sites, is the next step.

## Blind sample judged by a person (2026-09-25)

The samples above were judged by the AI assistant that also tuned the tool. This sample was judged by a person.

**Sites.** 50 sites picked from web search results per category before any scan: 30 small businesses in Germany, Austria and Switzerland, two per industry (bakeries, dentists, physiotherapists, law firms, car workshops, hairdressers, hotels, driving schools, restaurants, electricians, carpenters, opticians, vets, general practitioners) and 20 large German sites (retail, travel, news, portals). Two could not be measured (HTTP 500, and HTTP 403 from bot protection), so 48 sites remain.

**Method.**

1. The tool scanned all sites once. Only the neutral baseline screenshot of each site was copied into a separate folder.
2. The person judged B, R and A from those screenshots alone, following written rules fixed in advance (for example: "Einstellungen" and "Zum Abo" do not count as reject; a pure cookie notice counts as a banner), without opening the sites or seeing any tool output.
3. Every disagreement (17 sites) and every agreement (31 sites) was then checked against all screenshots of the site, and where the screenshots did not settle it, against the page structure. This check was done by the AI assistant, and each finding was re-checked by a second, independent check that tried to refute it. All findings held.

### What the check found about the ground truth

Agreement between the person and the tool is not the same as correctness, and disagreement is not always a tool error:

- **The baseline screenshot misses late banners.** On 5 of 48 sites the baseline screenshot shows no banner, although a first-time visitor gets one: on four it rendered after the screenshot (the click screenshots show it), on one it sat blurred behind a location popup. The person was right about the image, the tool was right about the site.
- **The person's answers on the image** were right for B on 42 of 47, for R on 24 of 34 (plus one "unclear") and for A on 31 of 35. The R errors came mostly from counting other buttons as reject: settings, "save selection" with boxes unticked by default, subscription offers on pay-or-consent walls, and category checkbox labels. Two banners were thin bars at the bottom edge and were overlooked; a full-page consent wall and a pure cookie notice were not counted as banners, and on one site a banner was marked where there is none.
- **Both were wrong together on four sites.** On two of them both answered "reject: yes", although the first layer offers only "save selection" and "accept all" (the tool because it took a category checkbox label for a control, see below); on the other two both missed a full-page consent wall and a cookie notice as "banner".

### Results

Against the checked ground truth for each site:

| Run | B | R | A |
|---|---|---|---|
| Blind first run (before any fix from this sample) | 47/47 | 36/39 | 36/39 |
| After the fixes, same sites (no longer blind) | 46/46 | 38/38 | 37/38 |

Not counted: one site where the tool reported "search incomplete" and made no claim, and one site with a consent wall on a separate page, where the tool at the time reported the wall but by design did not click (R and A). Since then the choice on such a wall is clicked like a banner; the numbers here were measured before that change. In the rescan after the fixes, one large site refused the browser with HTTP 403 after the many visits of that day; with the same code it had been measured correctly in three earlier runs.

**Errors of the blind run:**

- **Three category names taken for a reject control.** On three sites the tool reported a reject control that was only the label of a category checkbox ("Essential", "Notwendige Cookies", "Erforderliche Cookies"). The click on it failed each time, so no measurement was based on a wrong click. But the report counted a reject control as found, and so did not warn that two of these sites have no reject control on the first layer. This contradicts the earlier statement that every error was "not found"; it is fixed, and both search paths are now tested against category lists.
- **Two accept labels not recognized:** "Accept everything" and "I Accept All". Fixed.
- **One remaining disagreement:** a thin notice ("only technically necessary cookies are used") with a single "OK" button. The rules count "OK" in a cookie banner as accept; the tool reports such a notice as "not automatable" and does not click, because there is nothing to consent to.

**Clicks.** Blind run: 57 completed clicks, every one on a general reject or accept control. Five further click attempts failed: the three category labels above, and two real controls hidden behind a location popup, which the tool reported as blocked. After the fixes: 58 completed clicks, all on general controls; the two blocked ones remain and are reported as such.

## Limits

- **Few judges.** The ground truth of the 71-site samples was judged by the same AI assistant that tuned the heuristics. The 48-site sample was judged blind by one person, but its disagreements were settled by the AI assistant (with an independent second check). A second person judging independently is still missing.
- **Small samples.** 71 small-business sites plus 20 large sites, almost all German-speaking. Other languages and exotic consent tools are underrepresented.
- **One snapshot.** The baseline screenshot is taken after a fixed wait. A banner that appears later is missing from it (5 of 48 sites in the person-judged sample); the click screenshots show it. Judge ground truth from all screenshots, not from the baseline alone.
- **First layer only.** Settings dialogs behind "Einstellungen" are not tested.
- **Location.** Scans ran from a single EU IP address. Sites that show banners only in some countries may behave differently elsewhere.

## Reproduce

`scripts/scan-list.sh <urls.txt> <out-dir>` scans a list with screenshots (`CP_PARALLEL` sets parallel scans, default 4). Build your own ground truth from `shots/<host>/baseline.png` **before** reading the JSON output, then compare `consent.banner` with it.
