import { createHash } from "node:crypto";
import { isThirdParty, matchRule } from "./classify.js";
import {
  BUILT_IN_RULES,
  CATEGORY_HINT,
  CATEGORY_SEVERITY,
  CONSENT_COOKIE_PATTERNS,
  INFRA_COOKIE_PATTERNS,
  TRACKER_COOKIE_PATTERNS,
} from "./rules.js";
import type {
  Category,
  ConsentTest,
  CookieRecord,
  Finding,
  LegalLink,
  RequestRecord,
  Severity,
  TrackerRule,
} from "./types.js";

const MAX_EVIDENCE = 5;

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function findingsForRequests(
  requests: RequestRecord[],
  rules: TrackerRule[] = BUILT_IN_RULES,
): Finding[] {
  const findings: Finding[] = [];
  const byRule = new Map<string, { rule: TrackerRule; urls: string[]; reqs: RequestRecord[] }>();
  const unclassified = new Map<string, number>();

  for (const req of requests) {
    if (!req.thirdParty) continue;
    const rule = matchRule(new URL(req.url), rules);
    if (rule) {
      const entry = byRule.get(rule.id) ?? { rule, urls: [], reqs: [] };
      entry.urls.push(req.url);
      entry.reqs.push(req);
      byRule.set(rule.id, entry);
    } else {
      unclassified.set(req.host, (unclassified.get(req.host) ?? 0) + 1);
    }
  }

  for (const { rule, reqs } of byRule.values()) {
    // Google's Consent Mode "denied" pings are judged like after a reject: a separate, disputed warning.
    const pings = reqs.filter(isDeniedPing);
    const other = reqs.filter((r) => !isDeniedPing(r));
    const granted = other.filter((r) => r.consentSignal !== undefined);
    if (other.length > 0) {
      const note =
        granted.length > 0
          ? ` ${granted.length} request(s) signal consent as granted before the banner was answered (${uniq(granted.map((r) => r.consentSignal ?? "")).join(", ")}).`
          : "";
      findings.push({
        id: `third-party-before-consent:${rule.id}`,
        severity: CATEGORY_SEVERITY[rule.category],
        message: `${rule.name} (${rule.category}): ${other.length} request(s) before any consent interaction. ${CATEGORY_HINT[rule.category]}${note}`,
        evidence: uniq(other.map((r) => (r.consentSignal ? `${r.url} [gcs=${r.consentSignal}]` : r.url))).slice(0, MAX_EVIDENCE),
      });
    }
    if (pings.length > 0) {
      findings.push({
        id: `consent-mode-ping-before-consent:${rule.id}`,
        severity: "warn",
        message: `${rule.name}: ${pings.length} request(s) before any consent interaction carry ${describeConsentSignal("G100")}. These are Google's cookieless "denied" pings; they still send data such as the IP address to Google. Whether that is acceptable without consent is disputed; decide deliberately.`,
        evidence: uniq(pings.map((r) => `${r.url} [gcs=G100]`)).slice(0, MAX_EVIDENCE),
      });
    }
  }

  if (unclassified.size > 0) {
    findings.push({
      id: "unclassified-third-party",
      severity: "info",
      message: `${unclassified.size} third-party host(s) are not in the built-in list. Review them manually.`,
      evidence: [...unclassified.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_EVIDENCE * 2)
        .map(([host, n]) => `${host} (${n})`),
    });
  }
  return findings;
}

