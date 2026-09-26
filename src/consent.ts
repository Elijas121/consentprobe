import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Frame, Locator, Page } from "playwright";
import { classifyCookies, classifyRequests } from "./findings.js";
import { ask, newBudget, type QueryBudget } from "./bounded.js";
import { applyIdentity, visitorContextOptions, type HttpCredentials, type VisitorIdentity } from "./identity.js";
import { explainNavigationError, isConsentWallRedirect, openPage } from "./navigate.js";
import { recordRequests, type RawRequest } from "./record.js";
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
  /^(reject|decline|deny|refuse)\s+(all\s+)?(optional|non\s+essential|nonessential|non\s+necessary|additional|unnecessary)\s+cookies$/,
  // Google Funding Choices, InMobi (Quantcast) and Klaro word their general reject as a refusal of consent.
  /^(nicht\s+einwilligen|ich\s+(willige\s+nicht\s+ein|stimme\s+nicht\s+zu|lehne\s+ab)|do\s+not\s+consent|don\s+t\s+consent|disagree|i\s+(decline|disagree|do\s+not\s+(accept|agree)))$/,
  // French, Italian, Spanish, Dutch, Polish. "Reject and subscribe" (pay or okay) stays out on purpose.
  /^(tout\s+)?refuser(\s+tout)?(\s+les\s+cookies)?(\s+et\s+(fermer|continuer))?$/,
  /^(je\s+refuse(\s+tout)?|continuer\s+sans\s+accepter)$/,
  /^(accepter\s+)?(uniquement|seulement)\s+(les\s+)?cookies\s+(strictement\s+)?(nécessaires|essentiels)$/,
  /^(rifiuta(\s+tutt[oi])?(\s+i\s+cookie)?|rifiuto|non\s+accetto|continua\s+senza\s+accettare)$/,
  /^(accetta\s+)?solo\s+(i\s+)?(cookie\s+)?(necessari|essenziali|tecnici)$/,
  /^(rechazar(\s+tod[oa]s?)?(\s+las\s+cookies)?|continuar\s+sin\s+aceptar)$/,
  /^(aceptar\s+)?solo\s+(las\s+)?(cookies\s+)?(necesarias|esenciales|técnicas)$/,
  /^((alles|alle(\s+cookies)?)\s+)?(weigeren|afwijzen)$/,
  /^alleen\s+(noodzakelijke|functionele|essentiële)(\s+cookies)?(\s+(accepteren|toestaan))?$/,
  /^odrzuć(\s+wszystk(ie|o))?$/,
  /^(akceptuj\s+)?tylko\s+(niezbędne|wymagane|konieczne)(\s+(pliki\s+)?cookies?)?$/,
];
const ACCEPT_STRICT: RegExp[] = [
  /^(alle[ns]?(\s+(cookies|zwecken))?\s+)?(akzeptieren|zustimmen|einwilligen|annehmen|erlauben|zulassen)(\s+(und\s+)?(weiter|schließen|schliessen|fortfahren))?$/,
  /^(ja\s+)?(ich\s+)?stimme\s+zu(\s+und\s+akzeptiere\s+alle(\s+cookies)?)?$/,
  /^ich\s+akzeptiere(\s+alle)?$/,
  /^(ich\s+bin\s+)?einverstanden$/,
  /^geht\s+klar$/,
  /^(accept|allow|agree)(\s+(all|everything))?(\s+cookies)?(\s+(and\s+)?(continue|close))?$/,
  /^i\s+(agree|accept)(\s+all)?(\s+cookies)?$/,
  // Google Funding Choices ("Consent" / "Einwilligen") and Klaro ("Das ist ok").
  /^(consent|das\s+ist\s+ok)$/,
  // French, Italian, Spanish, Dutch, Polish. A bare "Autoriser" is left out: push-notification prompts use it.
  /^(tout\s+)?accepter(\s+tout)?(\s+les\s+cookies)?(\s+et\s+(fermer|continuer))?$/,
  /^(j\s+accepte(\s+tout)?|tout\s+autoriser|autoriser\s+tous\s+les\s+cookies)$/,
  /^accett[ao](\s+tutt[oi])?(\s+i\s+cookie)?(\s+e\s+(chiudi|continua))?$/,
  /^consenti\s+tutt[oi]$/,
  /^acept(ar|o)(\s+tod[oa]s?)?(\s+las\s+cookies)?(\s+y\s+(cerrar|continuar))?$/,
  /^permitir\s+todas?(\s+las\s+cookies)?$/,
  /^((alles|alle(\s+cookies)?)\s+)?accepteren(\s+en\s+(sluiten|doorgaan))?$/,
  /^(akkoord(\s+en\s+doorgaan)?|(alles|alle\s+cookies)\s+toestaan)$/,
  /^(za)?akceptuj(ę)?(\s+wszystk(ie|o))?$/,
  /^(zgadzam\s+się|zezwól\s+na\s+wszystkie)$/,
];
/**
 * "OK" / "Okay!" is an accept only next to a real reject in the same banner. On a pure notice
 * ("only necessary cookies are used") there is nothing to consent to, so it is never clicked there.
 */
