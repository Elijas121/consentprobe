import type { Page, Response } from "playwright";

/**
 * Navigate robustly: wait for the HTML, then give the remaining resources a bounded time.
 * Waiting for the full "load" event alone made whole scans fail on pages with one slow resource.
 */
export async function openPage(page: Page, url: string, timeoutMs: number): Promise<Response | null> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("load", { timeout: Math.min(timeoutMs, 15000) }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  return response;
}

/** One readable line instead of Playwright's multi-line error with call log. */
export function explainNavigationError(err: unknown, timeoutMs: number): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split("\n")[0] ?? raw;
  const net = /net::(ERR_[A-Z_]+)/.exec(raw)?.[1];
  if (net?.startsWith("ERR_CERT_")) {
    return new Error(`The site's TLS certificate is not valid (${net}). The page was not measured.`);
  }
  if (net === "ERR_NAME_NOT_RESOLVED") return new Error("The domain does not resolve (DNS). Check the URL.");
  if (net === "ERR_CONNECTION_REFUSED" || net === "ERR_CONNECTION_TIMED_OUT" || net === "ERR_CONNECTION_RESET") {
    return new Error(`The server could not be reached (${net}).`);
  }
  if (net) return new Error(`The page could not be loaded (${net}).`);
  if (/Timeout \d+ms exceeded/.test(raw)) {
    return new Error(`The page did not respond within ${Math.round(timeoutMs / 1000)} s. Try a larger --timeout.`);
  }
  return new Error(first.replace(/^page\.goto:\s*/, ""));
}

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
