#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { formatMarkdown, formatText } from "./report.js";
import { scan } from "./scan.js";
import { VERSION } from "./version.js";
import type { ScanOptions, Severity, TrackerRule } from "./types.js";

const HELP = `consentprobe ${VERSION}
Measure what a website does before a visitor answers the cookie banner.

Usage: consentprobe <url> [options]

Options:
  --format <text|json|md>   Output format (default: text)
  --out <file>              Write the report to a file instead of stdout
  --fail-on <error|warn|never>  Exit code 1 at this severity or above (default: error)
  --settle <ms>             Extra wait after load for lazy scripts (default: 3000)
  --timeout <ms>            Navigation timeout (default: 30000)
  --browser <chromium|chrome>  Bundled Chromium or installed Chrome (default: chromium)
  --no-click-test           Skip the reject/accept visits (baseline only)
  --banner-wait <ms>        How long to wait for a banner to appear (default: 4000)
  --screenshots <dir>       Save evidence screenshots before/after each banner click
  --first-party <domain>    Extra domain of the site operator, e.g. its asset CDN (repeatable)
  --imprint <auto|always|never>  Imprint check: auto = only German-language sites (default: auto)
  --rules <file>            JSON file with extra tracker rules
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage or runtime error.
Technical findings only; this is not legal advice.`;

/** Report a usage or runtime error. The exit code is set, not forced, so piped output is not cut off. */
function fail(message: string): void {
  process.stderr.write(`consentprobe: ${message}\n`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        format: { type: "string", default: "text" },
        out: { type: "string" },
        "fail-on": { type: "string", default: "error" },
        settle: { type: "string" },
        timeout: { type: "string" },
        browser: { type: "string", default: "chromium" },
        rules: { type: "string" },
        "no-click-test": { type: "boolean" },
        "first-party": { type: "string", multiple: true },
        screenshots: { type: "string" },
        imprint: { type: "string", default: "auto" },
        "banner-wait": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  if (values.help) return void process.stdout.write(`${HELP}\n`);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  const [url] = positionals;
  if (!url) return fail("missing <url>. Try --help.");

  const format = values.format;
  if (format !== "text" && format !== "json" && format !== "md") return fail(`unknown --format "${format}"`);
  const failOn = values["fail-on"];
  if (failOn !== "error" && failOn !== "warn" && failOn !== "never") return fail(`unknown --fail-on "${failOn}"`);
  const browser = values.browser;
  if (browser !== "chromium" && browser !== "chrome") return fail(`unknown --browser "${browser}"`);

  const imprint = values.imprint;
  if (imprint !== "auto" && imprint !== "always" && imprint !== "never") return fail(`unknown --imprint "${imprint}"`);
  const options: ScanOptions = { browser, imprint, firstParty: values["first-party"] ?? [], screenshotDir: values.screenshots };
  if (values.settle !== undefined) options.settleMs = Number(values.settle);
  if (values.timeout !== undefined) options.timeoutMs = Number(values.timeout);
  if (values["banner-wait"] !== undefined) options.bannerWaitMs = Number(values["banner-wait"]);
  if (values["no-click-test"]) options.clickTest = false;
  if (values.rules) {
    try {
      const { readFile } = await import("node:fs/promises");
      options.extraRules = JSON.parse(await readFile(values.rules, "utf8")) as TrackerRule[];
    } catch (err) {
      return fail(`cannot read --rules file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let result;
  try {
    result = await scan(url, options);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const output = format === "json" ? JSON.stringify(result, null, 2) : format === "md" ? formatMarkdown(result) : formatText(result);
  if (values.out) await writeFile(values.out, `${output}\n`);
  else process.stdout.write(`${output}\n`);

  const threshold: Severity[] = failOn === "error" ? ["error"] : failOn === "warn" ? ["error", "warn"] : [];
  if (result.findings.some((f) => threshold.includes(f.severity))) process.exitCode = 1;
}

await main();
// Safety net: if anything still holds the event loop after the scan, end anyway. The timer is
// unref'd, so it never delays a normal exit.
setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
