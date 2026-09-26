import type { Page, Request } from "playwright";

/** One request as the page made it, before classification. */
export interface RawRequest {
  url: string;
  resourceType: string;
  /** URL of the frame that made the request, when known (not for service-worker requests). */
  frameUrl?: string;
  /** The browser itself stopped the request (Content Security Policy, mixed content): it never left the machine. */
  blocked?: boolean;
}

const BLOCKED_BY_BROWSER = /^(csp|mixed-content|net::ERR_BLOCKED_BY_(CLIENT|CSP))$/i;

/** Record every request of a page into `into`, marking the ones the browser blocked itself. */
export function recordRequests(page: Page, into: RawRequest[]): void {
  const entries = new WeakMap<Request, RawRequest>();
  page.on("request", (req) => {
    let frameUrl: string | undefined;
    try {
      frameUrl = req.frame().url();
    } catch {
      frameUrl = undefined;
    }
    const entry: RawRequest = { url: req.url(), resourceType: req.resourceType(), ...(frameUrl ? { frameUrl } : {}) };
    entries.set(req, entry);
    into.push(entry);
  });
  page.on("requestfailed", (req) => {
    const entry = entries.get(req);
    if (entry && BLOCKED_BY_BROWSER.test(req.failure()?.errorText ?? "")) entry.blocked = true;
  });
}
