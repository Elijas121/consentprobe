import type { Finding, ScanResult, Severity } from "./types.js";

const ORDER: Severity[] = ["error", "warn", "info"];
const DISCLAIMER =
  "Technical findings only. This is not legal advice and does not assess whether a data-protection or accessibility law is violated.";
const MARKDOWN_SPECIAL = /([\\`*_{}[\]()#+\-.!|>])/g;

function sorted(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
}

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, "\\$1");
}

function codeSpan(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}

function phaseLine(r: ScanResult): string {
  return r.consent
    ? `Phase: ${r.phase} (no interaction with any cookie banner), then reject and accept visits`
    : `Phase: ${r.phase} (no interaction with any cookie banner); click test skipped`;
}

function bannerLine(r: ScanResult): string {
  const c = r.consent;
  if (!c) return "Consent test: skipped";
  if (!c.banner.detected && c.banner.incomplete) return "Consent banner: search incomplete (parts of the page did not respond)";
  if (!c.banner.detected && c.banner.overlayHint) return "Consent banner: cookie overlay visible, controls not automatable";
  if (!c.banner.detected) return "Consent banner: not recognized";
  const ctl = (s?: { control?: { label: string } }, found = false) =>
    found ? (s?.control ? `found ("${s.control.label}")` : "found") : "not found";
  return `Consent banner: recognized${c.banner.cmp ? ` (${c.banner.cmp})` : ""} | reject: ${ctl(c.reject, c.banner.rejectFound)} | accept: ${ctl(c.accept, c.banner.acceptFound)}`;
}

export function formatText(r: ScanResult): string {
  const lines: string[] = [
    `consentprobe ${r.tool.version}  ${r.finalUrl}`,
    phaseLine(r),
    bannerLine(r),
    `${r.summary.error} error, ${r.summary.warn} warn, ${r.summary.info} info | ${r.summary.thirdPartyHosts} third-party host(s), ${r.requests.length} request(s), ${r.cookies.length} cookie(s)`,
    "",
  ];
  if (r.findings.length === 0) lines.push("No findings.");
  for (const f of sorted(r.findings)) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.message}`);
    for (const e of f.evidence) lines.push(`        ${e}`);
  }
  lines.push("", DISCLAIMER);
  return lines.join("\n");
}

export function formatMarkdown(r: ScanResult): string {
  const lines: string[] = [
    `# consentprobe report`,
    "",
    `- URL: ${r.finalUrl}`,
    `- Scanned: ${r.scannedAt}`,
    `- ${phaseLine(r)}`,
    `- ${bannerLine(r)}`,
    `- Result: ${r.summary.error} error, ${r.summary.warn} warn, ${r.summary.info} info`,
    `- Third-party hosts: ${r.summary.thirdPartyHosts}`,
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
