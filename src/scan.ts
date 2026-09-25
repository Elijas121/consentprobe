import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { runConsentSession } from "./consent.js";
import { bounded } from "./bounded.js";
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

/** The page answered with an error status, so any measurement would describe the error page. */
export class PageNotMeasurableError extends Error {
  constructor(public readonly status: number) {
    super(
      `The page answered HTTP ${status}. This is often bot protection or an error page, so no reliable measurement is possible.`,
    );
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

type Baseline = Pick<ScanResult, "finalUrl" | "requests" | "cookies" | "legal"> & { lang: string };

/** Visit the page without touching any banner: this is the "before consent" state. */
async function runBaseline(
  browser: Browser,
  url: string,
  timeoutMs: number,
  settleMs: number,
  firstParty: string[],
  screenshotDir?: string,
): Promise<Baseline> {
  // A fresh context has no cookies or storage: it behaves like a first-time visitor.
  const context = await browser.newContext({ locale: "de-DE" });
  try {
    const page = await context.newPage();
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

    const finalUrl = page.url();
    const pageHost = new URL(finalUrl).hostname;

    const anchors: RawAnchor[] = await bounded(page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => ({
        href: a.href,
        text: (a.innerText || a.getAttribute("aria-label") || a.title || "").trim().slice(0, 120),
        inFooter:
          a.closest("footer, [role='contentinfo'], [id*='footer' i], [class*='footer' i]") !== null ||
          a.getBoundingClientRect().top + window.scrollY > document.documentElement.scrollHeight * 0.75,
      })),
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

    return {
      finalUrl,
      requests: classifyRequests(rawRequests, pageHost, firstParty),
      cookies: classifyCookies(await context.cookies(), pageHost, firstParty),
      legal,
      lang,
    };
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
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are supported, got "${url.protocol}"`);
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
    const sessionOpts = { timeoutMs, settleMs, bannerWaitMs, firstParty, screenshotDir: options.screenshotDir };
    // Three independent visits run in parallel; each has its own cookie jar.
    // Hard stop: whatever a page does, a scan must end (it runs unattended in CI).
    const deadlineMs = timeoutMs + bannerWaitMs + 2 * settleMs + 45000;
    const [base, reject, accept] = await bounded(Promise.all([
      runBaseline(browser, url.href, timeoutMs, settleMs, firstParty, options.screenshotDir),
      clickTest ? runConsentSession(browser, url.href, "reject", sessionOpts) : undefined,
      clickTest ? runConsentSession(browser, url.href, "accept", sessionOpts) : undefined,
    ]), deadlineMs, () => {
      throw new Error(`The scan did not finish within ${Math.round(deadlineMs / 1000)} s and was stopped. The page may be blocking the browser.`);
    });

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
    const findings = [
      ...findingsForRequests(base.requests, rules),
      ...findingsForCookies(base.cookies),
      ...findingsForLegal(base.legal, imprintCheck),
      ...(consent ? findingsForConsent(consent, base.requests, rules) : []),
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
