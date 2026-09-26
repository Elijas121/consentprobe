import type { Finding, ScanResult, Severity } from "./types.js";

const ORDER: Severity[] = ["error", "warn", "info"];
const DISCLAIMER =
  "Technical findings only. This is not legal advice and does not assess whether a data-protection or accessibility law is violated.";
const MARKDOWN_SPECIAL = /([\\`*_{}[\]()#+\-.!|<>~])/g;

function sorted(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
}

/**
 * Page-controlled text (labels, URLs, cookie names) must not carry line breaks, terminal escape
 * sequences or bidi overrides into a report: they could fake lines, recolor a terminal or inject
 * CI workflow commands.
 */
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export function plain(text: string): string {
  return text.replace(UNSAFE, " ");
}

function escapeMarkdown(text: string): string {
  return plain(text).replace(MARKDOWN_SPECIAL, "\\$1");
}

function codeSpan(text: string): string {
  return `\`${plain(text).replaceAll("`", "'")}\``;
}

function phaseLine(r: ScanResult): string {
  return r.consent
    ? `Phase: ${r.phase} (no interaction with any cookie banner), then reject and accept visits`
    : `Phase: ${r.phase} (no interaction with any cookie banner); click test skipped`;
}

/** `esc` escapes page-controlled text (control labels, CMP name); identity for plain text. */
function bannerLine(r: ScanResult, esc: (s: string) => string = (s) => s): string {
  const c = r.consent;
  if (!c) return "Consent test: skipped";
  if (!c.banner.detected && c.banner.incomplete) return "Consent banner: search incomplete (parts of the page did not respond)";
  if (!c.banner.detected && c.banner.overlayHint) return "Consent banner: cookie overlay visible, controls not automatable";
  if (!c.banner.detected) return "Consent banner: not recognized";
  const ctl = (s?: { control?: { label: string }; clicked?: boolean }, found = false) =>
    !found ? "not found" : s?.control ? `found ("${esc(s.control.label)}")${s.clicked ? "" : ", click failed"}` : "found, not tested";
  return `Consent banner: recognized${c.banner.cmp ? ` (${esc(c.banner.cmp)})` : ""} | reject: ${ctl(c.reject, c.banner.rejectFound)} | accept: ${ctl(c.accept, c.banner.acceptFound)}`;
}

export function formatText(r: ScanResult): string {
  const lines: string[] = [
    `consentprobe ${r.tool.version}  ${plain(r.finalUrl)}`,
    phaseLine(r),
    bannerLine(r, plain),
    `${r.summary.error} error, ${r.summary.warn} warn, ${r.summary.info} info | before consent: ${r.summary.thirdPartyHosts} third-party host(s), ${r.requests.length} request(s), ${r.cookies.length} cookie(s)`,
    "",
  ];
  if (r.findings.length === 0) lines.push("No findings.");
  for (const f of sorted(r.findings)) {
    lines.push(`[${f.severity.toUpperCase()}] ${plain(f.message)}`);
    for (const e of f.evidence) lines.push(`        ${plain(e)}`);
  }
  lines.push("", DISCLAIMER);
  return lines.join("\n");
}

export function formatMarkdown(r: ScanResult): string {
  const lines: string[] = [
    `# consentprobe report`,
    "",
    `- URL: ${escapeMarkdown(r.finalUrl)}`,
    `- Scanned: ${r.scannedAt}`,
    `- ${phaseLine(r)}`,
    `- ${bannerLine(r, escapeMarkdown)}`,
    `- Result: ${r.summary.error} error, ${r.summary.warn} warn, ${r.summary.info} info`,
    `- Before consent: ${r.summary.thirdPartyHosts} third-party host(s), ${r.requests.length} request(s), ${r.cookies.length} cookie(s)`,
    "",
  ];
  for (const sev of ORDER) {
    const group = r.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()}`, "");
    for (const f of group) {
      lines.push(`- ${escapeMarkdown(f.message)}`);
      for (const e of f.evidence) lines.push(`  - ${codeSpan(e)}`);
    }
    lines.push("");
  }
  if (r.findings.length === 0) lines.push("No findings.", "");
  lines.push(`> ${DISCLAIMER}`);
  return lines.join("\n");
}
