import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { newBudget } from "../src/bounded.js";
import { CANDIDATE_LABEL, changedLabel } from "../src/consent.js";
import { scan } from "../src/scan.js";
import { startFixtures, type Fixtures } from "./fixtures.js";

let fx: Fixtures;
beforeAll(async () => {
  fx = await startFixtures();
});
afterAll(async () => {
  await fx.close();
});

const opts = () => ({
  settleMs: 400,
  timeoutMs: 15000,
  bannerWaitMs: 4000,
  extraRules: [
    { id: "test-analytics", name: "Test Analytics", category: "analytics" as const, hosts: [fx.thirdPartyHost] },
  ],
});
const find = (r: Awaited<ReturnType<typeof scan>>, id: string) => r.findings.find((f) => f.id === id);

describe("consent click test (real browser)", () => {
  it("passes a banner that respects reject and shows what accept unlocks", async () => {
    const r = await scan(`${fx.origin}/banner-good`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject).toMatchObject({ clicked: true });
    expect(r.consent?.accept).toMatchObject({ clicked: true });
    expect(r.findings.filter((f) => f.id.includes("after-reject"))).toEqual([]);
    expect(r.summary.error).toBe(0);
    expect(find(r, "consent-unlocks")?.message).toContain("Test Analytics");
  });

  it("flags a tracker request and cookie that continue after reject", async () => {
    const r = await scan(`${fx.origin}/banner-bad`, opts());
    expect(find(r, "third-party-after-reject:test-analytics")?.severity).toBe("error");
    expect(find(r, "tracker-cookie-after-reject:google-analytics")?.severity).toBe("error");
    expect(r.summary.error).toBeGreaterThanOrEqual(2);
  });

  it("reports a Consent Mode 'denied' ping after reject as its own warning, not as tracking", async () => {
    const r = await scan(`${fx.origin}/banner-consent-mode`, opts());
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(find(r, "consent-mode-ping-after-reject:test-analytics")?.severity).toBe("warn");
    expect(find(r, "consent-mode-ping-after-reject:test-analytics")?.evidence[0]).toContain("gcs=G100");
    expect(find(r, "third-party-after-reject:test-analytics")).toBeUndefined();
  });

  it("does not blame reject for a tracker cookie that was set before and left unchanged", async () => {
    const r = await scan(`${fx.origin}/banner-kept-cookie`, opts());
    expect(find(r, "tracker-cookie-before-consent:google-analytics")?.severity).toBe("error");
    expect(find(r, "tracker-cookie-after-reject:google-analytics")).toBeUndefined();
    expect(find(r, "tracker-cookies-not-removed-after-reject")?.severity).toBe("info");
  });

  it("warns when only an accept control exists on the first layer", async () => {
    const r = await scan(`${fx.origin}/banner-no-reject`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: false, acceptFound: true });
    expect(find(r, "no-reject-control-on-first-layer")?.severity).toBe("warn");
    expect(r.consent?.reject?.clicked).toBe(false);
  });

  it("recognizes real-world wording such as 'Ich akzeptiere alle' and 'Nur essenzielle Cookies akzeptieren'", async () => {
    const r = await scan(`${fx.origin}/banner-borlabs-style`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.accept?.clicked).toBe(true);
    expect(r.consent?.reject?.clicked).toBe(true);
  });

  it("finds a low-emphasis reject such as 'Nur essenzielle' (regression from a real site)", async () => {
    const r = await scan(`${fx.origin}/banner-text-link-reject`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(find(r, "no-reject-control-on-first-layer")).toBeUndefined();
  });

  it("waits for a banner that appears late", async () => {
    const r = await scan(`${fx.origin}/banner-delayed`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true });
    expect(r.consent?.reject?.clicked).toBe(true);
  });

  it("says so, without judging, when no banner is recognized", async () => {
    const r = await scan(`${fx.origin}/clean`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner.detected).toBe(false);
    expect(find(r, "no-consent-banner-detected")?.severity).toBe("info");
    expect(r.summary.error).toBe(0);
  });

  it("never clicks controls of a banner mock-up that is not an overlay", async () => {
    const r = await scan(`${fx.origin}/banner-mockup`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner.detected).toBe(false);
    expect(r.consent?.reject).toMatchObject({ clicked: false });
    expect(r.consent?.accept).toMatchObject({ clicked: false });
  });

  it("does not claim 'no banner' when a cookie overlay is visible but not automatable", async () => {
    const r = await scan(`${fx.origin}/banner-toggle-only`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, overlayHint: true });
    expect(find(r, "consent-overlay-not-automatable")?.severity).toBe("info");
    expect(find(r, "no-consent-banner-detected")).toBeUndefined();
  });

  it("saves a neutral baseline screenshot plus before/after screenshots of each click", async () => {
    const { mkdtemp, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "consentprobe-"));
    await scan(`${fx.origin}/banner-good`, { ...opts(), screenshotDir: dir });
    expect((await readdir(dir)).sort()).toEqual([
      "accept-1-before-click.png",
      "accept-2-after-click.png",
      "baseline-2-after-banner-wait.png",
      "baseline.png",
      "reject-1-before-click.png",
      "reject-2-after-click.png",
    ]);
  });

  it("recognizes Shopify's privacy banner by its button ids even with renamed labels", async () => {
    const r = await scan(`${fx.origin}/banner-shopify`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, cmp: "Shopify", rejectFound: true, acceptFound: true });
    expect(r.consent?.reject).toMatchObject({ clicked: true, control: { label: "No Thanks", method: "cmp-selector" } });
  });

  it("never treats a newsletter popup's 'No thanks' as a cookie reject", async () => {
    const r = await scan(`${fx.origin}/newsletter-popup`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, rejectFound: false, acceptFound: false });
    expect(r.consent?.reject?.clicked).toBe(false);
  });

  it("notices a thin cookie information bar instead of claiming there is no banner", async () => {
    const r = await scan(`${fx.origin}/notice-bar`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, overlayHint: true });
    expect(find(r, "consent-overlay-not-automatable")).toBeDefined();
    expect(r.summary.error).toBe(0);
    expect(r.summary.warn).toBe(0);
  });

  it("does not count requests from before the press as 'after reject', also with slow screenshots", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    for (const screenshotDir of [undefined, await mkdtemp(join(tmpdir(), "consentprobe-hb-"))]) {
      const r = await scan(`${fx.origin}/banner-heartbeat`, { ...opts(), screenshotDir });
      expect(r.consent?.reject?.clicked).toBe(true);
      expect(find(r, "third-party-before-consent:test-analytics")?.severity).toBe("error");
      expect(find(r, "third-party-after-reject:test-analytics")).toBeUndefined();
    }
  }, 60000);

  it("stops with a clear error instead of hanging when the page freezes the browser", async () => {
    const started = Date.now();
    await expect(scan(`${fx.origin}/hung-after-load`, { ...opts(), timeoutMs: 15000 })).rejects.toThrow(/stopped responding/);
    expect(Date.now() - started).toBeLessThan(45000);
  }, 60000);

  it("reports 'incomplete', not 'no banner', when a frame that never loads blocks the search", async () => {
    const r = await scan(`${fx.origin}/stalled-frame`, { ...opts(), timeoutMs: 15000, bannerWaitMs: 1500 });
    expect(r.consent?.banner).toMatchObject({ detected: false, incomplete: true });
    expect(find(r, "consent-detection-incomplete")?.severity).toBe("info");
    expect(find(r, "no-consent-banner-detected")).toBeUndefined();
  }, 60000);

  it("still finds and clicks a banner when an unrelated frame never loads, without long delays", async () => {
    const started = Date.now();
    const r = await scan(`${fx.origin}/stalled-frame-with-banner`, { ...opts(), timeoutMs: 15000 });
    // About 29 s by construction (bounded load wait, network idle before and after the click). The
    // bound only has to catch the old 20-minute hang; 40 s left too little room on a busy machine.
    expect(Date.now() - started).toBeLessThan(50000);
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(r.consent?.banner.incomplete).toBeUndefined();
  }, 60000);

  it("sees the banner that a site hides from headless browsers", async () => {
    const r = await scan(`${fx.origin}/banner-hidden-from-bots`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.clicked).toBe(true);
    // The bot view loads the tracker at once; a regular visitor's first page does not.
    expect(r.requests.some((q) => q.url.endsWith("/analytics.js"))).toBe(false);
  });

  it("finds banner controls built from links without href", async () => {
    const r = await scan(`${fx.origin}/banner-plain-controls`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.control?.label).toBe("Nur notwendige Cookies");
    expect(r.consent?.accept?.control?.label).toBe("Geht klar");
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(r.consent?.accept?.clicked).toBe(true);
    expect(find(r, "third-party-after-reject:test-analytics")).toBeUndefined();
    expect(find(r, "consent-unlocks")?.message).toContain("Test Analytics");
  });

  it("finds the real controls next to category names and never takes a category name for a reject", async () => {
    const r = await scan(`${fx.origin}/banner-category-list`, opts());
    expect(r.consent?.reject?.control?.label).toBe("Accept Only Essential Cookies");
    expect(r.consent?.accept?.control?.label).toBe("I Accept All");
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(r.consent?.accept?.clicked).toBe(true);
    const none = await scan(`${fx.origin}/banner-category-list-no-reject`, opts());
    expect(none.consent?.banner).toMatchObject({ detected: true, rejectFound: false, acceptFound: true });
    expect(none.consent?.reject?.control).toBeUndefined();
    expect(find(none, "no-reject-control-on-first-layer")).toBeDefined();
  });

  it("finds a consent bar that is part of the page flow, by its container name", async () => {
    const r = await scan(`${fx.origin}/banner-inline-top`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.control?.label).toBe("Ablehnen");
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(r.consent?.accept?.clicked).toBe(true);
  });

  it("reads controls built from <input> elements, and banners inside a shadow root", async () => {
    for (const path of ["/banner-input-buttons", "/banner-shadow"]) {
      const r = await scan(`${fx.origin}${path}`, opts());
      expect(r.consent?.banner, path).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
      expect(r.consent?.reject?.control?.label, path).toBe("Alle ablehnen");
      expect(r.consent?.reject?.clicked, path).toBe(true);
      expect(r.consent?.accept?.clicked, path).toBe(true);
    }
  });

  it("finds controls in a sticky button row inside the banner, and text split across web components", async () => {
    for (const path of ["/banner-sticky-buttons", "/banner-shadow-split"]) {
      const r = await scan(`${fx.origin}${path}`, opts());
      expect(r.consent?.banner, path).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
      expect(r.consent?.reject?.control?.label, path).toBe("Ablehnen");
      expect(r.consent?.reject?.clicked, path).toBe(true);
      expect(r.consent?.accept?.clicked, path).toBe(true);
    }
  });

  it("finds plain clickable controls inside an open shadow root", async () => {
    const r = await scan(`${fx.origin}/banner-shadow-plain-controls`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.control?.label).toBe("Alle ablehnen");
    expect(r.consent?.accept?.control?.label).toBe("Alle akzeptieren");
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(r.consent?.accept?.clicked).toBe(true);
  }, 30000);

  it("never takes a video content blocker in the page for the banner", async () => {
    const r = await scan(`${fx.origin}/video-placeholder-late-banner`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.control?.label).toBe("Alle ablehnen");
    expect(r.consent?.accept?.control?.label).toBe("Alle akzeptieren");
    expect(find(r, "no-reject-control-on-first-layer")).toBeUndefined();
  });

  it("finds the banner's link controls behind many matching links in the page", async () => {
    const r = await scan(`${fx.origin}/banner-many-links`, opts());
    expect(r.consent?.reject?.control?.label).toBe("Alle ablehnen");
    expect(r.consent?.accept?.control?.label).toBe("Alle akzeptieren");
  });

  it("never clicks a banner mock-up inside a fixed page wrapper", async () => {
    const r = await scan(`${fx.origin}/scroll-wrapper-mockup`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, rejectFound: false, acceptFound: false });
    expect(r.consent?.accept?.clicked).toBe(false);
  });

  it("says 'no banner' plainly when the only silent frame is a lazy iframe that never loaded", async () => {
    const r = await scan(`${fx.origin}/lazy-frame-no-banner`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, rejectFound: false, acceptFound: false });
    expect(r.consent?.banner.incomplete).toBeUndefined();
  });

  it("never clicks buttons of an app shell, a video lightbox or a newsletter prompt", async () => {
    for (const path of ["/fixed-shell-form", "/video-lightbox", "/newsletter-prompt"]) {
      const r = await scan(`${fx.origin}${path}`, { ...opts(), bannerWaitMs: 800 });
      expect(r.consent?.banner, path).toMatchObject({ detected: false, rejectFound: false, acceptFound: false });
      expect(r.consent?.reject?.clicked, path).toBe(false);
      expect(r.consent?.accept?.clicked, path).toBe(false);
    }
  }, 30000);

  it("finds the controls of a banner with a long text", async () => {
    const r = await scan(`${fx.origin}/banner-long-text`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.reject?.clicked).toBe(true);
  });

  it("takes 'Okay!' as the accept only next to a reject in the same banner", async () => {
    const r = await scan(`${fx.origin}/banner-okay`, opts());
    expect(r.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(r.consent?.accept?.control?.label).toBe("Okay!");
    expect(r.consent?.accept?.clicked).toBe(true);
    const other = await scan(`${fx.origin}/ok-in-other-bar`, { ...opts(), bannerWaitMs: 800 });
    expect(other.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: false });
    expect(other.consent?.accept?.clicked).toBe(false);
  }, 30000);

  it("never takes an age or terms gate for a cookie banner, but keeps a banner that names the terms", async () => {
    for (const path of ["/age-gate", "/terms-gate"]) {
      const r = await scan(`${fx.origin}${path}`, { ...opts(), bannerWaitMs: 800 });
      expect(r.consent?.banner, path).toMatchObject({ detected: false, rejectFound: false, acceptFound: false });
      expect(r.consent?.reject?.clicked, path).toBe(false);
    }
    const banner = await scan(`${fx.origin}/banner-with-terms`, opts());
    expect(banner.consent?.banner).toMatchObject({ detected: true, rejectFound: true, acceptFound: true });
    expect(banner.consent?.reject?.clicked).toBe(true);
  }, 30000);

  it("never takes a push-notification prompt for a cookie banner", async () => {
    const r = await scan(`${fx.origin}/push-prompt`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, rejectFound: false, acceptFound: false });
    expect(r.consent?.reject?.clicked).toBe(false);
    expect(r.consent?.accept?.clicked).toBe(false);
  });

  it("never clicks control-like words that are plain text in an overlay", async () => {
    const r = await scan(`${fx.origin}/overlay-text-not-control`, { ...opts(), bannerWaitMs: 800 });
    expect(r.consent?.banner).toMatchObject({ detected: false, overlayHint: true });
    expect(r.consent?.reject?.clicked).toBe(false);
    expect(r.consent?.accept?.clicked).toBe(false);
  });

  it("repeats a visit that missed a late banner, so both clicks are tested", async () => {
    fx.resetLateTickets();
    const r = await scan(`${fx.origin}/banner-sometimes-late`, { ...opts(), bannerWaitMs: 1000 });
    expect(r.consent?.reject?.clicked).toBe(true);
    expect(r.consent?.accept?.clicked).toBe(true);
    expect(find(r, "consent-reject-not-tested")).toBeUndefined();
    expect(find(r, "consent-accept-not-tested")).toBeUndefined();
    // One ticket per marked visit: the two click visits, plus the repeat of the one that missed the
    // late banner. The baseline visit carries no marking binding and never asks (see the fixture).
    expect(fx.lateTicketCount()).toBe(3);
  }, 60000);

  it("skips the click visits when clickTest is off", async () => {
    const r = await scan(`${fx.origin}/banner-good`, { ...opts(), clickTest: false });
    expect(r.consent).toBeUndefined();
  });
});

describe("label check before the click (real browser)", () => {
  it("notices when a re-rendered banner put another control at the judged position", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<div role="dialog"><p>Wir verwenden Cookies.</p><button>Alle ablehnen</button><button>Alle akzeptieren</button></div>`);
      const locator = page.getByRole("button", { name: CANDIDATE_LABEL }).nth(0);
      const target = { locator, frame: page.mainFrame(), control: { label: "Alle ablehnen", method: "text" as const } };
      expect(await changedLabel(target, newBudget())).toBeUndefined();
      // The banner re-renders: the reject control is gone, the accept control moves to its position.
      await page.evaluate(() => document.querySelector("button")?.remove());
      expect(await changedLabel(target, newBudget())).toBe("Alle akzeptieren");
    } finally {
      await browser.close();
    }
  });
});
