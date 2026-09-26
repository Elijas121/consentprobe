import type { LegalLink } from "./types.js";

export interface RawAnchor {
  href: string;
  text: string;
  inFooter: boolean;
  /** A clickable element without href (the target is set by a script), e.g. a page-builder footer item. */
  scripted?: boolean;
}

interface Kind {
  label: RegExp;
  /** The whole label is exactly the standard wording, e.g. "Impressum". */
  exact: RegExp;
  path: RegExp;
}

// German and English, plus the French and Italian wording of multilingual Swiss sites.
const IMPRINT: Kind = {
  label: /(^|[^\p{L}])(impressum|imprint|legal notice|anbieterkenn(ung|zeichnung)|offenlegung|mentions l[ée]gales|note legali)(?=$|[^\p{L}])/iu,
  exact: /^(impressum|imprint|legal notice|anbieterkenn(ung|zeichnung)|offenlegung|mentions l[ée]gales|note legali)$/iu,
  path: /\/(impressum|imprint|legal-notice|anbieterkenn(ung|zeichnung)|offenlegung|mentions-legales|note-legali)([/.\-_?#]|$)/i,
};
const PRIVACY: Kind = {
  label: /(^|[^\p{L}])(datenschutz\p{L}*|privacy\p{L}*|data protection|protection des donn[ée]es|politique de confidentialit[ée]|confidentialit[ée]|informativa (sulla )?privacy|protezione dei dati)(?=$|[^\p{L}])/iu,
  exact: /^(datenschutz(erklärung|erklaerung|hinweise|bestimmungen|richtlinie)?|privacy( policy| notice| statement)?|data protection( policy| notice)?|datenschutz (&|und) cookies|protection des donn[ée]es|politique de confidentialit[ée]|confidentialit[ée]|informativa (sulla )?privacy|protezione dei dati)$/iu,
  path: /\/(datenschutz\w*|privacy\w*|data-protection|protection-des-donnees|confidentialite|politique-de-confidentialite|protezione-dei-dati)([/.\-_?#]|$)/i,
};

const MAX_LABEL = 40;
/**
 * Label 3 + path 2 + footer 3, or an exact standard label alone (5). At least 5 points count
 * as found; 2-4 points are only reported as an uncertain candidate.
 */
const MIN_SCORE = 5;
/** A matching path alone (2) is enough for a candidate: the link exists, its label is missing or unusual. */
const WEAK_SCORE = 2;

/**
 * Score a link instead of taking the first keyword hit: article headlines that merely
 * mention "Datenschutz" are long, deep in the path and outside the footer. One signal
 * alone is not enough; a short teaser like "Mehr Privatsphäre im Netz" must not count.
 */
function score(a: RawAnchor, kind: Kind): number {
  const labelHit = a.text.length > 0 && a.text.length <= MAX_LABEL && kind.label.test(a.text);
  let pathHit = false;
  try {
    pathHit = kind.path.test(new URL(a.href).pathname);
  } catch {
    pathHit = false;
  }
  if (!labelHit && !pathHit) return 0;
  const exact = kind.exact.test(a.text.replace(/\s+/g, " ").replace(/[.:]+$/, "").trim());
  return (exact ? 5 : labelHit ? 3 : 0) + (pathHit ? 2 : 0) + (a.inFooter ? 3 : 0);
}

function pick(anchors: RawAnchor[], kind: Kind): { best?: RawAnchor; weak?: RawAnchor } {
  let best: RawAnchor | undefined;
  let weak: RawAnchor | undefined;
  let bestScore = MIN_SCORE - 1;
  let weakScore = WEAK_SCORE - 1;
  for (const a of anchors) {
    const s = score(a, kind);
    if (s >= MIN_SCORE && s > bestScore) {
      best = a;
      bestScore = s;
    } else if (s >= WEAK_SCORE && s < MIN_SCORE && s > weakScore) {
      weak = a;
      weakScore = s;
    }
  }
  return { best, weak };
}

/**
 * Pure selection step; HTTP status is added by the scanner afterwards. Real links win. A scripted
 * element counts only when no real link was found and its whole text is the standard wording.
 */
export function findLegalLinks(anchors: RawAnchor[]): { imprint: LegalLink; privacy: LegalLink } {
  const real = anchors.filter((a) => !a.scripted);
  const scripted = anchors.filter((a) => a.scripted);
  const resolve = (kind: Kind): LegalLink => {
    const { best, weak } = pick(real, kind);
    if (best) return { found: true, href: best.href, text: best.text, inFooter: best.inFooter };
    const byScript = scripted.find((a) => kind.exact.test(a.text.replace(/\s+/g, " ").replace(/[.:]+$/, "").trim()));
    if (byScript) return { found: true, text: byScript.text, inFooter: byScript.inFooter, scripted: true };
    if (weak) return { found: false, candidate: { href: weak.href, text: weak.text } };
    // Courts have accepted "Kontakt" as the link to the provider details. It cannot be verified here,
    // so it is reported as an uncertain candidate, never as found and never as missing.
    const contact = kind === IMPRINT ? real.find((a) => a.inFooter && /^(kontakt|contact)$/i.test(a.text.trim())) : undefined;
    return contact ? { found: false, candidate: { href: contact.href, text: contact.text } } : { found: false };
  };
  return { imprint: resolve(IMPRINT), privacy: resolve(PRIVACY) };
}
