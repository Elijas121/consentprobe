import { describe, expect, it } from "vitest";
import { isThirdParty, matchRule, registrableDomain } from "../src/classify.js";
import { classifyRequests, describeConsentSignal, findingsForCookies, findingsForLegal, findingsForRequests } from "../src/findings.js";
import { CANDIDATE_LABEL, isAcceptLabel, isRejectLabel, isRejectLike } from "../src/consent.js";
import { findLegalLinks } from "../src/legal.js";
import { formatMarkdown, formatText } from "../src/report.js";
import { checkLink, explainLaunchError, isLocalHost, looksGermanSite, looksLikeChallenge } from "../src/scan.js";
import { VERSION } from "../src/version.js";
import { readFileSync } from "node:fs";
import { explainNavigationError } from "../src/navigate.js";
import { ask, bounded, newBudget } from "../src/bounded.js";
import type { ScanResult } from "../src/types.js";

describe("classify", () => {
  it("handles multi-part public suffixes", () => {
    expect(registrableDomain("www.shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("a.b.example.de")).toBe("example.de");
  });
  it("treats IPs and localhost as their own domain", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(isThirdParty("127.0.0.1", "localhost")).toBe(true);
  });
  it("honours extra first-party domains such as an own asset CDN", () => {
    expect(isThirdParty("a.newsstatic.example", "www.news.example")).toBe(true);
    expect(isThirdParty("a.newsstatic.example", "www.news.example", ["newsstatic.example"])).toBe(false);
  });
  it("treats subdomains of the page domain as first party", () => {
    expect(isThirdParty("cdn.example.de", "www.example.de")).toBe(false);
    expect(isThirdParty("example.com", "example.de")).toBe(true);
  });
  it("does not count another domain of the same company as a third party, but keeps customer hosting apart", () => {
    expect(isThirdParty("fonts.gstatic.com", "www.youtube.com")).toBe(false);
    expect(isThirdParty("fonts.googleapis.com", "www.google.de")).toBe(false);
    expect(isThirdParty("open.scdn.co", "open.spotify.com")).toBe(false);
    expect(isThirdParty("upload.wikimedia.org", "en.wikipedia.org")).toBe(false);
    expect(isThirdParty("fonts.gstatic.com", "www.bakery.example")).toBe(true);
    expect(isThirdParty("www.google-analytics.com", "someone.blogspot.com")).toBe(true);
    expect(isThirdParty("d1.cloudfront.net", "www.amazon.de")).toBe(true);
    expect(isThirdParty("fonts.gstatic.com", "evil-google.com")).toBe(true);
    expect(isThirdParty("fonts.gstatic.com", "google.xyz")).toBe(true);
    expect(isThirdParty("fonts.gstatic.com", "www.google.co.uk")).toBe(false);
    const own = findingsForRequests(classifyRequests([{ url: "https://fonts.gstatic.com/s/x.woff2", resourceType: "font" }], "www.youtube.com"));
    expect(own.find((f) => f.id.startsWith("third-party-before-consent"))).toBeUndefined();
    expect(own.find((f) => f.id === "same-operator-services")?.message).toContain("Google");
  });
  it("matches rules on host suffix and path boundary, not substrings", () => {
    expect(matchRule(new URL("https://www.google-analytics.com/g/collect"))?.id).toBe("google-analytics");
    expect(matchRule(new URL("https://notgoogle-analytics.com/x"))).toBeUndefined();
    expect(matchRule(new URL("https://www.facebook.com/tr"))?.id).toBe("meta-tr");
    expect(matchRule(new URL("https://www.facebook.com/trending"))).toBeUndefined();
    expect(matchRule(new URL("https://www.google.com/recaptcha/api.js"))?.id).toBe("recaptcha");
    expect(matchRule(new URL("https://www.google.com/search"))).toBeUndefined();
  });
});

describe("Google Consent Mode signal", () => {
  it("keeps only a valid gcs value and still drops the rest of the query", () => {
    const [a, b, c] = classifyRequests(
      [
        { url: "https://region1.google-analytics.com/g/collect?v=2&gcs=G100&cid=123&dl=https%3A%2F%2Fe.de%2F%3Femail%3Dx", resourceType: "fetch" },
        { url: "https://www.google-analytics.com/g/collect?gcs=<script>", resourceType: "fetch" },
        { url: "https://www.google-analytics.com/g/collect?gcs=G111", resourceType: "fetch" },
      ],
      "e.de",
    );
    expect(a).toMatchObject({ url: "https://region1.google-analytics.com/g/collect", consentSignal: "G100" });
    expect(JSON.stringify(a)).not.toContain("cid");
    expect(b?.consentSignal).toBeUndefined();
    expect(c?.consentSignal).toBe("G111");
  });
  it("describes the flags in plain words", () => {
    expect(describeConsentSignal("G100")).toContain("ad storage denied, analytics storage denied");
    expect(describeConsentSignal("G101")).toContain("analytics storage granted");
  });
  it("marks granted signals before consent explicitly", () => {
    const f = findingsForRequests([
      { url: "https://www.google-analytics.com/g/collect", host: "www.google-analytics.com", resourceType: "fetch", thirdParty: true, consentSignal: "G111" },
    ]);
    expect(f[0]?.message).toContain("signal consent as granted before the banner was answered");
  });
});

describe("extended rules", () => {
  it("classifies embeds and consent platforms, not just trackers", () => {
    expect(matchRule(new URL("https://www.google.com/maps/embed?pb=x"))?.category).toBe("maps");
    expect(matchRule(new URL("https://www.google.com/search"))).toBeUndefined();
    expect(matchRule(new URL("https://www.facebook.com/plugins/page.php"))?.id).toBe("meta-plugins");
    expect(matchRule(new URL("https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"))?.category).toBe("consent-platform");
    expect(matchRule(new URL("https://secure.gravatar.com/avatar/x"))?.category).toBe("cdn");
  });
  it("lists consent platforms as info only", () => {
    const f = findingsForRequests([
      { url: "https://cdn.cookielaw.org/a.js", host: "cdn.cookielaw.org", resourceType: "script", thirdParty: true },
    ]);
    expect(f).toEqual([expect.objectContaining({ severity: "info", id: "third-party-before-consent:onetrust-cmp" })]);
  });
});

describe("findings", () => {
  const req = (url: string, thirdParty = true) => ({
    url,
    host: new URL(url).hostname,
    resourceType: "script",
    thirdParty,
  });

  it("rates analytics and fonts as error, tag manager and cdn as warn", () => {
    const f = findingsForRequests([
      req("https://www.googletagmanager.com/gtm.js"),
      req("https://fonts.googleapis.com/css"),
      req("https://cdn.jsdelivr.net/npm/x.js"),
    ]);
    const sev = Object.fromEntries(f.map((x) => [x.id, x.severity]));
    expect(sev["third-party-before-consent:google-tag-manager"]).toBe("warn");
    expect(sev["third-party-before-consent:google-fonts"]).toBe("error");
    expect(sev["third-party-before-consent:jsdelivr"]).toBe("warn");
  });
  it("ignores first-party requests and lists unknown third parties as info", () => {
    const f = findingsForRequests([req("https://example.de/app.js", false), req("https://unknown.example.org/a.js")]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: "unclassified-third-party", severity: "info" });
  });
  it("flags known tracker cookies as error, other first-party cookies as info", () => {
    const f = findingsForCookies([
      { name: "_ga", domain: "example.de", thirdParty: false, expires: 1900000000 },
      { name: "_ga_ABC123", domain: "example.de", thirdParty: false, expires: 1900000000 },
      { name: "session", domain: "example.de", thirdParty: false, expires: null },
    ]);
    expect(f.find((x) => x.id === "tracker-cookie-before-consent:google-analytics")?.severity).toBe("error");
    expect(f.find((x) => x.id === "first-party-cookies-before-consent")?.severity).toBe("info");
  });
  it("recognizes Adobe identity cookies as tracking and CMP cookies as consent storage", () => {
    const f = findingsForCookies([
      { name: "kndctr_0123456789ABCDEF01234567_AdobeOrg_identity", domain: "example.de", thirdParty: false, expires: 1900000000 },
      { name: "_sp_su", domain: "example.de", thirdParty: false, expires: 1900000000 },
    ]);
    expect(f.find((x) => x.id === "tracker-cookie-before-consent:adobe-experience-cloud")?.severity).toBe("error");
    expect(f.find((x) => x.id === "consent-management-detected")?.message).toContain("Sourcepoint");
    expect(f.find((x) => x.id === "first-party-cookies-before-consent")).toBeUndefined();
  });
  it("treats consentmanager and Cloudflare cookies as context, not as third-party tracking", () => {
    const f = findingsForCookies([
      { name: "__cmpcc", domain: "c.delivery.consentmanager.net", thirdParty: true, expires: 1900000000 },
      { name: "__cf_bm", domain: "jimstatic.com", thirdParty: true, expires: 1900000000 },
    ]);
    expect(f.find((x) => x.id === "third-party-cookie-before-consent")).toBeUndefined();
    expect(f.find((x) => x.id === "consent-management-detected")?.message).toContain("consentmanager");
    expect(f.find((x) => x.id === "infrastructure-cookies-before-consent")?.severity).toBe("info");
  });
  it("separates HubSpot tracking from HubSpot forms and chat", () => {
    expect(matchRule(new URL("https://track-eu1.hubspot.com/__ptc.gif"))?.category).toBe("analytics");
    expect(matchRule(new URL("https://js.hsforms.net/forms/v2.js"))?.category).toBe("chat");
  });
  it("classifies Adobe Launch as tag manager", () => {
    expect(matchRule(new URL("https://assets.adobedtm.com/launch-x.min.js"))?.category).toBe("tag-manager");
  });
  it("reports missing and unreachable legal links, but not unverifiable ones as errors", () => {
    const f = findingsForLegal({
      imprint: { found: false },
      privacy: { found: true, href: "https://e.de/dp", inFooter: true, status: 404 },
    });
    expect(f.map((x) => x.id).sort()).toEqual(["imprint-link-missing", "privacy-link-unreachable"]);
    const unverified = findingsForLegal({
      imprint: { found: true, href: "https://e.de/i", inFooter: true },
      privacy: { found: true, href: "https://e.de/d", inFooter: true, status: 200 },
    });
    expect(unverified).toEqual([expect.objectContaining({ id: "imprint-link-unverified", severity: "info" })]);
  });
});