export function findingsForCookies(cookies: CookieRecord[]): Finding[] {
  const findings: Finding[] = [];
  const trackerByService = new Map<string, string[]>();
  const thirdParty: string[] = [];
  const other: string[] = [];
  const consentPlatforms = new Set<string>();
  const infra: string[] = [];

  for (const c of cookies) {
    const label = `${c.name} (${c.domain})`;
    const cmp = CONSENT_COOKIE_PATTERNS.find((p) => p.pattern.test(c.name));
    if (cmp) {
      consentPlatforms.add(cmp.name);
      continue;
    }
    if (INFRA_COOKIE_PATTERNS.some((p) => p.test(c.name))) {
      infra.push(label);
      continue;
    }
    const known = TRACKER_COOKIE_PATTERNS.find((p) => p.pattern.test(c.name));
    if (known) {
      trackerByService.set(known.name, [...(trackerByService.get(known.name) ?? []), label]);
    } else if (c.thirdParty) {
      thirdParty.push(label);
    } else {
      other.push(`${c.name} (${c.domain}, ${c.expires === null ? "session cookie" : "persistent"})`);
    }
  }

  for (const [service, labels] of trackerByService) {
    findings.push({
      id: `tracker-cookie-before-consent:${service.toLowerCase().replace(/\s+/g, "-")}`,
      severity: "error",
      message: `${service} cookie(s) present before any consent interaction.`,
      evidence: labels.slice(0, MAX_EVIDENCE),
    });
  }
  if (infra.length > 0) {
    findings.push({
      id: "infrastructure-cookies-before-consent",
      severity: "info",
      message: `${infra.length} cookie(s) that look like bot protection or load balancing (Cloudflare). They are usually technically necessary.`,
      evidence: infra.slice(0, MAX_EVIDENCE),
    });
  }
  if (consentPlatforms.size > 0) {
    findings.push({
      id: "consent-management-detected",
      severity: "info",
      message: `Consent-management cookie(s) recognized: ${[...consentPlatforms].join(", ")}.`,
      evidence: [],
    });
  }
  if (thirdParty.length > 0) {
    findings.push({
      id: "third-party-cookie-before-consent",
      severity: "warn",
      message: `${thirdParty.length} third-party cookie(s) present before any consent interaction.`,
      evidence: thirdParty.slice(0, MAX_EVIDENCE),
    });
  }
  if (other.length > 0) {
    findings.push({
      id: "first-party-cookies-before-consent",
      severity: "info",
      message: `${other.length} first-party cookie(s) present before any consent interaction. They may be technically necessary; check their purpose.`,
      evidence: other.slice(0, MAX_EVIDENCE),
    });
  }
  return findings;
}

/** "check" runs the imprint check, "skipped-auto" notes that auto mode skipped it, "off" says nothing. */
export type ImprintMode = "check" | "skipped-auto" | "off";

/**
 * `germanRules` is true for German-language or .de/.at/.ch sites (or when forced). There a missing
 * or broken privacy link is an error; elsewhere it is a warning, because the tool's rules are German.
 */
export function findingsForLegal(
  legal: { imprint: LegalLink; privacy: LegalLink },
  imprintMode: ImprintMode = "check",
  germanRules = true,
): Finding[] {
  const findings: Finding[] = [];
  const checks = [
    { key: "imprint", label: "imprint (Impressum)", link: legal.imprint },
    { key: "privacy", label: "privacy policy (Datenschutzerklärung)", link: legal.privacy },
  ] as const;
  const checkImprint = imprintMode === "check";
  if (imprintMode === "skipped-auto") {
    findings.push({
      id: "imprint-check-skipped",
      severity: "info",
      message: "The imprint check was skipped because the site does not look German-language. Use --imprint always to force it.",
      evidence: [],
    });
  }

  for (const { key, label, link } of checks) {
    if (key === "imprint" && !checkImprint) continue;
    const hard: Severity = key === "privacy" && !germanRules ? "warn" : "error";
    if (!link.found && link.candidate) {
      findings.push({
        id: `${key}-link-uncertain`,
        severity: "warn",
        message: link.candidate.text
          ? `No confident match for the ${label} link. Closest candidate: "${link.candidate.text}". Check it manually.`
          : `A link to the ${label} exists but has no visible text (it may sit in a collapsed or hidden menu). Check that visitors can find it.`,
        evidence: [link.candidate.href],
      });
      continue;
    }
    if (!link.found) {
      findings.push({
        id: `${key}-link-missing`,
        severity: hard,
        message: `No link to the ${label} found on this page.`,
        evidence: [],
      });
      continue;
    }
    if (link.status !== undefined && link.status >= 400) {
      findings.push({
        id: `${key}-link-unreachable`,
        severity: hard,
        message: `The ${label} link does not resolve (HTTP ${link.status}).`,
        evidence: link.href ? [link.href] : [],
      });
    } else if (link.status === undefined) {
      findings.push({
        id: `${key}-link-unverified`,
        severity: "info",
        message: link.scripted
          ? `The ${label} link is a scripted element without a URL ("${link.text ?? ""}"), so its target could not be checked.`
          : `The ${label} link could not be checked (no response, possibly a timeout or bot protection).`,
        evidence: link.href ? [link.href] : [],
      });
    }
    if (link.inFooter === false) {
      findings.push({
        id: `${key}-link-not-in-footer`,
        severity: "info",
        message: `The ${label} link is not inside a <footer>. Verify that it is easy to find.`,
        evidence: link.href ? [link.href] : [],
      });
    }
  }
  return findings;
}

export function classifyRequests(
  raw: { url: string; resourceType: string }[],
  pageHost: string,
  firstParty: string[] = [],
): RequestRecord[] {
  const out: RequestRecord[] = [];
  for (const r of raw) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const gcs = u.searchParams.get("gcs");
    out.push({
      url: `${u.origin}${u.pathname}`,
      host: u.hostname,
      resourceType: r.resourceType,
      thirdParty: isThirdParty(u.hostname, pageHost, firstParty),
      ...(gcs && /^G1[01]{2}$/.test(gcs) ? { consentSignal: gcs } : {}),
    });
  }
  return out;
}

