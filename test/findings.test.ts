import { describe, expect, it } from "vitest";
import { findingsForConsent, findingsForCookies, findingsForLegal, findingsForRequests } from "../src/findings.js";
import { PageNotMeasurableError } from "../src/scan.js";
import type { ConsentTest, RequestRecord } from "../src/types.js";

const req = (url: string, consentSignal?: string): RequestRecord => ({
  url,
  host: new URL(url).hostname,
  resourceType: "image",
  thirdParty: true,
  ...(consentSignal ? { consentSignal } : {}),
});

describe("Consent Mode pings before consent", () => {
  it("reports denied pings as a disputed warning, not as tracking", () => {
    const f = findingsForRequests([req("https://www.google-analytics.com/g/collect", "G100")]);
    expect(f.find((x) => x.id === "third-party-before-consent:google-analytics")).toBeUndefined();
    expect(f.find((x) => x.id === "consent-mode-ping-before-consent:google-analytics")?.severity).toBe("warn");
  });

  it("keeps the error for real requests next to denied pings", () => {
    const f = findingsForRequests([
      req("https://www.google-analytics.com/g/collect", "G100"),
      req("https://www.google-analytics.com/g/collect", "G111"),
    ]);
    const error = f.find((x) => x.id === "third-party-before-consent:google-analytics");
    expect(error?.severity).toBe("error");
    expect(error?.message).toContain("1 request(s)");
    expect(error?.message).toContain("granted");
    expect(f.find((x) => x.id === "consent-mode-ping-before-consent:google-analytics")?.severity).toBe("warn");
  });
});

describe("unknown hosts after reject", () => {
  const test = (after: RequestRecord[]): ConsentTest => ({
    banner: { detected: true, rejectFound: true, acceptFound: true },
    reject: { action: "reject", clicked: true, requestsAfter: after, cookiesBefore: [], cookiesAfter: [] },
  });

  it("lists a host that appears only after the reject click as info", () => {
    const f = findingsForConsent(test([req("https://widget.unknown.example/a.js")]), []);
    const info = f.find((x) => x.id === "unclassified-third-party-after-reject");
    expect(info?.severity).toBe("info");
    expect(info?.evidence).toEqual(["widget.unknown.example (1)"]);
  });

  it("ignores hosts already contacted before consent and hosts of known services", () => {
    const f = findingsForConsent(
      test([req("https://cdn.unknown.example/a.js"), req("https://cdnjs.cloudflare.com/x.js")]),
      [req("https://cdn.unknown.example/b.js")],
    );
    expect(f.find((x) => x.id === "unclassified-third-party-after-reject")).toBeUndefined();
  });
});

describe("privacy link outside German rules", () => {
  const missing = { imprint: { found: false }, privacy: { found: false } };

  it("is an error on German-language sites", () => {
    const f = findingsForLegal(missing, "check", true);
    expect(f.find((x) => x.id === "privacy-link-missing")?.severity).toBe("error");
  });

  it("is a warning elsewhere, and the imprint check stays skipped", () => {
    const f = findingsForLegal(missing, "skipped-auto", false);
    expect(f.find((x) => x.id === "privacy-link-missing")?.severity).toBe("warn");
    expect(f.find((x) => x.id === "imprint-link-missing")).toBeUndefined();
    expect(f.find((x) => x.id === "imprint-check-skipped")?.severity).toBe("info");
  });

  it("treats a broken privacy link the same way", () => {
    const broken = { imprint: { found: false }, privacy: { found: true, href: "https://e.example/p", status: 404 } };
    expect(findingsForLegal(broken, "off", false).find((x) => x.id === "privacy-link-unreachable")?.severity).toBe("warn");
    expect(findingsForLegal(broken, "off", true).find((x) => x.id === "privacy-link-unreachable")?.severity).toBe("error");
  });
});

describe("report details", () => {
  it("names the cookie lifetime without repeating the cookie name", () => {
    const f = findingsForCookies([
      { name: "session", domain: "example.com", thirdParty: false, expires: null },
      { name: "prefs", domain: "example.com", thirdParty: false, expires: 1900000000 },
    ]);
    expect(f.find((x) => x.id === "first-party-cookies-before-consent")?.evidence).toEqual([
      "session (example.com, session cookie)",
      "prefs (example.com, persistent)",
    ]);
  });

  it("explains error pages by status", () => {
    expect(new PageNotMeasurableError(404).message).toMatch(/not found/);
    expect(new PageNotMeasurableError(403).message).toMatch(/refused the automated browser/);
    expect(new PageNotMeasurableError(503).message).toMatch(/server answered with an error/);
    expect(new PageNotMeasurableError(418).message).toMatch(/HTTP 418/);
  });
});

describe("clicks that could not be tested", () => {
  it("says so when the other visit saw the control", () => {
    const f = findingsForConsent(
      {
        banner: { detected: true, rejectFound: true, acceptFound: true },
        reject: { action: "reject", clicked: false, requestsAfter: [], cookiesBefore: [], cookiesAfter: [] },
        accept: { action: "accept", clicked: true, control: { label: "Alle akzeptieren", method: "text" }, requestsAfter: [], cookiesBefore: [], cookiesAfter: [] },
      },
      [],
    );
    expect(f.find((x) => x.id === "consent-reject-not-tested")?.severity).toBe("info");
    expect(f.find((x) => x.id === "consent-accept-not-tested")).toBeUndefined();
  });
});
