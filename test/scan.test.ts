import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  clickTest: false,
  settleMs: 300,
  timeoutMs: 15000,
  extraRules: [
    { id: "test-analytics", name: "Test Analytics", category: "analytics" as const, hosts: [fx.thirdPartyHost] },
  ],
});
const ids = (r: Awaited<ReturnType<typeof scan>>) => r.findings.map((f) => f.id);

describe("scan (real browser)", () => {
  it("passes a clean page with no errors", async () => {
    const r = await scan(`${fx.origin}/clean`, opts());
    expect(r.summary.error).toBe(0);
    expect(r.summary.thirdPartyHosts).toBe(0);
    expect(r.legal.imprint).toMatchObject({ found: true, inFooter: true, status: 200 });
    expect(r.legal.privacy).toMatchObject({ found: true, inFooter: true, status: 200 });
  });

  it("detects a third-party script and a tracker cookie before consent", async () => {
    const r = await scan(`${fx.origin}/tracked`, opts());
    expect(ids(r)).toContain("third-party-before-consent:test-analytics");
    expect(ids(r)).toContain("tracker-cookie-before-consent:google-analytics");
    expect(r.summary.thirdPartyHosts).toBe(1);
    expect(r.summary.error).toBeGreaterThanOrEqual(2);
  });

  it("treats declared first-party domains as first party", async () => {
    const r = await scan(`${fx.origin}/tracked`, { ...opts(), firstParty: [fx.thirdPartyHost] });
    expect(r.summary.thirdPartyHosts).toBe(0);
    expect(ids(r)).not.toContain("third-party-before-consent:test-analytics");
  });

  it("skips the imprint check on a non-German page but keeps the privacy check", async () => {
    const r = await scan(`${fx.origin}/english-no-legal`, opts());
    expect(ids(r)).toContain("imprint-check-skipped");
    expect(ids(r)).not.toContain("imprint-link-missing");
    expect(ids(r)).toContain("privacy-link-missing");
  });

  it("stays silent about the imprint with --imprint never", async () => {
    const r = await scan(`${fx.origin}/english-no-legal`, { ...opts(), imprint: "never" });
    expect(ids(r)).not.toContain("imprint-check-skipped");
    expect(ids(r)).not.toContain("imprint-link-missing");
  });

  it("checks the imprint everywhere with --imprint always", async () => {
    const r = await scan(`${fx.origin}/english-no-legal`, { ...opts(), imprint: "always" });
    expect(ids(r)).toContain("imprint-link-missing");
  });

  it("strips query strings from recorded request URLs", async () => {
    const r = await scan(`${fx.origin}/tracked?email=a@b.de`, opts());
    expect(r.requests.every((q) => !q.url.includes("?"))).toBe(true);
  });

  it("reports missing legal links", async () => {
    const r = await scan(`${fx.origin}/no-legal`, opts());
    expect(ids(r)).toEqual(expect.arrayContaining(["imprint-link-missing", "privacy-link-missing"]));
  });

  it("reports an unreachable imprint link", async () => {
    const r = await scan(`${fx.origin}/broken-legal`, opts());
    expect(ids(r)).toContain("imprint-link-unreachable");
    expect(ids(r)).not.toContain("privacy-link-unreachable");
  });

  it("notes legal links that are not in a footer", async () => {
    const r = await scan(`${fx.origin}/legal-outside-footer`, opts());
    expect(ids(r)).toEqual(expect.arrayContaining(["imprint-link-not-in-footer", "privacy-link-not-in-footer"]));
    expect(r.summary.error).toBe(0);
  });

  it("refuses to measure an error page instead of reporting missing legal links", async () => {
    await expect(scan(`${fx.origin}/blocked`, opts())).rejects.toThrow(/HTTP 403/);
  });

  it("refuses to measure a bot check that answers HTTP 200", async () => {
    await expect(scan(`${fx.origin}/bot-challenge`, opts())).rejects.toThrow(/bot check/);
  });

  it("still measures a page whose load event never fires", async () => {
    const r = await scan(`${fx.origin}/slow-resource`, { ...opts(), timeoutMs: 20000 });
    expect(r.legal.imprint.found).toBe(true);
    expect(r.summary.error).toBe(0);
  }, 40000);

  it("reads legal links in a footer that renders only when scrolled into view", async () => {
    const r = await scan(`${fx.origin}/lazy-footer`, opts());
    expect(r.legal.imprint).toMatchObject({ found: true, status: 200 });
    expect(r.legal.privacy).toMatchObject({ found: true, status: 200 });
    expect(ids(r)).not.toContain("imprint-link-missing");
  });

  it("does not judge legal links on a consent wall the site redirected to", async () => {
    const r = await scan(`${fx.origin}/wall`, { ...opts(), clickTest: true, bannerWaitMs: 800 });
    expect(r.finalUrl).toMatch(/\/consent-management\/$/);
    expect(r.findings.find((f) => f.id === "consent-wall-page")?.severity).toBe("info");
    expect(ids(r)).not.toContain("imprint-link-missing");
    expect(ids(r)).not.toContain("privacy-link-missing");
    expect(ids(r)).not.toContain("no-consent-banner-detected");
  });

  it("recognizes consent-wall redirects by host or path only", async () => {
    const { isConsentWallRedirect } = await import("../src/scan.js");
    expect(isConsentWallRedirect("https://web.example/", "https://web.example/consent-management/")).toBe(true);
    expect(isConsentWallRedirect("https://news.example/", "https://consent.news.example/?ref=x")).toBe(true);
    expect(isConsentWallRedirect("https://shop.example/", "https://shop.example/de/")).toBe(false);
    expect(isConsentWallRedirect("https://shop.example/", "https://shop.example/consent-tips-for-shops")).toBe(false);
    expect(isConsentWallRedirect("https://a.example/consent/", "https://a.example/consent/")).toBe(false);
  });

  it("counts clickable legal items without href as found, with an unverifiable target", async () => {
    const r = await scan(`${fx.origin}/legal-scripted`, opts());
    expect(r.legal.imprint).toMatchObject({ found: true, scripted: true });
    expect(r.legal.privacy).toMatchObject({ found: true, scripted: true });
    expect(ids(r)).not.toContain("imprint-link-missing");
    expect(r.findings.find((f) => f.id === "imprint-link-unverified")?.message).toContain("scripted element");
  });

  it("still reports a missing imprint when the word is only plain text", async () => {
    const r = await scan(`${fx.origin}/legal-text-only`, opts());
    expect(ids(r)).toContain("imprint-link-missing");
    expect(ids(r)).toContain("privacy-link-missing");
  });

  it("explains an invalid URL", async () => {
    await expect(scan("not a url")).rejects.toThrow(/not a valid URL/);
  });

  it("rejects non-http URLs", async () => {
    await expect(scan("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});
