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

  it("does not report requests that the page's own Content Security Policy blocked", async () => {
    const r = await scan(`${fx.origin}/csp-blocked`, opts());
    expect(ids(r).filter((id) => id.startsWith("third-party-before-consent"))).toEqual([]);
    expect(r.requests.some((q) => q.host === fx.thirdPartyHost)).toBe(false);
  });

  it("does not blame the site for fonts that an embedded third-party frame loads for itself", async () => {
    const fontRule = { id: "test-fonts", name: "Test Fonts", category: "fonts" as const, hosts: [fx.thirdPartyHost], pathPrefix: "/font.woff2" };
    const playerRule = { id: "test-player", name: "Test Player", category: "video" as const, hosts: [fx.thirdPartyHost], pathPrefix: "/embed-frame" };
    const fonts = { ...opts(), extraRules: [fontRule, playerRule] };
    const embedded = await scan(`${fx.origin}/embed-font`, fonts);
    expect(ids(embedded)).not.toContain("third-party-before-consent:test-fonts");
    expect(ids(embedded)).toContain("third-party-before-consent:test-player");
    expect(embedded.requests.some((q) => q.url.endsWith("/font.woff2") && q.embeddedIn === fx.thirdPartyHost)).toBe(true);
    // An embed without a rule of its own is not reported, so its fonts must not vanish with it.
    const unknownEmbed = await scan(`${fx.origin}/embed-font`, { ...opts(), extraRules: [fontRule] });
    expect(unknownEmbed.findings.find((f) => f.id === "third-party-before-consent:test-fonts")?.message).toContain("embedded frame");
    const own = await scan(`${fx.origin}/page-font`, fonts);
    expect(ids(own)).toContain("third-party-before-consent:test-fonts");
  });

  it("does not count cookies that its own legal-link check received", async () => {
    const r = await scan(`${fx.origin}/legal-cookie`, opts());
    expect(r.legal.imprint.status).toBe(200);
    expect(r.cookies.map((c) => c.name)).not.toContain("legal_check");
  });

  it("counts the domain the user typed as first party after a redirect to another domain", async () => {
    const r = await scan(`${fx.origin}/redirect-away`, opts());
    expect(new URL(r.finalUrl).hostname).toBe(fx.thirdPartyHost);
    const typed = r.requests.filter((q) => q.host === "localhost" && q.url.endsWith("/px.gif"));
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.every((q) => !q.thirdParty)).toBe(true);
  });

  it("does not hide automation and sends a well-formed Accept-Language header", async () => {
    const r = await scan(`${fx.origin}/probe-identity`, opts());
    const paths = r.requests.map((q) => new URL(q.url).pathname);
    expect(paths).toContain("/wd-true.gif");
    expect(paths).toContain(`/al/${encodeURIComponent("de-DE,de;q=0.9")}.gif`);
  });

  it("explains a login wall, and measures a protected test site with credentials that stay out of the report", async () => {
    await expect(scan(`${fx.origin}/protected`, opts())).rejects.toThrow(/asks for a login \(HTTP 401\)/);
    const withLogin = fx.origin.replace("http://", "http://test:secret@");
    const r = await scan(`${withLogin}/protected`, opts());
    expect(r.url).toBe(`${fx.origin}/protected`);
    expect(JSON.stringify(r)).not.toContain("secret");
    // The token in the imprint link stays out of the result, including the finding that quotes the link.
    expect(r.findings.map((f) => f.id)).toContain("imprint-link-not-in-footer");
    expect(JSON.stringify(r)).not.toContain("abc123");
    // The credentials belong to the typed origin; a third party that asks for a login gets nothing.
    expect(fx.thirdPartySawCredentials()).toBe(false);
    expect(r.legal.imprint.href).toBe(`${fx.origin}/impressum`);
    expect(r.legal.privacy.href).toBe(`${fx.origin}/datenschutz`);
  });

  it("refuses to measure a bot check that answers HTTP 200", async () => {
    await expect(scan(`${fx.origin}/bot-challenge`, opts())).rejects.toThrow(/bot check/);
    // A hidden device check on a small ordinary page is no bot check.
    const contact = await scan(`${fx.origin}/contact-hidden-captcha`, opts());
    expect(contact.finalUrl).toBe(`${fx.origin}/contact-hidden-captcha`);
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
    // The page-side search uses the same label list as the link search, so no wording is known in one place only.
    const at = await scan(`${fx.origin}/legal-scripted-at`, opts());
    expect(at.legal.imprint).toMatchObject({ found: true, scripted: true });
    expect(at.legal.privacy).toMatchObject({ found: true, scripted: true });
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
