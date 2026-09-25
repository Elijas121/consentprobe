import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Frame, Locator, Page } from "playwright";
import { classifyCookies, classifyRequests } from "./findings.js";
import { ask, newBudget, type QueryBudget } from "./bounded.js";
import { applyIdentity, visitorContextOptions, type VisitorIdentity } from "./identity.js";
import { explainNavigationError, openPage } from "./navigate.js";
import type { ConsentBanner, ConsentControl, ConsentSession } from "./types.js";

interface CmpDef {
  name: string;
  reject: string;
  accept: string;
}

/** Best-effort selectors of common consent platforms. A miss falls back to text matching. */
const CMPS: CmpDef[] = [
  { name: "OneTrust", reject: "#onetrust-reject-all-handler", accept: "#onetrust-accept-btn-handler" },
  {
    name: "Cookiebot",
    reject: "#CybotCookiebotDialogBodyButtonDecline",
    accept: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept",
  },
  { name: "Usercentrics", reject: "[data-testid='uc-deny-all-button']", accept: "[data-testid='uc-accept-all-button']" },
  { name: "Didomi", reject: "#didomi-notice-disagree-button", accept: "#didomi-notice-agree-button" },
  { name: "CookieYes", reject: ".cky-btn-reject", accept: ".cky-btn-accept" },
  { name: "Complianz", reject: ".cmplz-deny", accept: ".cmplz-accept" },
  { name: "Borlabs Cookie", reject: "._brlbs-refuse-btn", accept: "._brlbs-btn-accept-all" },
  { name: "Cookie Notice", reject: "#cn-refuse-cookie", accept: "#cn-accept-cookie" },
  // Shopify's built-in customer privacy banner; shops rename the buttons freely ("Ok", "No Thanks").
  { name: "Shopify", reject: "#shopify-pc__banner__btn-decline", accept: "#shopify-pc__banner__btn-accept" },
];

/** Lower-case, letters and spaces only, so labels compare independent of icons and punctuation. */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Strict patterns match the WHOLE label. A control is only clicked when it clearly is a
 * general reject or accept; a wrong click would produce false findings.
 */
const REJECT_STRICT: RegExp[] = [
  /^(alles?(\s+cookies)?\s+)?(ablehnen|verweigern)(\s+(und\s+)?(weiter|schließen|schliessen|fortfahren))?$/,
  /^(alle\s+)?einwilligung(en)?\s+(ablehnen|verweigern)$/,
  /^(alle\s+)?(optionalen?|nicht\s+notwendigen?|zusätzlichen?)\s+cookies\s+ablehnen$/,
  /^(nur\s+)?(technisch\s+)?(notwendige|erforderliche|essenzielle|essentielle)(\s+cookies)?(\s+(akzeptieren|zulassen|erlauben|verwenden|speichern))?$/,
  /^(weiter\s+)?ohne\s+(zustimmung|einwilligung|akzeptieren)(\s+(fortfahren|weiter|weiterlesen))?$/,
  /^(reject|decline|deny|refuse)(\s+all)?(\s+cookies)?$/,
  /^((accept|allow|use)\s+)?(only\s+)?(strictly\s+)?(necessary|essential|required)(\s+cookies)?(\s+only)?$/,
  /^continue\s+without\s+(accepting|consent)$/,
];
const ACCEPT_STRICT: RegExp[] = [
  /^(alle[ns]?(\s+(cookies|zwecken))?\s+)?(akzeptieren|zustimmen|einwilligen|annehmen|erlauben|zulassen)(\s+(und\s+)?(weiter|schließen|schliessen|fortfahren))?$/,
  /^(ja\s+)?(ich\s+)?stimme\s+zu(\s+und\s+akzeptiere\s+alle(\s+cookies)?)?$/,
  /^ich\s+akzeptiere(\s+alle)?$/,
  /^(ich\s+bin\s+)?einverstanden$/,
  /^geht\s+klar$/,
  /^(accept|allow|agree)(\s+(all|everything))?(\s+cookies)?(\s+(and\s+)?(continue|close))?$/,
  /^i\s+(agree|accept)(\s+all)?(\s+cookies)?$/,
];
/** Loose: anything that mentions rejecting. Reported, never clicked. */
const REJECT_LIKE = /ablehnen|verweigern|reject|decline|deny|refuse/i;
const ACCEPT_LIKE = /akzeptier|zustimmen|einwilligen|einverstanden|annehmen|accept|agree|allow/i;

/**
 * Cheap pre-filter for the accessible-name query. Invariant (tested): every label that the
 * strict patterns accept must also pass this filter, otherwise a control is silently missed.
 */