describe("legal link detection", () => {
  it("prefers footer links and matches German and English wording", () => {
    const r = findLegalLinks([
      { href: "https://e.de/blog/datenschutz-tipps", text: "Datenschutz-Tipps", inFooter: false },
      { href: "https://e.de/datenschutz", text: "Datenschutzerklärung", inFooter: true },
      { href: "https://e.de/imprint", text: "Legal Notice", inFooter: true },
    ]);
    expect(r.privacy.href).toBe("https://e.de/datenschutz");
    expect(r.imprint.found).toBe(true);
  });
  it("does not mistake article headlines for the legal pages", () => {
    const r = findLegalLinks([
      { href: "https://e.de/artikel/neue-regeln-zum-datenschutz-bei-fitness-apps", text: "Neue Regeln: Was der Datenschutz bei Fitness-Apps jetzt verlangt", inFooter: false },
      { href: "https://e.de/artikel/mehr-privatsphaere-im-netz", text: "Mehr Privatsphäre im Netz", inFooter: false },
    ]);
    expect(r.privacy.found).toBe(false);
    expect(r.privacy.candidate).toBeUndefined();
    expect(r.imprint.found).toBe(false);
  });
  it("accepts an exact standard label alone, e.g. a Jimdo footer whose imprint links to /about/", () => {
    const r = findLegalLinks([
      { href: "https://e.de/about/", text: "Impressum", inFooter: false },
      { href: "https://e.de/j/privacy", text: "Datenschutzerklärung", inFooter: false },
    ]);
    expect(r.imprint).toMatchObject({ found: true, href: "https://e.de/about/" });
    expect(r.privacy.found).toBe(true);
  });
  it("reports only an uncertain candidate when the evidence is weak", () => {
    const r = findLegalLinks([{ href: "https://e.de/blog/tipps", text: "Datenschutz-Tipps", inFooter: false }]);
    expect(r.privacy.found).toBe(false);
    expect(r.privacy.candidate).toMatchObject({ text: "Datenschutz-Tipps" });
    expect(findingsForLegal(r)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "privacy-link-uncertain", severity: "warn" })]),
    );
  });
  it("does not call a hidden imprint link 'missing' (real case: Wix 'More' menu)", () => {
    const r = findLegalLinks([{ href: "https://e.de/impressum", text: "", inFooter: false }]);
    expect(r.imprint.found).toBe(false);
    const f = findingsForLegal(r);
    expect(f.find((x) => x.id === "imprint-link-missing")).toBeUndefined();
    expect(f.find((x) => x.id === "imprint-link-uncertain")?.message).toContain("no visible text");
  });
  it("finds a footer link by its path even with an unusual label", () => {
    const r = findLegalLinks([{ href: "https://e.de/rechtliches/impressum.html", text: "Rechtliches", inFooter: true }]);
    expect(r.imprint.found).toBe(true);
  });
});