const OK_LABEL = /^ok(ay)?$/;
export const isOkLabel = (label: string): boolean => OK_LABEL.test(normalizeLabel(label));

/** Loose: anything that mentions rejecting. Reported, never clicked. */
const REJECT_LIKE = /ablehnen|verweigern|reject|decline|deny|refuse|refuser|rifiut|rechaz|weiger|afwijz|odrzu/i;
const ACCEPT_LIKE = /akzeptier|zustimmen|einwilligen|einverstanden|annehmen|accept|agree|allow|accett|acept|akcept|akkoord/i;

/**
 * Cheap pre-filter for the accessible-name query. Invariant (tested): every label that the
 * strict patterns accept must also pass this filter, otherwise a control is silently missed.
 */
export const CANDIDATE_LABEL =
  /^\s*ok(ay)?\s*[!.]?\s*$|ablehn|verweiger|reject|declin|deny|refus|akzeptier|zustimm|stimme\s+zu|einwillig|einverstanden|annehm|erlaub|zulass|accept|agree|allow|geht\s+klar|notwendig|erforderlich|essen[zt]iell|necessary|essential|required|ohne\s+(zustimmung|einwilligung|akzeptieren)|without|essenti|consent|lehne\s+ab|nicht\s+zu|disagree|decline|das\s+ist\s+ok|refus|rifiut|non\s+accetto|rechaz|weiger|afwijz|odrzu|accett|acept|akcept|akkoord|toestaan|zgadzam|zezwól|consenti|permitir|autoriser|nécessaires|essentiels|necessari|essenziali|tecnici|necesarias|esenciales|técnicas|noodzakelijk|functionele|niezbędne|wymagane|konieczne/i;

export const isRejectLabel = (label: string): boolean => REJECT_STRICT.some((re) => re.test(normalizeLabel(label)));
export const isAcceptLabel = (label: string): boolean => ACCEPT_STRICT.some((re) => re.test(normalizeLabel(label)));
export const isRejectLike = (label: string): boolean => REJECT_LIKE.test(label);

const MAX_LABEL = 50;

/**
 * True when the element sits in a real overlay (fixed or sticky ancestor, or a dialog), or in a
 * container the site itself names as its cookie or consent UI (id, class or tag name), such as a
 * consent bar at the top of the page that pushes the content down instead of floating over it.
 * Marketing mock-ups of banners inside the page content do not qualify, so they are never clicked, and
 * neither do content blockers: the "load this video / map" placeholders that consent tools put in the page.
 */