export const CANDIDATE_LABEL =
  /ablehn|verweiger|reject|declin|deny|refus|akzeptier|zustimm|stimme\s+zu|einwillig|einverstanden|annehm|erlaub|zulass|accept|agree|allow|geht\s+klar|notwendig|erforderlich|essen[zt]iell|necessary|essential|required|ohne\s+(zustimmung|einwilligung|akzeptieren)|without/i;

export const isRejectLabel = (label: string): boolean => REJECT_STRICT.some((re) => re.test(normalizeLabel(label)));
export const isAcceptLabel = (label: string): boolean => ACCEPT_STRICT.some((re) => re.test(normalizeLabel(label)));
export const isRejectLike = (label: string): boolean => REJECT_LIKE.test(label);

const MAX_LABEL = 50;

/**
 * True when the element sits in a real overlay (fixed or sticky ancestor, or a dialog).
 * Marketing mock-ups of banners inside the page content do not qualify, so they are never clicked.
 */
const isOverlayElement = (el: Element): boolean => {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const position = getComputedStyle(n).position;
    if (position === "fixed" || position === "sticky") return true;
    const role = n.getAttribute("role");
    if (role === "dialog" || role === "alertdialog" || n.getAttribute("aria-modal") === "true" || n.tagName === "DIALOG") {
      return true;
    }
  }
  return false;
};

/**
 * True for a part of a choice rather than a decision: the label of a category checkbox, a toggle or
 * an accordion header. Consent lists name categories "Essential" or "Notwendige Cookies"; clicking
 * such a name ticks a box or opens a section, it never rejects anything.
 */
const isChoicePart = (el: Element): boolean =>
  el.closest("label, summary, [role='checkbox'], [role='switch'], [role='radio'], [role='tab']") !== null ||
  el.hasAttribute("aria-expanded") ||
  el.hasAttribute("aria-checked") ||
  el.hasAttribute("aria-pressed") ||
  el.querySelector("input, select, textarea") !== null;

async function inOverlay(locator: Locator, frame: Frame, page: Page, q: QueryBudget): Promise<boolean> {
  if (await ask(() => locator.evaluate(isOverlayElement), q, false, frame)) return true;
  if (frame === page.mainFrame()) return false;
  // Cross-origin banners (e.g. Sourcepoint) live in an iframe that is itself the overlay.
  const iframe = await ask(() => frame.frameElement(), q, null, page.mainFrame());
  return iframe ? await ask(() => iframe.evaluate(isOverlayElement), q, false, page.mainFrame()) : false;
}

interface Found {
  locator: Locator;
  control: ConsentControl;
}

interface Controls {
  cmp?: string;
  reject?: Found;
  accept?: Found;
  /** A reject-like label that is not a general reject (e.g. an opt-out for one service). */
  rejectLike?: string;
}

async function labelOf(el: Locator, q: QueryBudget, frame: Frame): Promise<string> {
  const text = await ask(() => el.innerText({ timeout: 1000 }), q, "", frame);
  const aria = text ? "" : ((await ask(() => el.getAttribute("aria-label", { timeout: 1000 }), q, null, frame)) ?? "");
  return (text || aria).replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}

async function bySelector(page: Page, selector: string, q: QueryBudget): Promise<Found | undefined> {
  for (const frame of page.frames()) {
    const locator = frame.locator(selector).first();
    if (await ask(() => locator.isVisible(), q, false, frame)) {
      return { locator, control: { label: (await labelOf(locator, q, frame)) || selector, method: "cmp-selector" } };
    }
  }
  return undefined;
}

const PLAIN_MARK = "data-consentprobe-control";

/**
 * Some banners build their controls from plain elements (an <a> without href, a <div> with a click
 * handler). They have no button or link role, so the role search misses them. This marks plain
 * clickable elements inside an overlay whose whole text is short and passes the candidate filter;
 * the strict label check still decides afterwards. Buttons and real links are left to the role search.
 */
