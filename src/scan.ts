import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { locateControls, runConsentSession, type SessionOptions } from "./consent.js";
import { bounded, newBudget } from "./bounded.js";
import { applyIdentity, visitorContextOptions, visitorIdentity, type HttpCredentials, type VisitorIdentity } from "./identity.js";
import { explainNavigationError, openPage } from "./navigate.js";
import { BUILT_IN_RULES } from "./rules.js";
import {
  classifyCookies,
  classifyRequests,
  findingsForConsent,
  findingsForCookies,
  findingsForLegal,
  findingsForRequests,
  type ImprintMode,
} from "./findings.js";
import { EXACT_LEGAL_LABELS, findLegalLinks, type RawAnchor } from "./legal.js";
import { recordRequests, type RawRequest } from "./record.js";
import { PLAYWRIGHT_VERSION, VERSION } from "./version.js";
import type {
  ConsentBanner,
  ConsentSession,
  ConsentTest,
  LegalLink,
  ScanOptions,
  ScanResult,
} from "./types.js";

/** The page's own scripts froze the browser, so nothing can be measured reliably. */
export class PageUnresponsiveError extends Error {
  constructor() {
    super("The page stopped responding while it was measured (its scripts blocked the browser). No reliable measurement is possible.");
    this.name = "PageUnresponsiveError";
  }
}

/**
 * The site answered with a bot check (HTTP 200, but a "just a moment" or verification page) instead
 * of its content. Measuring that page would describe the bot check, not the site.
 */
export class PageChallengedError extends Error {
  constructor() {
    super("The site answered with a bot check instead of its content (a challenge page). No reliable measurement is possible.");
    this.name = "PageChallengedError";
  }
}

/**
 * True for a page that is only a bot check: a challenge marker in the URL, the title or the DOM,
 * on a page with little content. A login form with an embedded captcha on a normal page is not one.
 */
export function looksLikeChallenge(p: { url: string; title: string; markers: number; textLength: number; links: number }): boolean {
  const small = p.textLength < 3000 && p.links < 30;
  const url = /[?&](js_challenge|__cf_chl_[a-z_]*|cf_chl_[a-z_]*)=/i.test(p.url);
  // Only the titles of the bot-check vendors themselves; generic words ("Security check") also title normal small pages.
  const title = /^(just a moment|nur einen moment|attention required! \| cloudflare|pardon our interruption|verify you are (a )?human|are you a robot|checking your browser|ddos-guard)/i.test(p.title.trim());
  return small && (url || title || p.markers > 0);
}

function describeStatus(status: number): string {
  if (status === 404 || status === 410) return `The page was not found (HTTP ${status}). Check the URL.`;
  if (status === 401) {
    return "The page asks for a login (HTTP 401). For a password-protected test site, put the credentials into the URL (https://user:password@host/); they are used for the visit and left out of the report.";
  }
  if (status === 403 || status === 429) {
    return `The site refused the automated browser (HTTP ${status}, usually bot protection or rate limiting). No reliable measurement is possible.`;
  }
  if (status >= 500) return `The server answered with an error (HTTP ${status}). Try again later.`;
  return `The page answered HTTP ${status}, so it shows an error page and no reliable measurement is possible.`;
}

/**
 * German rules apply: the page language is German, or the domain is German-speaking. A .ch domain
 * alone says little (Swiss sites are also French or Italian), so it counts only without a page language.
 */
export function looksGermanSite(host: string, pageLang: string): boolean {
  const lang = pageLang.toLowerCase();
  return lang.startsWith("de") || /\.(de|at|li)$/.test(host) || (/\.ch$/.test(host) && lang === "");
}

/** The page answered with an error status, so any measurement would describe the error page. */
export class PageNotMeasurableError extends Error {
  constructor(public readonly status: number) {
    super(describeStatus(status));
    this.name = "PageNotMeasurableError";
  }
}

/** Turn Playwright's long "browser missing" error into one actionable line. */
export function explainLaunchError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/distribution '?chrome'? is not found|chrome.*not found at/i.test(message)) {
    return new Error("Google Chrome is not installed. Install it, or leave out --browser chrome to use the bundled Chromium (install it once with: consentprobe --install-browser).");
  }
  if (/missing dependencies|shared libraries|install-deps|--with-deps/i.test(message)) {
    return new Error("Chromium could not start because system libraries are missing. On Linux run once, with root rights: consentprobe --install-browser --with-deps");
  }
  if (/executable doesn't exist/i.test(message)) {
    return new Error("The bundled Chromium is not installed yet. Install it once with: consentprobe --install-browser");
  }
  return err instanceof Error ? err : new Error(message);
}