const isOverlayElement = (el: Element): boolean => {
  // Walk out of shadow roots too: some banners live in a web component.
  const up = (n: Element): Element | null => n.parentElement ?? ((n.getRootNode() as { host?: Element }).host ?? null);
  // A fixed wrapper around the whole page (smooth-scroll and app shells) is the page, not an overlay:
  // it holds <main>, many links, a visible text field of a form, or most of the page's elements.
  const pageShell = (x: Element): boolean => {
    if (x.querySelector("main") || x.querySelectorAll("a[href]").length > 100) return true;
    const field = Array.from(x.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], input:not([type]), textarea")).some(
      (f) => f.getBoundingClientRect().width > 0,
    );
    const all = document.body?.querySelectorAll("*").length ?? 0;
    return field || (all >= 40 && x.querySelectorAll("*").length >= all * 0.6);
  };
  for (let n: Element | null = el; n; n = up(n)) {
    // A content blocker ("load this video / map") is no banner, also when it is a fixed lightbox.
    if (/blocker|blocked|placeholder|embed|video|youtube|vimeo|opt-?out|\bmaps?\b/i.test(`${n.id} ${n.getAttribute("class") ?? ""}`)) return false;
    const position = getComputedStyle(n).position;
    if ((position === "fixed" || position === "sticky") && !pageShell(n)) return true;
    const role = n.getAttribute("role");
    if (role === "dialog" || role === "alertdialog" || n.getAttribute("aria-modal") === "true" || n.tagName === "DIALOG") return true;
    // <html> and <body> often carry state classes such as "cookie-banner-open"; they name the page, not the banner.
    if (n.tagName !== "BODY" && n.tagName !== "HTML" && /cookie|consent|gdpr/i.test(`${n.tagName} ${n.id} ${n.getAttribute("class") ?? ""}`)) {
      if (((n as HTMLElement).innerText || "").length < 4000) return true;
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

/**
 * True when the control's surroundings talk about cookies, consent, privacy or tracking. "Erlauben"
 * and "Ablehnen" also sit on push-notification and newsletter prompts; there they must never be
 * taken for a cookie decision. Stops at page-sized containers, so the rest of the page does not count.
 */
const hasConsentContext = (el: Element): boolean => {
  const words = /cookie|consent|einwillig|zustimm|datenschutz|privacy|privatsph|tracking|partner|personalis|confidentialit|donn[ée]es personnelles|riservatezza|privacidad|toestemming|prywatno/i;
  const up = (x: Element): Element | null => x.parentElement ?? ((x.getRootNode() as { host?: Element }).host ?? null);
  // innerText leaves out open shadow roots; banners built from nested web components keep their text there.
  const deepText = (x: Element): string => {
    let text = (x as HTMLElement).innerText || "";
    const hosts = [x, ...Array.from(x.querySelectorAll("*"))].filter((e) => e.shadowRoot);
    for (const host of hosts.slice(0, 20)) {
      for (const child of Array.from(host.shadowRoot?.children ?? [])) {
        if (child.tagName !== "STYLE" && child.tagName !== "SCRIPT") text += ` ${deepText(child)}`;
      }
    }
    return text;
  };
  const isOverlayBox = (x: Element): boolean => {
    const position = getComputedStyle(x).position;
    const role = x.getAttribute("role");
    return position === "fixed" || position === "sticky" || role === "dialog" || role === "alertdialog" || x.getAttribute("aria-modal") === "true" || x.tagName === "DIALOG";
  };
  const outerOverlay = (x: Element): boolean => {
    for (let o = up(x); o && o.tagName !== "BODY"; o = up(o)) if (isOverlayBox(o)) return true;
    return false;
  };
  // Button labels ("Zustimmen", "Ablehnen") do not make their own context: only the prose around them
  // counts, and a label only when it names cookies or consent itself ("Cookies akzeptieren").
  const labelWords = /cookie|consent|einwillig|tracking|datenschutz|privacy|privatsph/i;
  const gate = /\b(1[68]|21)\s*(jahre|years|\+)|mindestens\s+1[68]|volljährig|alter(s)?(prüfung|verifi|bestätigung)|age\s+verification|legal\s+(drinking\s+)?age|years\s+of\s+age|jugendschutz|\bagb\b|nutzungsbedingungen|geschäftsbedingungen|terms\s+(of\s+(use|service)|and\s+conditions)/i;
  const strong = /cookie|consent|einwillig|tracking|personalis|privatsph/i;
  let n: Element | null = up(el);
  for (let depth = 0; n && n.tagName !== "BODY" && depth < 16; depth += 1, n = up(n)) {
    const text = deepText(n);
    const box = isOverlayBox(n);
    // A page-sized container is the page, not the prompt. An overlay may hold a long text (vendor lists).
    if (text.length > (box ? 30000 : 6000)) return false;
    const labels = Array.from(n.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"))
      .map((b) => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").trim())
      .filter(Boolean);
    let prose = text;
    for (const label of labels) prose = prose.replace(label, " ");
    const labelContext = labels.some((label) => labelWords.test(label));
    if (words.test(prose) || labelContext) {
      // An age or terms gate names the privacy policy too, but it asks for no consent to cookies or tracking.
      if (gate.test(prose) && !strong.test(prose) && !labelContext) return false;
      return true;
    }
    // The overlay is the prompt; the page behind it (with its privacy link in the footer) does not count.
    // A sticky button row or a fixed toolbar inside the prompt is not the whole prompt: keep walking to it.
    if (isOverlayBox(n) && !outerOverlay(n)) return false;
  }
  return false;
};

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
  frame: Frame;
}

interface Controls {
  cmp?: string;
  reject?: Found;
  accept?: Found;
  /** A reject-like label that is not a general reject (e.g. an opt-out for one service). */
  rejectLike?: string;
  /** An "OK" control: counts as accept only next to a reject in the same banner. */
  ok?: Found;
}

async function labelOf(el: Locator, q: QueryBudget, frame: Frame): Promise<string> {
  const text = await ask(() => el.innerText({ timeout: 1000 }), q, "", frame);
  const aria = text ? "" : ((await ask(() => el.getAttribute("aria-label", { timeout: 1000 }), q, null, frame)) ?? "");
  // <input type="button" value="Alle ablehnen"> has no text; its value is the label.
  const value = text || aria ? "" : ((await ask(() => el.getAttribute("value", { timeout: 1000 }), q, null, frame)) ?? "");
  return (text || aria || value).replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The control's current label if it is no longer the one that was judged, else undefined. Controls
 * are found by position; a banner that re-renders can put another element at that position.
 */
export async function changedLabel(target: Pick<Found, "locator" | "frame" | "control">, q: QueryBudget): Promise<string | undefined> {
  const now = await labelOf(target.locator, q, target.frame);
  return normalizeLabel(now) === normalizeLabel(target.control.label) ? undefined : now;
}

/**
 * Frames that can hold a banner. A lazy iframe below the fold (a map in the footer) is never loaded
 * during a scan: it has no document, cannot show anything, and asking it never returns, which made
 * whole searches "incomplete". A frame that did start loading but hangs still counts.
 */
async function searchableFrames(page: Page, q: QueryBudget): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && frame.url() === "") {
      const parent = frame.parentFrame() ?? page.mainFrame();
      const lazyOffscreen = await ask(
        async () => {
          const el = await frame.frameElement();
          return el.evaluate((x) => (x as HTMLIFrameElement).loading === "lazy" && (x as HTMLIFrameElement).getBoundingClientRect().top > innerHeight * 1.5);
        },
        q,
        false,
        parent,
      );
      if (lazyOffscreen) continue;
    }
    out.push(frame);
  }
  return out;
}

async function bySelector(page: Page, selector: string, q: QueryBudget): Promise<Found | undefined> {
  for (const frame of await searchableFrames(page, q)) {
    const locator = frame.locator(selector).first();
    if (await ask(() => locator.isVisible(), q, false, frame)) {
      return { locator, frame, control: { label: (await labelOf(locator, q, frame)) || selector, method: "cmp-selector" } };
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
function markPlainControls(args: { source: string; flags: string; mark: string; max: number; anywhere: boolean }): number {
  const candidate = new RegExp(args.source, args.flags);
  // Walk out of open shadow roots too: a web-component banner's content is not part of the host and
  // not reachable through a "body *" query. Same walk as isOverlayElement.
  const up = (n: Element): Element | null => n.parentElement ?? ((n.getRootNode() as { host?: Element }).host ?? null);
  // A fixed wrapper around the whole page (smooth-scroll and app shells) is the page, not an overlay:
  // it holds <main>, many links, a visible text field of a form, or most of the page's elements.
  const pageShell = (x: Element): boolean => {
    if (x.querySelector("main") || x.querySelectorAll("a[href]").length > 100) return true;
    const field = Array.from(x.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], input:not([type]), textarea")).some(
      (f) => f.getBoundingClientRect().width > 0,
    );
    const all = document.body?.querySelectorAll("*").length ?? 0;
    return field || (all >= 40 && x.querySelectorAll("*").length >= all * 0.6);
  };
  const inOverlay = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = up(n)) {
      // A content blocker ("load this video / map") is no banner, also when it is a fixed lightbox.
      if (/blocker|blocked|placeholder|embed|video|youtube|vimeo|opt-?out|\bmaps?\b/i.test(`${n.id} ${n.getAttribute("class") ?? ""}`)) return false;
      const position = getComputedStyle(n).position;
      if ((position === "fixed" || position === "sticky") && !pageShell(n)) return true;
      const role = n.getAttribute("role");
      if (role === "dialog" || role === "alertdialog" || n.getAttribute("aria-modal") === "true" || n.tagName === "DIALOG") return true;
      // Same rule as isOverlayElement: a container the site names as its cookie or consent UI.
      if (n.tagName !== "BODY" && n.tagName !== "HTML" && /cookie|consent|gdpr/i.test(`${n.tagName} ${n.id} ${n.getAttribute("class") ?? ""}`)) {
        if (((n as HTMLElement).innerText || "").length < 4000) return true;
      }
    }
    return false;
  };
  let marked = 0;
  // The page's own elements plus the content of every open shadow root, like cookieOverlayVisible.
  const all: Element[] = [];
  const walk = (root: Element | ShadowRoot) => {
    for (const e of Array.from(root.querySelectorAll("*"))) {
      all.push(e);
      if (e.shadowRoot) walk(e.shadowRoot);
    }
  };
  if (document.body) walk(document.body);
  for (const el of all) {
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
    if (rect.width === 0 || rect.height === 0 || (!args.anywhere && !inOverlay(el))) continue;
    el.setAttribute(args.mark, "");
    marked += 1;
  }
  return marked;
}

/**
 * Indices (at most `max`) of the elements that sit in an overlay, in one call. Same rule as
 * isOverlayElement (page functions cannot share code). Without this pre-filter, a page with many
 * matching links ("Erlaubnis", "Zustimmung" in headlines) pushed the banner's controls past the cap.
 */
function overlayIndices(els: Element[], max: number): number[] {
  const up = (n: Element): Element | null => n.parentElement ?? ((n.getRootNode() as { host?: Element }).host ?? null);
  // A fixed wrapper around the whole page (smooth-scroll and app shells) is the page, not an overlay:
  // it holds <main>, many links, a visible text field of a form, or most of the page's elements.
  const pageShell = (x: Element): boolean => {
    if (x.querySelector("main") || x.querySelectorAll("a[href]").length > 100) return true;
    const field = Array.from(x.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], input:not([type]), textarea")).some(
      (f) => f.getBoundingClientRect().width > 0,
    );
    const all = document.body?.querySelectorAll("*").length ?? 0;
    return field || (all >= 40 && x.querySelectorAll("*").length >= all * 0.6);
  };
  const inOverlay = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = up(n)) {
      // A content blocker ("load this video / map") is no banner, also when it is a fixed lightbox.
      if (/blocker|blocked|placeholder|embed|video|youtube|vimeo|opt-?out|\bmaps?\b/i.test(`${n.id} ${n.getAttribute("class") ?? ""}`)) return false;
      const position = getComputedStyle(n).position;
      if ((position === "fixed" || position === "sticky") && !pageShell(n)) return true;
      const role = n.getAttribute("role");
      if (role === "dialog" || role === "alertdialog" || n.getAttribute("aria-modal") === "true" || n.tagName === "DIALOG") return true;
      if (n.tagName !== "BODY" && n.tagName !== "HTML" && /cookie|consent|gdpr/i.test(`${n.tagName} ${n.id} ${n.getAttribute("class") ?? ""}`)) {
        if (((n as HTMLElement).innerText || "").length < 4000) return true;
      }
    }
    return false;
  };
  const out: number[] = [];
  for (let i = 0; i < els.length && out.length < max; i += 1) {
    const el = els[i];
    if (el && inOverlay(el)) out.push(i);
  }
  return out;
}

