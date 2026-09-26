import type { Browser, BrowserContextOptions, Page } from "playwright";

/**
 * How the browser presents itself to the site. Headless Chromium announces "HeadlessChrome" in its
 * user agent and client hints, and many large sites then skip their banner (and some load tracking
 * right away). A visitor never sees that page, so every visit presents itself like the same Chromium
 * in normal (windowed) mode: only the headless brand is removed. `navigator.webdriver` stays true
 * and blocked pages are still refused; this is about seeing the regular page, not about hiding.
 */
export interface VisitorIdentity {
  userAgent: string;
  metadata: {
    brands: { brand: string; version: string }[];
    fullVersionList: { brand: string; version: string }[];
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness?: string;
    wow64?: boolean;
  };
}

const HEADLESS = /HeadlessChrome/;

type Brand = { brand: string; version: string };
const withoutHeadless = (brands: Brand[]): Brand[] => brands.filter((b) => !HEADLESS.test(b.brand));

export async function visitorIdentity(browser: Browser): Promise<VisitorIdentity | undefined> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // userAgentData needs a secure context. The probe page is served locally by the route below and
    // never reaches the network (.invalid cannot resolve).
    await page.route("https://consentprobe.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>probe</title>" }));
    await page.goto("https://consentprobe.invalid/", { timeout: 5000 });
    const probe = await page.evaluate(async () => {
      const data = (navigator as Navigator & { userAgentData?: { brands: Brand[]; mobile: boolean; getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> } }).userAgentData;
      const high = data
        ? await data.getHighEntropyValues(["platform", "platformVersion", "architecture", "model", "bitness", "wow64", "fullVersionList"])
        : undefined;
      return { userAgent: navigator.userAgent, brands: data?.brands ?? [], mobile: data?.mobile ?? false, high };
    });
    if (!HEADLESS.test(probe.userAgent) && !probe.brands.some((b) => HEADLESS.test(b.brand))) return undefined;
    const brands = withoutHeadless(probe.brands);
    const high = probe.high ?? {};
    return {
      userAgent: probe.userAgent.replace(HEADLESS, "Chrome"),
      metadata: {
        brands,
        fullVersionList: withoutHeadless((high.fullVersionList as Brand[] | undefined) ?? brands),
        platform: String(high.platform ?? ""),
        platformVersion: String(high.platformVersion ?? ""),
        architecture: String(high.architecture ?? ""),
        model: String(high.model ?? ""),
        mobile: probe.mobile,
        bitness: high.bitness === undefined ? undefined : String(high.bitness),
        wow64: high.wow64 === undefined ? undefined : Boolean(high.wow64),
      },
    };
  } catch {
    return undefined;
  } finally {
    await context.close();
  }
}

/** Basic-auth login from the typed URL, bound to that URL's origin. */
export interface HttpCredentials {
  username: string;
  password: string;
  origin: string;
}

/** Options for a fresh visitor context: German locale and, if needed, the regular user agent. */
export function visitorContextOptions(
  identity?: VisitorIdentity,
  httpCredentials?: HttpCredentials,
): BrowserContextOptions {
  return {
    locale: "de-DE",
    ...(identity ? { userAgent: identity.userAgent } : {}),
    ...(httpCredentials ? { httpCredentials } : {}),
  };
}

/**
 * Client hints (sec-ch-ua headers and navigator.userAgentData). Set on the page, it also applies to
 * its cross-origin frames (tested with a consent frame that checks its own request headers).
 */
export async function applyIdentity(page: Page, identity?: VisitorIdentity): Promise<void> {
  if (!identity) return;
  const session = await page.context().newCDPSession(page).catch(() => undefined);
  if (!session) return;
  await session
    .send("Emulation.setUserAgentOverride", {
      userAgent: identity.userAgent,
      // Chromium adds the q-values itself; "de-DE,de" goes out as "de-DE,de;q=0.9", like a normal browser.
      acceptLanguage: "de-DE,de",
      userAgentMetadata: identity.metadata,
    })
    .catch(() => undefined);
}