/** Statuses that say "try again later", not "this page does not exist". */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Statuses that prove the page is gone. Everything else above 400 (401, 403, 405, 451 …) usually
 * means the server refused this plain HTTP client, not the visitor, so the link stays unverified.
 */
const GONE = new Set([404, 410]);

/**
 * True for hosts on the machine or the local network (localhost, private and link-local IPs). A page
 * must not make consentprobe request those, e.g. a cloud metadata address in a CI runner.
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || !h.includes(".") && !h.includes(":")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === "::" || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:");
}

/**
 * HTTP status of a legal page. A transient status gets one retry; if it stays transient the link
 * counts as unverified (undefined), because a short server hiccup must not become "link broken".
 * Refusals (401, 403 …) are unverified too: only 404 and 410, or a success, are reported.
 * Redirects are followed by hand, so a page cannot bounce the check into the local network. Only the
 * hostname in `localHost` (the host of a site the user typed as local, e.g. a dev server) is exempt;
 * every other local address stays blocked, also on a later hop.
 */
export async function checkLink(
  context: {
    request: {
      get: (url: string, o: { timeout: number; failOnStatusCode: boolean; maxRedirects: number }) => Promise<{ status(): number; headers(): Record<string, string> }>;
    };
  },
  href: string,
  timeoutMs: number,
  retryDelayMs = 1500,
  localHost?: string,
): Promise<number | undefined> {
  const get = async (): Promise<number | undefined> => {
    let target = href;
    for (let hop = 0; hop <= 5; hop += 1) {
      const host = new URL(target).hostname;
      if (isLocalHost(host) && host !== localHost) return undefined;
      const r = await context.request
        .get(target, { timeout: Math.min(timeoutMs, 20000), failOnStatusCode: false, maxRedirects: 0 })
        .catch(() => undefined);
      if (!r) return undefined;
      const status = r.status();
      const location = r.headers().location;
      if (status < 300 || status >= 400 || !location) return status;
      try {
        target = new URL(location, target).href;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  let status = await get();
  if (status !== undefined && TRANSIENT.has(status)) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    status = await get();
  }
  if (status === undefined || TRANSIENT.has(status)) return undefined;
  return status < 400 || GONE.has(status) ? status : undefined;
}

const DEFAULTS = { settleMs: 3000, timeoutMs: 30000, bannerWaitMs: 4000 };

type Baseline = Pick<ScanResult, "finalUrl" | "requests" | "cookies" | "legal"> & { lang: string; consentWall: boolean };

/**
 * Some sites answer a first visit with a redirect to a separate consent page (a "consent wall",
 * e.g. /consent-management/ or consent.example.com). Measured naively, that page lacks the site's
 * footer and would produce false "no imprint" findings.
 */
export function isConsentWallRedirect(requested: string, final: string): boolean {
  const a = new URL(requested);
  const b = new URL(final);
  if (a.host === b.host && a.pathname === b.pathname) return false;
  return /(^|[.-])(consent|cookie-?consent|cookiewall|privacy-?gate)([.-]|$)/i.test(b.hostname) ||
    /\/(consent|consent-management|cookie-?consent|cookiewall|cookie-wall|privacy-?gate)(\/|$)/i.test(b.pathname);
}

/** Visit the page without touching any banner: this is the "before consent" state. */
async function runBaseline(
  browser: Browser,
  url: string,
  timeoutMs: number,
  settleMs: number,
  firstParty: string[],
  screenshotDir?: string,
  identity?: VisitorIdentity,
  bannerWaitMs = 0,
  httpCredentials?: HttpCredentials,
): Promise<Baseline> {
  // A fresh context has no cookies or storage: it behaves like a first-time visitor.
  const context = await browser.newContext(visitorContextOptions(identity, httpCredentials));
  try {
    const page = await context.newPage();
    await applyIdentity(page, identity);
    page.setDefaultTimeout(Math.min(timeoutMs, 10000));
    const rawRequests: RawRequest[] = [];
    recordRequests(page, rawRequests);

    const response = await openPage(page, url, timeoutMs).catch((err: unknown) => {
      throw explainNavigationError(err, timeoutMs);
    });
    if (response && response.status() >= 400) throw new PageNotMeasurableError(response.status());
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    if (screenshotDir) {
      // Neutral evidence: the page as a first-time visitor sees it, before any detection or click.
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, "baseline.png"), timeout: 10000 }).catch(() => undefined);
    }

    const probe = await bounded(
      page.evaluate(() => ({
        title: document.title,
        // Only visible markers: bot protection also puts hidden device checks on ordinary pages.
        markers: Array.from(
          document.querySelectorAll(
            "form#challenge-form[action*='__cf_chl'], #challenge-running, #cf-challenge-running, .cf-browser-verification, #px-captcha, iframe[src*='captcha-delivery.com']",
          ),
        ).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        }).length,
        textLength: (document.body?.innerText || "").length,
        links: document.querySelectorAll("a[href]").length,
      })),
      5000,
      () => ({ title: "", markers: 0, textLength: 10000, links: 100 }),
    );
    if (looksLikeChallenge({ url: page.url(), ...probe })) throw new PageChallengedError();

    const finalUrl = page.url();
    const pageHost = new URL(finalUrl).hostname;
    const consentWall = isConsentWallRedirect(url, finalUrl);

    const anchors: RawAnchor[] = await bounded(page.evaluate((exactLabels: string[]) =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => ({
        href: a.href,
        // innerText is empty for footers that render lazily (content-visibility); a link that takes up
        // space is visible to visitors, so its textContent counts. A link with no box stays unlabeled.
        text: (
          a.innerText ||
          (a.getBoundingClientRect().height > 0 ? (a.textContent || "").replace(/\s+/g, " ") : "") ||
          a.getAttribute("aria-label") ||
          a.title ||
          ""
        ).trim().slice(0, 120),
        inFooter:
          a.closest("footer, [role='contentinfo'], [id*='footer' i], [class*='footer' i]") !== null ||
          a.getBoundingClientRect().top + window.scrollY > document.documentElement.scrollHeight * 0.75,
      })).concat(
        // Page builders sometimes render footer items as clickable headings whose URL lives in a
        // script. Only short, visible, clickable elements with a standard legal label are kept.
        Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((el) => {
            if (el.closest("a[href]")) return false;
            const text = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (!text || text.length > 40) return false;
            const label = text.replace(/[.:]+$/, "");
            if (!exactLabels.some((source) => new RegExp(source, "iu").test(label))) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const role = el.getAttribute("role");
            return el.hasAttribute("onclick") || el.hasAttribute("tabindex") || role === "link" || role === "button" || getComputedStyle(el).cursor === "pointer";
          })
          .map((el) => ({
            href: "",
            text: (el.textContent || "").replace(/\s+/g, " ").trim(),
            inFooter:
              el.closest("footer, [role='contentinfo'], [id*='footer' i], [class*='footer' i]") !== null ||
              el.getBoundingClientRect().top + window.scrollY > document.documentElement.scrollHeight * 0.75,
            scripted: true,
          })),
      ),
    EXACT_LEGAL_LABELS), 5000, () => {
      throw new PageUnresponsiveError();
    });
    const lang = await bounded(page.evaluate(() => document.documentElement.lang || ""), 5000, () => "");
    const legal = findLegalLinks(anchors);
    // Read the cookies before the link check: its requests share the cookie jar and may set cookies of their own.
    const cookiesBeforeLinkCheck = await context.cookies();
    // A page may point its legal links anywhere; never let it make consentprobe probe the local network.
    // Only a site the user typed as local (a dev server) may have its legal pages checked there, and
    // only the typed host itself: a redirect from it to another local address stays blocked.
    const typedHost = new URL(url).hostname;
    for (const link of [legal.imprint, legal.privacy] as LegalLink[]) {
      if (link.found && link.href) link.status = await checkLink(context, link.href, timeoutMs, 1500, isLocalHost(typedHost) ? typedHost : undefined);
    }

    const measured = {
      finalUrl,
      requests: classifyRequests(rawRequests, pageHost, firstParty),
      cookies: classifyCookies(cookiesBeforeLinkCheck, pageHost, firstParty),
      legal,
      lang,
      consentWall,
    };
    if (screenshotDir && bannerWaitMs > 0) {
      // Second neutral screenshot, taken after the measurement is complete: a banner that renders
      // late is missing from baseline.png but visible here. Waits until a banner control shows up
      // (at most bannerWaitMs); nothing is clicked and nothing seen now enters the measurement.
      await locateControls(page, bannerWaitMs, newBudget());
      await page.screenshot({ path: join(screenshotDir, "baseline-2-after-banner-wait.png"), timeout: 10000 }).catch(() => undefined);
    }
    return measured;
  } finally {
    await context.close();
  }
}