function markPlainControls(args: { source: string; flags: string; mark: string; max: number }): number {
  const candidate = new RegExp(args.source, args.flags);
  const inOverlay = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const position = getComputedStyle(n).position;
      if (position === "fixed" || position === "sticky") return true;
      const role = n.getAttribute("role");
      if (role === "dialog" || role === "alertdialog" || n.getAttribute("aria-modal") === "true" || n.tagName === "DIALOG") return true;
    }
    return false;
  };
  let marked = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const role = el.getAttribute("role");
    if (el.tagName === "BUTTON" || role === "button" || role === "link" || (el.tagName === "A" && el.hasAttribute("href"))) continue;
    // Cheap text filter first; style and layout queries only for the few elements that pass.
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw || raw.length > args.max || !candidate.test(raw)) continue;
    if (el.closest("button, a[href], [role='button'], [role='link']")) continue;
    // A category name in a consent list labels a checkbox or opens a section (see isChoicePart).
    if (el.closest("label, summary, [role='checkbox'], [role='switch'], [role='radio'], [role='tab']") || el.querySelector("input, select, textarea")) continue;
    const clickable = el.tagName === "A" || el.hasAttribute("onclick") || el.hasAttribute("tabindex") || getComputedStyle(el).cursor === "pointer";
    if (!clickable) continue;
    // The outermost clickable element carries the label; its children inherit cursor:pointer.
    const parent = el.parentElement;
    if (parent && parent !== document.body && (parent.tagName === "A" || parent.hasAttribute("onclick") || getComputedStyle(parent).cursor === "pointer")) continue;
    const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > args.max || !candidate.test(text)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !inOverlay(el)) continue;
    el.setAttribute(args.mark, "");
    marked += 1;
  }
  return marked;
}

async function byText(page: Page, q: QueryBudget): Promise<Pick<Controls, "reject" | "accept" | "rejectLike">> {
  const out: Pick<Controls, "reject" | "accept" | "rejectLike"> = {};
  const candidates = CANDIDATE_LABEL;
  for (const frame of page.frames()) {
    for (const role of ["button", "link"] as const) {
      const all = frame.getByRole(role, { name: candidates });
      const count = Math.min(await ask(() => all.count(), q, 0, frame), 15);
      for (let i = 0; i < count; i++) {
        const locator = all.nth(i);
        if (!(await ask(() => locator.isVisible(), q, false, frame))) continue;
        const label = await labelOf(locator, q, frame);
        if (!label || label.length > MAX_LABEL) continue;
        if (!(await inOverlay(locator, frame, page, q))) continue;
        if (await ask(() => locator.evaluate(isChoicePart), q, false, frame)) continue;
        const found: Found = { locator, control: { label, method: "text" } };
        if (isRejectLabel(label)) out.reject ??= found;
        else if (isAcceptLabel(label)) out.accept ??= found;
        else if (isRejectLike(label)) out.rejectLike ??= label;
      }
    }
    if (out.reject && out.accept) continue;
    const args = { source: candidates.source, flags: candidates.flags, mark: PLAIN_MARK, max: MAX_LABEL };
    if ((await ask(() => frame.evaluate(markPlainControls, args), q, 0, frame)) === 0) continue;
    const plain = frame.locator(`[${PLAIN_MARK}]`);
    const count = Math.min(await ask(() => plain.count(), q, 0, frame), 15);
    for (let i = 0; i < count; i++) {
      const locator = plain.nth(i);
      if (!(await ask(() => locator.isVisible(), q, false, frame))) continue;
      const label = await labelOf(locator, q, frame);
      if (!label || label.length > MAX_LABEL) continue;
      const found: Found = { locator, control: { label, method: "text" } };
      if (isRejectLabel(label)) out.reject ??= found;
      else if (isAcceptLabel(label)) out.accept ??= found;
      else if (isRejectLike(label)) out.rejectLike ??= label;
    }
  }
  return out;
}

async function scanOnce(page: Page, q: QueryBudget): Promise<Controls> {
  const controls: Controls = {};
  for (const cmp of CMPS) {
    const reject = await bySelector(page, cmp.reject, q);
    const accept = await bySelector(page, cmp.accept, q);
    if (reject || accept) {
      controls.cmp = cmp.name;
      controls.reject = reject;
      controls.accept = accept;
      break;
    }
  }
  const text = await byText(page, q);
  controls.reject ??= text.reject;
  controls.accept ??= text.accept;
  if (!controls.reject) controls.rejectLike = text.rejectLike;
  return controls;
}

/** Poll until a banner control shows up (banners often render late), then re-scan once for the second button. */
export async function locateControls(page: Page, waitMs: number, q: QueryBudget): Promise<Controls> {
  const deadline = Date.now() + waitMs;
  do {
    // The scan may have been stopped (deadline, unresponsive page); do not keep asking a closed page.
    if (page.isClosed()) return {};
    const first = await scanOnce(page, q);
    if (first.accept || first.reject) {
      await page.waitForTimeout(300);
      const second = await scanOnce(page, q);
      return {
        cmp: second.cmp ?? first.cmp,
        reject: second.reject ?? first.reject,
        accept: second.accept ?? first.accept,
        rejectLike: second.rejectLike ?? first.rejectLike,
      };
    }
    await page.waitForTimeout(300);
  } while (Date.now() < deadline);
  return {};
}