/**
 * `anywhere`: the whole page is the consent choice (a consent wall the site redirected to), so
 * controls count without sitting in an overlay.
 */
async function byText(page: Page, q: QueryBudget, anywhere = false): Promise<Pick<Controls, "reject" | "accept" | "rejectLike" | "ok">> {
  const out: Pick<Controls, "reject" | "accept" | "rejectLike" | "ok"> = {};
  const candidates = CANDIDATE_LABEL;
  for (const frame of await searchableFrames(page, q)) {
    // A cross-origin banner frame is itself the overlay; everything inside it qualifies.
    const frameIsOverlay =
      frame !== page.mainFrame() &&
      (await ask(async () => {
        const el = await frame.frameElement();
        return el.evaluate(isOverlayElement);
      }, q, false, page.mainFrame()));
    for (const role of ["button", "link"] as const) {
      const all = frame.getByRole(role, { name: candidates });
      const total = await ask(() => all.count(), q, 0, frame);
      const indices =
        anywhere || frameIsOverlay
          ? [...Array(Math.min(total, 15)).keys()]
          : await ask(() => all.evaluateAll(overlayIndices, 15), q, [] as number[], frame);
      for (const i of indices) {
        const locator = all.nth(i);
        if (!(await ask(() => locator.isVisible(), q, false, frame))) continue;
        const label = await labelOf(locator, q, frame);
        if (!label || label.length > MAX_LABEL) continue;
        if (!anywhere && !(await inOverlay(locator, frame, page, q))) continue;
        if (await ask(() => locator.evaluate(isChoicePart), q, false, frame)) continue;
        if (!(await ask(() => locator.evaluate(hasConsentContext), q, false, frame))) continue;
        const found: Found = { locator, frame, control: { label, method: "text" } };
        if (isRejectLabel(label)) out.reject ??= found;
        else if (isAcceptLabel(label)) out.accept ??= found;
        else if (isOkLabel(label)) out.ok ??= found;
        else if (isRejectLike(label)) out.rejectLike ??= label;
      }
    }
    if (out.reject && out.accept) continue;
    const args = { source: candidates.source, flags: candidates.flags, mark: PLAIN_MARK, max: MAX_LABEL, anywhere };
    if ((await ask(() => frame.evaluate(markPlainControls, args), q, 0, frame)) === 0) continue;
    const plain = frame.locator(`[${PLAIN_MARK}]`);
    const count = Math.min(await ask(() => plain.count(), q, 0, frame), 15);
    for (let i = 0; i < count; i++) {
      const locator = plain.nth(i);
      if (!(await ask(() => locator.isVisible(), q, false, frame))) continue;
      const label = await labelOf(locator, q, frame);
      if (!label || label.length > MAX_LABEL) continue;
      if (!(await ask(() => locator.evaluate(hasConsentContext), q, false, frame))) continue;
      const found: Found = { locator, frame, control: { label, method: "text" } };
      if (isRejectLabel(label)) out.reject ??= found;
      else if (isAcceptLabel(label)) out.accept ??= found;
      else if (isOkLabel(label)) out.ok ??= found;
      else if (isRejectLike(label)) out.rejectLike ??= label;
    }
  }
  return out;
}