export function classifyCookies(
  raw: { name: string; domain: string; expires: number; value?: string }[],
  pageHost: string,
  firstParty: string[] = [],
): CookieRecord[] {
  return raw.map((c) => {
    const domain = c.domain.replace(/^\./, "");
    return {
      name: c.name,
      domain,
      thirdParty: isThirdParty(domain, pageHost, firstParty),
      expires: c.expires > 0 ? c.expires : null,
      ...(c.value !== undefined ? { valueHash: createHash("sha256").update(c.value).digest("hex").slice(0, 12) } : {}),
    };
  });
}

/** "G100": ad_storage and analytics_storage denied. Second digit = ads, third = analytics. */
export function describeConsentSignal(gcs: string): string {
  const flag = (c: string | undefined) => (c === "1" ? "granted" : "denied");
  return `Google Consent Mode gcs=${gcs} (ad storage ${flag(gcs[2])}, analytics storage ${flag(gcs[3])})`;
}

const isDeniedPing = (r: RequestRecord) => r.consentSignal === "G100";

/**
 * Categories that should stay quiet once the visitor has rejected. Fonts, CDNs and
 * bot protection are excluded: they are not consent-mediated on most sites and the
 * before-consent findings already cover them.
 */
const AFTER_REJECT: Partial<Record<Category, "error" | "warn">> = {
  analytics: "error",
  advertising: "error",
  "tag-manager": "warn",
  social: "warn",
  chat: "warn",
  maps: "warn",
  video: "warn",
};

