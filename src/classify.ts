import { getDomain } from "tldts";
import { BUILT_IN_RULES } from "./rules.js";
import type { TrackerRule } from "./types.js";

/** Registrable domain (eTLD+1); IPs and single-label hosts are their own domain. */
export function registrableDomain(host: string): string {
  return (getDomain(host) ?? host).toLowerCase();
}

/** `firstParty` lists extra domains of the site operator, e.g. its own asset CDN. */
export function isThirdParty(requestHost: string, pageHost: string, firstParty: string[] = []): boolean {
  const domain = registrableDomain(requestHost);
  if (domain === registrableDomain(pageHost)) return false;
  return !firstParty.some((d) => registrableDomain(d) === domain);
}

function hostMatches(host: string, ruleHost: string): boolean {
  const h = host.toLowerCase();
  const r = ruleHost.toLowerCase();
  return h === r || h.endsWith(`.${r}`);
}

export function matchRule(
  url: URL,
  rules: TrackerRule[] = BUILT_IN_RULES,
): TrackerRule | undefined {
  return rules.find(
    (rule) =>
      rule.hosts.some((h) => hostMatches(url.hostname, h)) &&
      (rule.pathPrefix === undefined ||
        url.pathname === rule.pathPrefix ||
        url.pathname.startsWith(`${rule.pathPrefix}/`)),
  );
}