describe("which sites get German rules", () => {
  it("uses the page language first and a .ch domain only without one", () => {
    expect(looksGermanSite("www.example.com", "de-DE")).toBe(true);
    expect(looksGermanSite("www.example.de", "en")).toBe(true);
    expect(looksGermanSite("www.example.ch", "")).toBe(true);
    expect(looksGermanSite("www.example.ch", "de-CH")).toBe(true);
    expect(looksGermanSite("www.example.ch", "fr-CH")).toBe(false);
    expect(looksGermanSite("www.example.ch", "it")).toBe(false);
    expect(looksGermanSite("www.example.com", "en")).toBe(false);
  });
  it("finds French and Italian legal links of Swiss sites", () => {
    const r = findLegalLinks([
      { href: "https://e.ch/fr/mentions-legales", text: "Mentions légales", inFooter: true },
      { href: "https://e.ch/fr/confidentialite", text: "Politique de confidentialité", inFooter: true },
    ]);
    expect(r.imprint.found).toBe(true);
    expect(r.privacy.found).toBe(true);
    const italian = findLegalLinks([
      { href: "https://e.ch/it/note-legali", text: "Note legali", inFooter: true },
      { href: "https://e.ch/it/privacy", text: "Informativa sulla privacy", inFooter: true },
    ]);
    expect(italian.imprint.found).toBe(true);
    expect(italian.privacy.found).toBe(true);
  });
  it("keeps the version in the code equal to package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
  it("counts HubSpot's cookie banner as a consent platform, not as tracking", () => {
    expect(matchRule(new URL("https://js.hs-banner.com/v2/123/banner.js"))?.category).toBe("consent-platform");
  });
});

describe("request classification details", () => {
  it("drops requests the browser blocked itself and reads the Consent Mode state from Floodlight paths", () => {
    const r = classifyRequests(
      [
        { url: "https://tracker.example/px.gif", resourceType: "image", blocked: true },
        { url: "https://ad.doubleclick.net/activity;src=1;gcs=G100;ord=1", resourceType: "image" },
      ],
      "www.shop.example",
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.consentSignal).toBe("G100");
  });
  it("marks requests made inside a third-party frame and keeps its fonts out of the site's findings", () => {
    const r = classifyRequests(
      [
        { url: "https://fonts.gstatic.com/s/roboto/a.woff2", resourceType: "font", frameUrl: "https://www.youtube-nocookie.com/embed/x" },
        { url: "https://fonts.gstatic.com/s/roboto/b.woff2", resourceType: "font", frameUrl: "https://www.shop.example/" },
      ],
      "www.shop.example",
    );
    expect(r[0]?.embeddedIn).toBe("www.youtube-nocookie.com");
    expect(r[1]?.embeddedIn).toBeUndefined();
    const embeddedOnly = findingsForRequests([r[0]!]);
    expect(embeddedOnly.find((f) => f.id === "third-party-before-consent:google-fonts")).toBeUndefined();
    expect(findingsForRequests(r).find((f) => f.id === "third-party-before-consent:google-fonts")?.message).toContain("1 request(s)");
  });
  it("finds Austrian and older German imprint wording and treats a lone Kontakt link as uncertain", () => {
    expect(findLegalLinks([{ href: "https://e.at/offenlegung", text: "Offenlegung", inFooter: true }]).imprint.found).toBe(true);
    expect(findLegalLinks([{ href: "https://e.de/ak", text: "Anbieterkennzeichnung", inFooter: true }]).imprint.found).toBe(true);
    const contact = findLegalLinks([{ href: "https://e.de/kontakt", text: "Kontakt", inFooter: true }]).imprint;
    expect(contact.found).toBe(false);
    expect(contact.candidate?.text).toBe("Kontakt");
  });
});

describe("bot-challenge pages", () => {
  const page = { url: "https://example.com/", title: "Example", markers: 0, textLength: 500, links: 5 };
  it("recognizes challenge pages by URL, title or marker, only when the page is small", () => {
    expect(looksLikeChallenge({ ...page, url: "https://www.example.com/?solution=1&js_challenge=1" })).toBe(true);
    expect(looksLikeChallenge({ ...page, title: "Just a moment..." })).toBe(true);
    expect(looksLikeChallenge({ ...page, title: "Nur einen Moment…" })).toBe(true);
    expect(looksLikeChallenge({ ...page, markers: 1 })).toBe(true);
    expect(looksLikeChallenge(page)).toBe(false);
    expect(looksLikeChallenge({ ...page, title: "Just a moment: our story", textLength: 20000, links: 80 })).toBe(false);
    expect(looksLikeChallenge({ ...page, title: "Access denied – what the court said", textLength: 5000 })).toBe(false);
  });
});

describe("consent control labels", () => {
  it("accepts clear general reject labels", () => {
    for (const l of ["Alle ablehnen", "Ablehnen", "Ablehnen und schließen", "Nur notwendige Cookies akzeptieren", "Nur notwendige", "Nur essenzielle", "Nur Essenzielle Cookies akzeptieren", "Verweigern", "Weiter ohne Zustimmung", "Reject all", "Decline", "Only necessary cookies"]) {
      expect(isRejectLabel(l), l).toBe(true);
    }
  });
  it("never lets the pre-filter hide a label the strict patterns would accept", () => {
    const labels = [
      "Alle ablehnen", "Alles ablehnen", "Ablehnen", "Alle Cookies ablehnen", "Ablehnen und schließen", "Verweigern", "Nur notwendige",
      "Nur notwendige Cookies akzeptieren", "Nur erforderliche", "Nur essenzielle", "Nur essentielle Cookies", "Nur technisch notwendige",
      "Weiter ohne Zustimmung", "Ohne Einwilligung fortfahren", "Reject all", "Decline", "Deny", "Refuse all cookies",
      "Only necessary cookies", "Necessary only", "Only essential", "Continue without accepting",
      "Alle akzeptieren", "Alles akzeptieren", "Akzeptieren", "Akzeptieren und weiter", "Einwilligen und weiter", "Zustimmen", "Annehmen", "Alle erlauben",
      "Alle zulassen", "Alle Cookies zulassen", "Ich stimme zu", "Ich akzeptiere alle", "Einverstanden", "Accept all", "Allow all cookies",
      "I agree", "Agree and continue", "Accept & close", "Akzeptieren & schließen", "Ja, ich stimme zu und akzeptiere alle.",
    ];
    for (const l of labels) {
      expect(isRejectLabel(l) || isAcceptLabel(l), `pattern should know: ${l}`).toBe(true);
      expect(CANDIDATE_LABEL.test(l), `pre-filter hides: ${l}`).toBe(true);
    }
  });
  it("does not treat single-service opt-outs or other buttons as a general reject", () => {
    for (const l of ["für Partner X jetzt ablehnen", "Einstellungen", "Jetzt abonnieren", "Datenschutz", "Mehr erfahren", "No thanks", "Ok", "Einstellungen oder Ablehnen", "Auswahl annehmen"]) {
      expect(isRejectLabel(l), l).toBe(false);
    }
    expect(isRejectLike("für Partner X jetzt ablehnen")).toBe(true);
  });
  it("accepts clear accept labels and never confuses them with reject", () => {
    for (const l of ["Alle akzeptieren", "Akzeptieren und weiter", "Einwilligen und weiter", "Ich stimme zu", "Ich akzeptiere alle", "Accept all", "Zustimmen"]) {
      expect(isAcceptLabel(l), l).toBe(true);
      expect(isRejectLabel(l), l).toBe(false);
    }
    expect(isAcceptLabel("Nur notwendige Cookies akzeptieren")).toBe(false);
  });
});

describe("report and errors", () => {
  const base: ScanResult = {
    tool: { name: "consentprobe", version: "0.0.0" },
    url: "https://e.de/",
    finalUrl: "https://e.de/",
    scannedAt: "2026-01-01T00:00:00.000Z",
    phase: "before-consent",
    requests: [],
    cookies: [],
    legal: { imprint: { found: false }, privacy: { found: false } },
    findings: [],
    summary: { error: 0, warn: 0, info: 0, thirdPartyHosts: 0 },
  };
  it("does not claim reject and accept visits when the click test was skipped", () => {
    expect(formatText(base)).toContain("click test skipped");
    expect(formatText(base)).not.toContain("then reject and accept visits");
    expect(formatMarkdown(base)).toContain("click test skipped");
  });
  it("never states 'not recognized' when the search was incomplete or an overlay was seen", () => {
    const banner = { detected: false, rejectFound: false, acceptFound: false };
    const withBanner = (b: object) => formatText({ ...base, consent: { banner: { ...banner, ...b } } });
    expect(withBanner({ incomplete: true })).toContain("Consent banner: search incomplete");
    expect(withBanner({ overlayHint: true })).toContain("controls not automatable");
    expect(withBanner({})).toContain("Consent banner: not recognized");
  });
  it("always ends with the not-legal-advice note", () => {
    expect(formatText(base)).toContain("not legal advice");
    expect(formatMarkdown(base)).toContain("not legal advice");
  });
  it("explains a missing browser in one actionable line", () => {
    const err = explainLaunchError(new Error("browserType.launch: Executable doesn't exist at /x. Please run: npx playwright install"));
    expect(err.message).toBe("No browser found. Install one with: npx playwright install chromium (or use --browser chrome).");
    expect(explainLaunchError(new Error("boom")).message).toBe("boom");
  });
});

describe("navigation errors", () => {
  const e = (m: string) => explainNavigationError(new Error(m), 45000).message;
  it("turns Playwright errors into one readable line", () => {
    expect(e("page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://x.de/\nCall log:\n  - navigating")).toBe(
      "The site's TLS certificate is not valid (ERR_CERT_COMMON_NAME_INVALID). The page was not measured.",
    );
    expect(e("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.invalid/")).toContain("does not resolve");
    expect(e("page.goto: Timeout 45000ms exceeded.\nCall log:")).toBe("The page did not respond within 45 s. Try a larger --timeout.");
    expect(e("something else\nCall log: x")).toBe("something else");
  });
});

describe("time limits", () => {
  const never = new Promise<number>(() => undefined);
  it("returns the fallback when a promise never settles", async () => {
    expect(await bounded(never, 20, () => -1)).toBe(-1);
    expect(await bounded(Promise.resolve(5), 1000, () => -1)).toBe(5);
    await expect(bounded(never, 20, () => { throw new Error("stop"); })).rejects.toThrow("stop");
  });
  it("counts timed-out page queries but not ordinary errors", async () => {
    const q = newBudget();
    expect(await ask(() => never, q, 0, undefined, 20)).toBe(0);
    expect(await ask(() => Promise.reject(new Error("x")), q, 7, undefined, 20)).toBe(7);
    expect(q.timeouts).toBe(1);
  });
  it("skips a frame after its first timeout", async () => {
    const q = newBudget();
    const frame = {};
    const started = Date.now();
    const stall = new Promise<string>(() => undefined);
    expect(await ask(() => stall, q, "a", frame, 50)).toBe("a");
    let asked = false;
    expect(await ask(() => { asked = true; return stall; }, q, "b", frame, 5000)).toBe("b");
    expect(asked).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(q.timeouts).toBe(1);
  });
});

describe("legal link check", () => {
  const ctx = (statuses: number[]) => {
    let i = 0;
    return { request: { get: async () => ({ status: () => statuses[Math.min(i++, statuses.length - 1)] ?? 0 }) } };
  };
  it("retries a transient server error and keeps the second answer", async () => {
    expect(await checkLink(ctx([502, 200]), "https://e.de/d", 30000, 1)).toBe(200);
  });
  it("reports a lasting server error as unverified, not as broken", async () => {
    expect(await checkLink(ctx([503, 503]), "https://e.de/d", 30000, 1)).toBeUndefined();
  });
  it("keeps a real 404 without retrying", async () => {
    const c = ctx([404, 200]);
    expect(await checkLink(c, "https://e.de/d", 30000, 1)).toBe(404);
  });
  it("treats a refusal of the plain HTTP client as unverified, not as broken", async () => {
    for (const s of [401, 403, 405, 451]) expect(await checkLink(ctx([s]), "https://e.de/d", 30000, 1), String(s)).toBeUndefined();
    expect(await checkLink(ctx([410]), "https://e.de/d", 30000, 1)).toBe(410);
  });
  it("recognizes hosts on the machine or the local network", () => {
    for (const h of ["localhost", "a.localhost", "intranet", "127.0.0.1", "10.1.2.3", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "[::1]", "fd00::1", "fe80::1"]) {
      expect(isLocalHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"]) expect(isLocalHost(h), h).toBe(false);
  });
});