export function findingsForConsent(
  test: ConsentTest,
  baseline: RequestRecord[],
  rules: TrackerRule[] = BUILT_IN_RULES,
): Finding[] {
  const findings: Finding[] = [];
  const { banner, reject, accept } = test;

  if (!banner.detected && banner.incomplete) {
    return [
      {
        id: "consent-detection-incomplete",
        severity: "info",
        message:
          "Parts of the page did not respond while the banner was searched, so reject and accept could not be tested. This is not reported as 'no banner'.",
        evidence: [],
      },
    ];
  }
  if (!banner.detected && banner.overlayHint) {
    return [
      {
        id: "consent-overlay-not-automatable",
        severity: "info",
        message:
          "A cookie-related overlay is visible, but its controls were not recognized as a general reject or accept, so those were not tested. Check the screenshots.",
        evidence: [],
      },
    ];
  }
  if (!banner.detected) {
    return [
      {
        id: "no-consent-banner-detected",
        severity: "info",
        message:
          "No consent banner was recognized, so reject and accept were not tested. If the page has one, it was not found automatically.",
        evidence: [],
      },
    ];
  }

  if (banner.acceptFound && !banner.rejectFound) {
    findings.push({
      id: "no-reject-control-on-first-layer",
      severity: "warn",
      message:
        "An accept control was found but no general reject control on the first banner layer. Check whether rejecting needs extra steps.",
      evidence: banner.rejectLike
        ? [`reject-like control, not treated as a general reject: "${banner.rejectLike}"`]
        : [],
    });
  }

  for (const [session, found] of [[reject, banner.rejectFound], [accept, banner.acceptFound]] as const) {
    if (found && session && !session.control && !session.error) {
      findings.push({
        id: `consent-${session.action}-not-tested`,
        severity: "info",
        message: `The ${session.action} control was recognized in one visit but did not appear in the ${session.action} visit (it may render late), so ${session.action} was not tested.`,
        evidence: [],
      });
    }
  }

  for (const session of [reject, accept]) {
    if (session?.error) {
      findings.push({
        id: `consent-${session.action}-click-failed`,
        severity: "info",
        message: `The ${session.action} control was found but could not be clicked (${session.error}).`,
        evidence: session.control ? [session.control.label] : [],
      });
    }
  }

  if (reject?.clicked) {
    const byRule = new Map<string, { rule: TrackerRule; reqs: RequestRecord[] }>();
    for (const req of reject.requestsAfter) {
      if (!req.thirdParty) continue;
      const rule = matchRule(new URL(req.url), rules);
      if (!rule || !AFTER_REJECT[rule.category]) continue;
      const entry = byRule.get(rule.id) ?? { rule, reqs: [] };
      entry.reqs.push(req);
      byRule.set(rule.id, entry);
    }
    for (const { rule, reqs } of byRule.values()) {
      const pings = reqs.filter(isDeniedPing);
      const other = reqs.filter((r) => !isDeniedPing(r));
      const granted = other.filter((r) => r.consentSignal !== undefined);
      if (other.length > 0) {
        findings.push({
          id: `third-party-after-reject:${rule.id}`,
          severity: AFTER_REJECT[rule.category] ?? "warn",
          message:
            `${rule.name} (${rule.category}): ${other.length} request(s) after the reject control was clicked.` +
            (granted.length > 0 ? ` ${granted.length} of them signal consent as granted (${uniq(granted.map((r) => r.consentSignal ?? "")).join(", ")}).` : ""),
          evidence: uniq(other.map((r) => (r.consentSignal ? `${r.url} [gcs=${r.consentSignal}]` : r.url))).slice(0, MAX_EVIDENCE),
        });
      }
      if (pings.length > 0) {
        findings.push({
          id: `consent-mode-ping-after-reject:${rule.id}`,
          severity: "warn",
          message: `${rule.name}: ${pings.length} request(s) after reject carry ${describeConsentSignal("G100")}. These are Google's cookieless "denied" pings; they still send data such as the IP address to Google. Whether that is acceptable after a reject is disputed; decide deliberately.`,
          evidence: uniq(pings.map((r) => `${r.url} [gcs=G100]`)).slice(0, MAX_EVIDENCE),
        });
      }
    }

    // Unknown hosts are not accused of tracking, but a host that appears only after the reject click is
    // worth a look. Hosts already contacted before consent are covered by the baseline findings.
    const baselineHosts = new Set(baseline.filter((r) => r.thirdParty).map((r) => r.host));
    const newUnknown = new Map<string, number>();
    for (const req of reject.requestsAfter) {
      if (!req.thirdParty || baselineHosts.has(req.host) || matchRule(new URL(req.url), rules)) continue;
      newUnknown.set(req.host, (newUnknown.get(req.host) ?? 0) + 1);
    }
    if (newUnknown.size > 0) {
      findings.push({
        id: "unclassified-third-party-after-reject",
        severity: "info",
        message: `${newUnknown.size} third-party host(s) that are not in the built-in list were contacted only after the reject control was clicked. Check what they are.`,
        evidence: [...newUnknown.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_EVIDENCE * 2)
          .map(([host, n]) => `${host} (${n})`),
      });
    }

    const before = new Map(reject.cookiesBefore.map((c) => [`${c.name}|${c.domain}`, c.valueHash]));
    const changed = reject.cookiesAfter.filter((c) => {
      const key = `${c.name}|${c.domain}`;
      return !before.has(key) || (c.valueHash !== undefined && before.get(key) !== c.valueHash);
    });
    const kept = reject.cookiesAfter.filter((c) => !changed.includes(c));
    for (const f of findingsForCookies(changed)) {
      if (f.id.startsWith("tracker-cookie-before-consent:")) {
        findings.push({
          ...f,
          id: f.id.replace("before-consent", "after-reject"),
          message: f.message.replace("present before any consent interaction", "set or changed after the reject control was clicked"),
        });
      }
    }
    const keptTrackers = findingsForCookies(kept).filter((f) => f.id.startsWith("tracker-cookie-before-consent:"));
    if (keptTrackers.length > 0) {
      findings.push({
        id: "tracker-cookies-not-removed-after-reject",
        severity: "info",
        message:
          "Tracker cookies set before the banner was answered are still present, unchanged, after reject (not removed). The before-consent findings already cover them.",
        evidence: keptTrackers.flatMap((f) => f.evidence).slice(0, MAX_EVIDENCE),
      });
    }
  }

  if (accept?.clicked) {
    const seen = new Set(
      baseline.filter((r) => r.thirdParty).map((r) => matchRule(new URL(r.url), rules)?.id ?? r.host),
    );
    const added = new Map<string, string>();
    const unknownHosts = new Set<string>();
    for (const req of accept.requestsAfter) {
      if (!req.thirdParty) continue;
      const rule = matchRule(new URL(req.url), rules);
      const key = rule?.id ?? req.host;
      if (seen.has(key)) continue;
      if (rule) added.set(key, rule.name);
      else unknownHosts.add(req.host);
    }
    if (added.size > 0 || unknownHosts.size > 0) {
      const known = added.size > 0 ? `${added.size} known service(s) (${[...added.values()].slice(0, 8).join(", ")})` : "no known service";
      findings.push({
        id: "consent-unlocks",
        severity: "info",
        message: `Accepting loaded ${known} and ${unknownHosts.size} further unclassified third-party host(s).`,
        evidence: [],
      });
    }
  }
  return findings;
}
