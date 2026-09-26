import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { locateControls, runConsentSession } from "./consent.js";
import { bounded, newBudget } from "./bounded.js";
import { applyIdentity, visitorContextOptions, visitorIdentity, type VisitorIdentity } from "./identity.js";
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
import { findLegalLinks, type RawAnchor } from "./legal.js";
import { VERSION } from "./version.js";
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
  const title = /^(just a moment|nur einen moment|einen moment bitte|attention required|access denied|pardon our interruption|please verify|verify you are (a )?human|are you a robot|checking your browser|one more step|security check|ddos-guard)/i.test(p.title.trim());
  return small && (url || title || p.markers > 0);
}

function describeStatus(status: number): string {
  if (status === 404 || status === 410) return `The page was not found (HTTP ${status}). Check the URL.`;
  if (status === 401 || status === 403 || status === 429) {
    return `The site refused the automated browser (HTTP ${status}, usually bot protection or rate limiting). No reliable measurement is possible.`;
  }
  if (status >= 500) return `The server answered with an error (HTTP ${status}). Try again later.`;
  return `The page answered HTTP ${status}, so it shows an error page and no reliable measurement is possible.`;
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
  if (/executable doesn't exist|browserType\.launch/i.test(message) && /install/i.test(message)) {
    return new Error("No browser found. Install one with: npx playwright install chromium (or use --browser chrome).");
  }
  return err instanceof Error ? err : new Error(message);
}

/** Statuses that say "try again later", not "this page does not exist". */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * HTTP status of a legal page. A transient status gets one retry; if it stays transient the link
 * counts as unverified (undefined), because a short server hiccup must not become "link broken".
 */
