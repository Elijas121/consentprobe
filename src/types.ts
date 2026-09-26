export type Severity = "error" | "warn" | "info";

export type Category =
  | "analytics"
  | "advertising"
  | "tag-manager"
  | "social"
  | "fonts"
  | "maps"
  | "video"
  | "chat"
  | "cdn"
  | "captcha"
  | "consent-platform";

/** A known third-party service, matched by hostname (and optionally path prefix). */
export interface TrackerRule {
  id: string;
  name: string;
  category: Category;
  /** Hostnames; a request matches if its host equals one of these or is a subdomain. */
  hosts: string[];
  pathPrefix?: string;
  /** Overrides the category's severity, e.g. for analytics that stores nothing on the device. */
  severity?: Severity;
  /** Overrides the category's explanation in the finding. */
  hint?: string;
}

export interface RequestRecord {
  /** URL without query string or fragment (may carry personal data). */
  url: string;
  host: string;
  resourceType: string;
  thirdParty: boolean;
  /** Another domain of the same company as the site (e.g. "Google" for gstatic.com on youtube.com): not counted as third party. */
  sameOperator?: string;
  /** Host of the third-party frame that made the request (e.g. an embedded video player), not the site itself. */
  embeddedIn?: string;
  /**
   * Google Consent Mode state sent with the request (the `gcs` parameter, e.g. "G100" = ad and
   * analytics storage denied). Kept on its own because the query string is otherwise dropped.
   */
  consentSignal?: string;
}

export interface CookieRecord {
  name: string;
  domain: string;
  thirdParty: boolean;
  /** Seconds since epoch, or null for a session cookie. */
  expires: number | null;
  /** Short hash of the value, used only to tell whether a cookie changed; the value itself is never stored. */
  valueHash?: string;
}

export interface LegalLink {
  found: boolean;
  /** Weak match (not confident enough to count as found), shown so a human can check. */
  candidate?: { href: string; text: string };
  href?: string;
  text?: string;
  inFooter?: boolean;
  status?: number;
  /** Found as a clickable element without href; its target could not be checked. */
  scripted?: boolean;
}

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  evidence: string[];
}

export interface ConsentControl {
  label: string;
  method: "cmp-selector" | "text";
}

export interface ConsentBanner {
  detected: boolean;
  /** Name of the recognized consent platform, when a known one was matched. */
  cmp?: string;
  rejectFound: boolean;
  acceptFound: boolean;
  /** A reject-like label that was not treated as a general reject, so it was not clicked. */
  rejectLike?: string;
  /** No control was recognized, but a visible overlay mentions cookies (controls not automatable). */
  overlayHint?: boolean;
  /** Parts of the page did not respond during detection, so "not found" is not reliable. */
  incomplete?: boolean;
  /** An accept control was found, but parts of the page did not respond while searching for a reject control. */
  rejectSearchIncomplete?: boolean;
}

/** One visit in which the visitor clicked the reject or the accept control. */
export interface ConsentSession {
  action: "reject" | "accept";
  clicked: boolean;
  control?: ConsentControl;
  /** Only requests made after the click. */
  requestsAfter: RequestRecord[];
  /** Cookies right before the click, to tell new cookies from ones that were already there. */
  cookiesBefore: CookieRecord[];
  cookiesAfter: CookieRecord[];
  error?: string;
}

export interface ConsentTest {
  banner: ConsentBanner;
  reject?: ConsentSession;
  accept?: ConsentSession;
}

export interface ScanOptions {
  /** Extra time to wait after the page settled, for lazily loaded scripts. */
  settleMs?: number;
  timeoutMs?: number;
  browser?: "chromium" | "chrome";
  extraRules?: TrackerRule[];
  /** Also click reject and accept in separate visits and compare (default true). */
  clickTest?: boolean;
  /** How long to wait for a consent banner to appear (default 4000). */
  bannerWaitMs?: number;
  /** Extra domains that belong to the site operator (own CDNs), so they count as first party. */
  firstParty?: string[];
  /** Directory for evidence screenshots (baseline, and before/after each click). */
  screenshotDir?: string;
  /** Check for an imprint link: "auto" only on German-language or .de/.at/.ch sites (default). */
  imprint?: "auto" | "always" | "never";
}

export interface ScanResult {
  tool: { name: "consentprobe"; version: string };
  url: string;
  finalUrl: string;
  scannedAt: string;
  /** No interaction with any cookie banner happened during this phase. */
  phase: "before-consent";
  requests: RequestRecord[];
  cookies: CookieRecord[];
  legal: { imprint: LegalLink; privacy: LegalLink };
  consent?: ConsentTest;
  findings: Finding[];
  summary: { error: number; warn: number; info: number; thirdPartyHosts: number };
}