/** Query strings and fragments can carry session ids or personal data; reports keep origin and path. */
function withoutQuery(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return href;
  }
}

function legalWithoutQuery(link: LegalLink): LegalLink {
  return {
    ...link,
    ...(link.href ? { href: withoutQuery(link.href) } : {}),
    ...(link.candidate ? { candidate: { ...link.candidate, href: withoutQuery(link.candidate.href) } } : {}),
  };
}

function failedVisit(action: "reject" | "accept", err: unknown): { banner: ConsentBanner; session: ConsentSession } {
  const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 200) ?? "";
  return {
    banner: { detected: false, rejectFound: false, acceptFound: false, incomplete: true },
    session: { action, clicked: false, requestsAfter: [], cookiesBefore: [], cookiesAfter: [], error: `visit failed: ${reason}` },
  };
}

function mergeBanner(a?: ConsentBanner, b?: ConsentBanner): ConsentBanner {
  return {
    detected: Boolean(a?.detected || b?.detected),
    cmp: a?.cmp ?? b?.cmp,
    rejectFound: Boolean(a?.rejectFound || b?.rejectFound),
    acceptFound: Boolean(a?.acceptFound || b?.acceptFound),
    rejectLike: a?.rejectLike ?? b?.rejectLike,
    overlayHint: a?.overlayHint || b?.overlayHint || undefined,
    incomplete: (a?.incomplete || b?.incomplete) && !(a?.detected || b?.detected) ? true : undefined,
    rejectSearchIncomplete:
      (a?.rejectSearchIncomplete || b?.rejectSearchIncomplete) && !(a?.rejectFound || b?.rejectFound) ? true : undefined,
  };
}