export async function checkLink(
  context: { request: { get: (url: string, o: { timeout: number; failOnStatusCode: boolean }) => Promise<{ status(): number }> } },
  href: string,
  timeoutMs: number,
  retryDelayMs = 1500,
): Promise<number | undefined> {
  const get = () =>
    context.request
      .get(href, { timeout: Math.min(timeoutMs, 20000), failOnStatusCode: false })
      .then((r) => r.status())
      .catch(() => undefined);
  let status = await get();
  if (status !== undefined && TRANSIENT.has(status)) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    status = await get();
  }
  return status !== undefined && TRANSIENT.has(status) ? undefined : status;
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
): Promise<Baseline> {
  // A fresh context has no cookies or storage: it behaves like a first-time visitor.
  const context = await browser.newContext(visitorContextOptions(identity));
  try {
    const page = await context.newPage();
    await applyIdentity(page, identity);
    page.setDefaultTimeout(Math.min(timeoutMs, 10000));
    const rawRequests: { url: string; resourceType: string }[] = [];
    page.on("request", (req) => rawRequests.push({ url: req.url(), resourceType: req.resourceType() }));

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
        markers: document.querySelectorAll(
          "#challenge-form, #challenge-running, #cf-challenge-running, .cf-browser-verification, #px-captcha, iframe[src*='captcha-delivery.com']",
        ).length,
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

    const anchors: RawAnchor[] = await bounded(page.evaluate(() =>
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
            if (!/^(impressum|imprint|legal notice|anbieterkennung|datenschutz(erklärung|erklaerung|hinweise|bestimmungen|richtlinie)?|privacy( policy| notice| statement)?|data protection( policy| notice)?)[.:]?$/i.test(text)) return false;
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
    ), 5000, () => {
      throw new PageUnresponsiveError();
    });
    const lang = await bounded(page.evaluate(() => document.documentElement.lang || ""), 5000, () => "");
    const legal = findLegalLinks(anchors);
    for (const link of [legal.imprint, legal.privacy] as LegalLink[]) {
      if (link.found && link.href) {
        link.status = await checkLink(context, link.href, timeoutMs);
      }
    }

    const measured = {
      finalUrl,
      requests: classifyRequests(rawRequests, pageHost, firstParty),
      cookies: classifyCookies(await context.cookies(), pageHost, firstParty),
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

function mergeBanner(a?: ConsentBanner, b?: ConsentBanner): ConsentBanner {
  return {
    detected: Boolean(a?.detected || b?.detected),
    cmp: a?.cmp ?? b?.cmp,
    rejectFound: Boolean(a?.rejectFound || b?.rejectFound),
    acceptFound: Boolean(a?.acceptFound || b?.acceptFound),
    rejectLike: a?.rejectLike ?? b?.rejectLike,
    overlayHint: a?.overlayHint || b?.overlayHint || undefined,
    incomplete: (a?.incomplete || b?.incomplete) && !(a?.detected || b?.detected) ? true : undefined,
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
  const settleMs = options.settleMs ?? DEFAULTS.settleMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const bannerWaitMs = options.bannerWaitMs ?? DEFAULTS.bannerWaitMs;
  const clickTest = options.clickTest ?? true;
  const firstParty = options.firstParty ?? [];
  const imprintMode = options.imprint ?? "auto";
  const rules = [...(options.extraRules ?? []), ...BUILT_IN_RULES];

  const browser = await chromium
    .launch({ channel: options.browser === "chrome" ? "chrome" : undefined })
    .catch((err: unknown) => {
      throw explainLaunchError(err);
    });
  try {
    const identity = await bounded(visitorIdentity(browser), 10000, () => undefined);
    const sessionOpts = { timeoutMs, settleMs, bannerWaitMs, firstParty, screenshotDir: options.screenshotDir, identity };
    // Three independent visits run in parallel; each has its own cookie jar.
    // Hard stop: whatever a page does, a scan must end (it runs unattended in CI).
    const deadlineMs = timeoutMs + 2 * bannerWaitMs + 2 * settleMs + 45000;
    const stopped = (ms: number) => () => {
      throw new Error(`The scan did not finish within ${Math.round(ms / 1000)} s and was stopped. The page may be blocking the browser.`);
    };
    let [base, reject, accept] = await bounded(Promise.all([
      runBaseline(browser, url.href, timeoutMs, settleMs, firstParty, options.screenshotDir, identity, bannerWaitMs),
      clickTest ? runConsentSession(browser, url.href, "reject", sessionOpts) : undefined,
      clickTest ? runConsentSession(browser, url.href, "accept", sessionOpts) : undefined,
    ]), deadlineMs, stopped(deadlineMs));

    // Banners can appear late. When one visit saw the banner and the other did not, the other is
    // repeated once with a longer wait, so a click is not silently left untested.
    const retryMs = timeoutMs + 2 * bannerWaitMs + 2 * settleMs + 30000;
    const retry = { ...sessionOpts, bannerWaitMs: bannerWaitMs * 2 };
    if (reject && accept && accept.banner.detected && !reject.banner.detected) {
      reject = await bounded(runConsentSession(browser, url.href, "reject", retry), retryMs, stopped(retryMs));
    } else if (reject && accept && reject.banner.detected && !accept.banner.detected) {
      accept = await bounded(runConsentSession(browser, url.href, "accept", retry), retryMs, stopped(retryMs));
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
    const looksGerman = base.lang.toLowerCase().startsWith("de") || /\.(de|at|ch)$/.test(host);
    const imprintCheck: ImprintMode =
      imprintMode === "never" ? "off" : imprintMode === "always" || looksGerman ? "check" : "skipped-auto";
    const wall = base.consentWall
      ? [
          {
            id: "consent-wall-page",
            severity: "info" as const,
            message:
              "The site redirected the first visit to a separate consent page. consentprobe measured that page, not the site behind it: imprint and privacy links are not checked, and a full-page consent choice is not clicked.",
            evidence: [base.finalUrl],
          },
        ]
      : [];
    const findings = [
      ...findingsForRequests(base.requests, rules),
      ...findingsForCookies(base.cookies),
      ...wall,
      ...(base.consentWall
        ? []
        : findingsForLegal(base.legal, imprintCheck, looksGerman || imprintMode === "always", /\.(de|at|ch|li)$/.test(host) || imprintMode === "always")),
      ...(consent && !(base.consentWall && !consent.banner.detected) ? findingsForConsent(consent, base.requests, rules) : []),
    ];
    const count = (s: "error" | "warn" | "info") => findings.filter((f) => f.severity === s).length;

    return {
      tool: { name: "consentprobe", version: VERSION },
      url: url.href,
      finalUrl: base.finalUrl,
      scannedAt: new Date().toISOString(),
      phase: "before-consent",
      requests: base.requests,
      cookies: base.cookies,
      legal: base.legal,
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