/** True when both controls sit in the same overlay (the nearest fixed, sticky, dialog or named consent box). */
async function sameBanner(a: Found, b: Found, q: QueryBudget): Promise<boolean> {
  if (a.frame !== b.frame) return false;
  const other = await ask(() => b.locator.elementHandle({ timeout: 1000 }), q, null, b.frame);
  if (!other) return false;
  return ask(
    () =>
      a.locator.evaluate((x, y) => {
        const up = (n: Element): Element | null => n.parentElement ?? ((n.getRootNode() as { host?: Element }).host ?? null);
        let box: Element | null = null;
        // Start above the control: consent tools name the buttons themselves too ("cc-btn submit-consent").
        for (let n: Element | null = up(x); n && n.tagName !== "BODY"; n = up(n)) {
          const style = getComputedStyle(n);
          const role = n.getAttribute("role");
          const named = /cookie|consent|gdpr/i.test(`${n.id} ${n.getAttribute("class") ?? ""}`);
          if (style.position === "fixed" || style.position === "sticky" || role === "dialog" || role === "alertdialog" || n.tagName === "DIALOG" || named) {
            box = n;
            break;
          }
        }
        if (!box) return false;
        for (let n: Element | null = y as Element; n; n = up(n)) if (n === box) return true;
        return false;
      }, other),
    q,
    false,
    a.frame,
  );
}