export async function scan(rawUrl: string, options: ScanOptions = {}): Promise<ScanResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL. Include the scheme, e.g. https://example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be scanned, got "${url.protocol}".`);
  }
  // Credentials in the URL (a password-protected test site) are used for the visit, never reported.
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s; // a raw "%" that is not an escape sequence
    }
  };
  const login = url.username ? { username: decode(url.username), password: decode(url.password) } : undefined;
  url.username = "";
  url.password = "";
  // Sent only to the typed origin: a third party that answers 401 (a tracker, a legal page elsewhere) gets nothing.
  const httpCredentials = login ? { ...login, origin: url.origin } : undefined;
  const settleMs = options.settleMs ?? DEFAULTS.settleMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const bannerWaitMs = options.bannerWaitMs ?? DEFAULTS.bannerWaitMs;
  const clickTest = options.clickTest ?? true;
  // The domain the user typed belongs to the operator too, also when the site redirects to another one.
  const firstParty = [...(options.firstParty ?? []), url.hostname];
  const imprintMode = options.imprint ?? "auto";
  const rules = [...(options.extraRules ?? []), ...BUILT_IN_RULES];

  const browser = await chromium
    .launch({ channel: options.browser === "chrome" ? "chrome" : undefined })
    .catch((err: unknown) => {
      throw explainLaunchError(err);
    });
  try {
    const identity = await bounded(visitorIdentity(browser), 10000, () => undefined);
    const sessionOpts: SessionOptions = { timeoutMs, settleMs, bannerWaitMs, firstParty, screenshotDir: options.screenshotDir, identity, httpCredentials };
    // A failing click visit (the site blocks a second visit, a navigation error) must not throw away
    // the finished baseline: it becomes an untested session with its reason.
    const visit = (action: "reject" | "accept", o: SessionOptions) =>
      runConsentSession(browser, url.href, action, o).catch((err: unknown) => failedVisit(action, err));
    // Three independent visits run in parallel; each has its own cookie jar.
    // Hard stop: whatever a page does, a scan must end (it runs unattended in CI).
    const deadlineMs = timeoutMs + 2 * bannerWaitMs + 2 * settleMs + 45000;
    const stopped = (ms: number) => () => {
      throw new Error(`The scan did not finish within ${Math.round(ms / 1000)} s and was stopped. The page may be blocking the browser.`);
    };
    // Each visit has its own hard stop: a click visit that hangs becomes untested, the baseline stays.
    const clickVisit = (action: "reject" | "accept") =>
      bounded(visit(action, sessionOpts), deadlineMs, () =>
        failedVisit(action, new Error(`did not finish within ${Math.round(deadlineMs / 1000)} s`)),
      );
    let [base, reject, accept] = await Promise.all([
      bounded(
        runBaseline(browser, url.href, timeoutMs, settleMs, firstParty, options.screenshotDir, identity, bannerWaitMs, httpCredentials),
        deadlineMs,
        stopped(deadlineMs),
      ),
      clickTest ? clickVisit("reject") : undefined,
      clickTest ? clickVisit("accept") : undefined,
    ]);

    // Banners can appear late. When one visit saw the banner and the other did not, the other is
    // repeated once with a longer wait, so a click is not silently left untested.
    const retryMs = timeoutMs + 2 * bannerWaitMs + 2 * settleMs + 30000;
    const retry = { ...sessionOpts, bannerWaitMs: bannerWaitMs * 2 };
    // The retry is a second chance: if it fails or runs out of time, the first result stays.
    if (reject && accept && accept.banner.detected && !reject.banner.detected) {
      reject = (await bounded(visit("reject", retry), retryMs, () => undefined)) ?? reject;
    } else if (reject && accept && reject.banner.detected && !accept.banner.detected) {
      accept = (await bounded(visit("accept", retry), retryMs, () => undefined)) ?? accept;
    }

    let consent: ConsentTest | undefined;
    if (clickTest) {
      consent = {
        banner: mergeBanner(reject?.banner, accept?.banner),
        reject: reject?.session as ConsentSession | undefined,
        accept: accept?.session as ConsentSession | undefined,
      };
    }

    const host = new URL(base.finalUrl).hostname;
    const looksGerman = looksGermanSite(host, base.lang);
    const imprintCheck: ImprintMode =
      imprintMode === "never" ? "off" : imprintMode === "always" || looksGerman ? "check" : "skipped-auto";
    const wall = base.consentWall
      ? [
          {
            id: "consent-wall-page",
            severity: "info" as const,
            message:
              "The site redirected the first visit to a separate consent page. consentprobe measured that page, not the site behind it: imprint and privacy links are not checked, and a full-page consent choice is not clicked.",
            evidence: [withoutQuery(base.finalUrl)],
          },
        ]
      : [];
    // Query strings and fragments can carry session tokens; they stay out of findings and the result.
    const legal = { imprint: legalWithoutQuery(base.legal.imprint), privacy: legalWithoutQuery(base.legal.privacy) };
    const findings = [
      ...findingsForRequests(base.requests, rules),
      ...findingsForCookies(base.cookies),
      ...wall,
      ...(base.consentWall
        ? []
        : findingsForLegal(legal, imprintCheck, looksGerman || imprintMode === "always", /\.(de|at|ch|li)$/.test(host) || imprintMode === "always")),
      ...(consent && !(base.consentWall && !consent.banner.detected) ? findingsForConsent(consent, base.requests, rules) : []),
    ];
    const count = (s: "error" | "warn" | "info") => findings.filter((f) => f.severity === s).length;

    return {
      tool: { name: "consentprobe", version: VERSION, browser: `${options.browser === "chrome" ? "Chrome" : "Chromium"} ${browser.version()}`, playwright: PLAYWRIGHT_VERSION },
      url: url.href,
      finalUrl: withoutQuery(base.finalUrl),
      scannedAt: new Date().toISOString(),
      phase: "before-consent",
      requests: base.requests,
      cookies: base.cookies,
      legal,
      consent,
      findings,
      summary: {
        error: count("error"),
        warn: count("warn"),
        info: count("info"),
        thirdPartyHosts: new Set(base.requests.filter((r) => r.thirdParty).map((r) => r.host)).size,
      },
    };
  } finally {
    await bounded(browser.close(), 10000, () => undefined);
  }
}
