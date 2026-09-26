import { describe, expect, it } from "vitest";
import { formatJson, formatMarkdown, formatText } from "../src/report.js";
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
    // The escape character becomes a space: it could recolor a terminal or hide text.
    expect(md).toContain("- \\[x\\]\\(https://evil\\.example\\) \\!\\[i\\]\\(https://evil\\.example/i\\.png\\) \\`tick\\` ");
    expect(md).toContain("  - `[x](https://evil.example) ![i](https://evil.example/i.png) 'tick'  `");
    expect(md).not.toContain("\u001B");

    const txt = formatText(r);
    const shown = attack.replace("\u001B", " ");
    expect(txt).toContain(`[WARN] ${shown}`);
    expect(txt).toContain(`        ${shown}`);
  });

  it("escapes page-controlled control labels and the URL in the markdown banner line only", () => {
    const label = "<img src=https://evil.example/x.png>[x](https://evil.example)";
    const r: ScanResult = {
      ...base,
      finalUrl: "https://example.com/<b>~~x~~</b>",
      consent: {
        banner: { detected: true, cmp: "<i>CMP</i>", rejectFound: true, acceptFound: false },
        reject: { action: "reject", clicked: true, control: { label, method: "text" }, requestsAfter: [], cookiesBefore: [], cookiesAfter: [] },
      },
    };

    const md = formatMarkdown(r);
    expect(md).toContain('reject: found ("\\<img src=https://evil\\.example/x\\.png\\>\\[x\\]\\(https://evil\\.example\\)")');
    expect(md).toContain("recognized (\\<i\\>CMP\\</i\\>)");
    expect(md).toContain("- URL: https://example\\.com/\\<b\\>\\~\\~x\\~\\~\\</b\\>");
    expect(md).not.toMatch(/(^|[^\\])</m);

    const txt = formatText(r);
    expect(txt).toContain(`reject: found ("${label}")`);
    expect(txt).toContain("recognized (<i>CMP</i>)");
  });
});

describe("json output", () => {
  it("escapes bidi overrides and C1 controls from the page, and stays the same data", () => {
    const data = { label: "Alle \u202Eneh\u202C ablehnen\u009B31m", url: "https://e.de/\u2028x" };
    const out = formatJson(data);
    expect(out).not.toMatch(/[\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/);
    expect(out).toContain("\\u202e");
    expect(JSON.parse(out)).toEqual(data);
  });
});
