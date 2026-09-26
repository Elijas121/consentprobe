import { getDomain } from "tldts";
import { BUILT_IN_RULES } from "./rules.js";
import type { TrackerRule } from "./types.js";

/** Registrable domain (eTLD+1); IPs and single-label hosts are their own domain. */
export function registrableDomain(host: string): string {
  return (getDomain(host) ?? host).toLowerCase();
}

/**
 * Registrable domains that one company runs for its own services. A request from one of its sites to
 * another of its domains is no transfer to a third party (Google Fonts on youtube.com, Spotify's CDN
 * on spotify.com). Only domains the company operates for itself: hosting for customers (blogspot.com,
 * googleusercontent.com, firebaseapp.com, cloudfront.net, amazonaws.com, azurewebsites.net, github.io)
 * is deliberately absent, because there the site operator is someone else.
 */
const OPERATORS: { name: string; domain: RegExp }[] = [
  {
    name: "Google",
    domain:
      /^(google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|googlevideo\.com|gstatic\.com|googleapis\.com|ggpht\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|withgoogle\.com|gmail\.com)$/,
  },
  { name: "Microsoft", domain: /^(microsoft\.com|microsoftonline\.com|live\.com|office\.com|bing\.com|msn\.com|clarity\.ms|s-microsoft\.com|xbox\.com|skype\.com)$/ },
  { name: "Meta", domain: /^(facebook\.com|facebook\.net|fbcdn\.net|instagram\.com|cdninstagram\.com|whatsapp\.com|meta\.com)$/ },
  { name: "Amazon", domain: /^(amazon\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com|amazon-adsystem\.com)$/ },
  { name: "Apple", domain: /^(apple\.com|icloud\.com|cdn-apple\.com|mzstatic\.com)$/ },
  { name: "Spotify", domain: /^(spotify\.com|scdn\.co|spotifycdn\.com)$/ },
  { name: "Wikimedia", domain: /^(wikipedia\.org|wikimedia\.org|wikidata\.org|wiktionary\.org|mediawiki\.org|wikimediafoundation\.org)$/ },
  { name: "Automattic", domain: /^(wordpress\.org|wordpress\.com|wp\.com|w\.org|gravatar\.com)$/ },
  { name: "X", domain: /^(twitter\.com|x\.com|twimg\.com)$/ },
  { name: "TikTok", domain: /^(tiktok\.com|tiktokcdn\.com|tiktokcdn-eu\.com|ttwstatic\.com)$/ },
];

/**
 * Pages these companies host for their customers (a blog on wordpress.com, a Google Site): the site
 * operator is the customer, so the company's trackers are third parties there.
 */
const CUSTOMER_HOSTED = /^(sites\.google\.com|script\.google\.com|(?!www\.)[^.]+\.wordpress\.com|[^.]+\.blogspot\.com)$/i;

/** The company that runs both domains, if they differ but belong to the same one of the companies above. */
export function sharedOperator(requestHost: string, pageHost: string): string | undefined {
  if (CUSTOMER_HOSTED.test(pageHost)) return undefined;
  const a = registrableDomain(requestHost);
  const b = registrableDomain(pageHost);
  if (a === b) return undefined;
  return OPERATORS.find((o) => o.domain.test(a) && o.domain.test(b))?.name;
}

/** `firstParty` lists extra domains of the site operator, e.g. its own asset CDN. */
export function isThirdParty(requestHost: string, pageHost: string, firstParty: string[] = []): boolean {
  const domain = registrableDomain(requestHost);
  if (domain === registrableDomain(pageHost)) return false;
  if (sharedOperator(requestHost, pageHost)) return false;
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
