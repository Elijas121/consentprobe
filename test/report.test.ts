import { describe, expect, it } from "vitest";
import { formatMarkdown, formatText } from "../src/report.js";
import type { ScanResult } from "../src/types.js";

describe("markdown report escaping", () => {
  const base: ScanResult = {
    tool: { name: "consentprobe", version: "0.0.0" },
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: "2026-01-01T00:00:00.000Z",
    phase: "before-consent",
    requests: [],
    cookies: [],
    legal: { imprint: { found: false }, privacy: { found: false } },
    findings: [],
    summary: { error: 0, warn: 0, info: 0, thirdPartyHosts: 0 },
  };

  it("renders page-controlled finding text literally in markdown", () => {
    const attack = "[x](https://evil.example) ![i](https://evil.example/i.png) `tick` \u001B";
    const r: ScanResult = {
      ...base,
      findings: [{ id: "md-injection-test", severity: "warn", message: attack, evidence: [attack] }],
      summary: { error: 0, warn: 1, info: 0, thirdPartyHosts: 0 },
    };

    const md = formatMarkdown(r);
    expect(md).toContain("- \\[x\\]\\(https://evil\\.example\\) \\!\\[i\\]\\(https://evil\\.example/i\\.png\\) \\`tick\\` \u001B");
    expect(md).toContain("  - `[x](https://evil.example) ![i](https://evil.example/i.png) 'tick' \u001B`");

    const txt = formatText(r);
    expect(txt).toContain(`[WARN] ${attack}`);
    expect(txt).toContain(`        ${attack}`);
  });
});