async function scanOnce(page: Page, q: QueryBudget, anywhere = false): Promise<Controls> {
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
  const text = await byText(page, q, anywhere);
  controls.reject ??= text.reject;
  controls.accept ??= text.accept;
  if (!controls.accept && text.ok && controls.reject && (await sameBanner(text.ok, controls.reject, q))) controls.accept = text.ok;
  if (!controls.reject) controls.rejectLike = text.rejectLike;
  return controls;
}

/** Poll until a banner control shows up (banners often render late), then re-scan once for the second button. */
export async function locateControls(page: Page, waitMs: number, q: QueryBudget, anywhere = false): Promise<Controls> {
  const deadline = Date.now() + waitMs;
  do {
    // The scan may have been stopped (deadline, unresponsive page); do not keep asking a closed page.
    if (page.isClosed()) return {};
    const first = await scanOnce(page, q, anywhere);
    if (first.accept || first.reject) {
      await page.waitForTimeout(300);
      const second = await scanOnce(page, q, anywhere);
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

/** True when a visible overlay or named consent container mentions cookies, even if no control could be recognized. */
async function cookieOverlayVisible(page: Page, q: QueryBudget): Promise<boolean> {
  for (const frame of await searchableFrames(page, q)) {
    const hit = await ask(
      () => frame.evaluate(() => {
        // Include the content of open shadow roots: some banners are web components.
        const all: Element[] = [];
        const walk = (root: Document | ShadowRoot) => {
          for (const e of Array.from(root.querySelectorAll("*"))) {
            all.push(e);
            if (e.shadowRoot) walk(e.shadowRoot);
          }
        };
        walk(document);
        for (const el of all) {
          if (el.tagName === "HTML" || el.tagName === "BODY" || el.tagName === "HEAD") continue;
          const style = getComputedStyle(el);
          const named = /cookie|consent|gdpr/i.test(`${el.tagName} ${el.id} ${el.getAttribute("class") ?? ""}`);
          if (style.position !== "fixed" && style.position !== "sticky" && !named) continue;
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
  /** Basic-auth credentials from the URL (password-protected test sites). */
  httpCredentials?: HttpCredentials;
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
  const context = await browser.newContext(visitorContextOptions(o.identity, o.httpCredentials));
  try {
    const raw: RawRequest[] = [];
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
    recordRequests(page, raw);

    await openPage(page, url, o.timeoutMs).catch((err: unknown) => {
      throw explainNavigationError(err, o.timeoutMs);
    });

    // On a consent wall the site redirected to, the whole page is the consent choice.
    const wall = isConsentWallRedirect(url, page.url());
    const controls = await locateControls(page, o.bannerWaitMs, q, wall);
    const banner: ConsentBanner = {
      detected: Boolean(controls.accept || controls.reject),
      cmp: controls.cmp,
      rejectFound: Boolean(controls.reject),
      acceptFound: Boolean(controls.accept),
      rejectLike: controls.rejectLike,
      overlayHint: controls.accept || controls.reject ? undefined : await cookieOverlayVisible(page, q),
    };
    // A frozen frame hides controls: never report "no banner" when parts of the page did not answer,
    // and never "no reject control" when the search for it did not finish.
    if (q.timeouts > 0 && !banner.detected) banner.incomplete = true;
    if (q.timeouts > 0 && banner.detected && !banner.rejectFound) banner.rejectSearchIncomplete = true;
    const target = action === "reject" ? controls.reject : controls.accept;
    const session: ConsentSession = { action, clicked: false, requestsAfter: [], cookiesBefore: [], cookiesAfter: [] };
    if (!target) {
      await shot(page, o.screenshotDir, `${action}-0-no-control-found.png`);
      return { banner, session };
    }

    const pageHost = new URL(page.url()).hostname;
    session.control = target.control;
    // The control is found by position; if the page re-rendered since, that position may hold another
    // element now. Only click when the label is still the one that was judged.
    if (target.control.method === "text") {
      const now = await changedLabel(target, q);
      if (now !== undefined) {
        session.error = `click skipped: the control changed before the click (now "${now.slice(0, 40)}")`;
        await shot(page, o.screenshotDir, `${action}-0-control-changed.png`);
        return { banner, session };
      }
    }
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