/** True when a visible fixed overlay mentions cookies, even if no control could be recognized. */
async function cookieOverlayVisible(page: Page, q: QueryBudget): Promise<boolean> {
  for (const frame of page.frames()) {
    const hit = await ask(
      () => frame.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const style = getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "sticky") continue;
          const rect = el.getBoundingClientRect();
          // Thin notice bars (about 30 px) count too; small widgets such as chat bubbles do not.
          if (rect.width < 300 || rect.height < 20 || style.visibility === "hidden" || style.display === "none") continue;
          const text = (el as HTMLElement).innerText || "";
          if (text.length < 3000 && /cookie/i.test(text)) return true;
        }
        return false;
      }),
      q,
      false,
      frame,
    );
    if (hit) return true;
  }
  return false;
}

export interface SessionOptions {
  timeoutMs: number;
  settleMs: number;
  bannerWaitMs: number;
  firstParty: string[];
  screenshotDir?: string;
  identity?: VisitorIdentity;
}

async function shot(page: Page, dir: string | undefined, name: string): Promise<void> {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name), timeout: 10000 }).catch(() => undefined);
}

export async function runConsentSession(
  browser: Browser,
  url: string,
  action: "reject" | "accept",
  o: SessionOptions,
): Promise<{ banner: ConsentBanner; session: ConsentSession }> {
  const context = await browser.newContext(visitorContextOptions(o.identity));
  try {
    const raw: { url: string; resourceType: string }[] = [];
    // The page reports the exact moment of the physical press (in any frame, before the site's own
    // handlers run). Requests before that moment are "before the click", even if they arrive while
    // a screenshot is taken. Armed only right before our own click.
    let armed = false;
    let clickMarker: number | undefined;
    await context.exposeBinding("__consentprobeMark", () => {
      if (armed && clickMarker === undefined) clickMarker = raw.length;
    });
    await context.addInitScript(() => {
      const mark = () => (window as unknown as { __consentprobeMark?: () => void }).__consentprobeMark?.();
      for (const type of ["pointerdown", "mousedown"]) document.addEventListener(type, mark, { capture: true });
    });
    const page = await context.newPage();
    await applyIdentity(page, o.identity);
    const q: QueryBudget = newBudget();
    page.setDefaultTimeout(Math.min(o.timeoutMs, 10000));
    page.on("request", (req) => raw.push({ url: req.url(), resourceType: req.resourceType() }));

    await openPage(page, url, o.timeoutMs).catch((err: unknown) => {
      throw explainNavigationError(err, o.timeoutMs);
    });

    const controls = await locateControls(page, o.bannerWaitMs, q);
    const banner: ConsentBanner = {
      detected: Boolean(controls.accept || controls.reject),
      cmp: controls.cmp,
      rejectFound: Boolean(controls.reject),
      acceptFound: Boolean(controls.accept),
      rejectLike: controls.rejectLike,
      overlayHint: controls.accept || controls.reject ? undefined : await cookieOverlayVisible(page, q),
    };
    // A frozen frame hides controls: never report "no banner" when parts of the page did not answer.
    if (q.timeouts > 0 && !banner.detected) banner.incomplete = true;
    const target = action === "reject" ? controls.reject : controls.accept;
    const session: ConsentSession = { action, clicked: false, requestsAfter: [], cookiesBefore: [], cookiesAfter: [] };
    if (!target) {
      await shot(page, o.screenshotDir, `${action}-0-no-control-found.png`);
      return { banner, session };
    }

    const pageHost = new URL(page.url()).hostname;
    session.control = target.control;
    await shot(page, o.screenshotDir, `${action}-1-before-click.png`);
    // Snapshot and fallback marker directly before the click, after the (slow) screenshot.
    session.cookiesBefore = classifyCookies(await context.cookies(), pageHost, o.firstParty);
    const fallbackMarker = raw.length;
    try {
      armed = true;
      await target.locator.click({ timeout: 5000 });
      session.clicked = true;
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      session.error = /Timeout \d+ms exceeded/.test(msg)
        ? "click failed: the control did not accept a click within 5 s (often covered by another element)"
        : `click failed: ${msg}`;
      return { banner, session };
    }
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    if (o.settleMs > 0) await page.waitForTimeout(o.settleMs);
    await shot(page, o.screenshotDir, `${action}-2-after-click.png`);

    session.requestsAfter = classifyRequests(raw.slice(clickMarker ?? fallbackMarker), pageHost, o.firstParty);
    session.cookiesAfter = classifyCookies(await context.cookies(), pageHost, o.firstParty);
    return { banner, session };
  } finally {
    await context.close();
  }
}
