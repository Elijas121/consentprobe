#!/usr/bin/env node
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { normalizeUrlInput, parseMs, parseRules } from "./input.js";
import { formatJson, formatMarkdown, formatText, plain } from "./report.js";
import { scan } from "./scan.js";
import { VERSION } from "./version.js";
import type { ScanOptions, Severity } from "./types.js";

const HELP = `consentprobe ${VERSION}
Measure what a website does before and after a visitor answers the cookie banner.

Usage: consentprobe <url> [options]      (https:// is added when the URL has no scheme)

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
  --imprint <auto|always|never>  German rules: auto = German page language, a .de/.at/.li domain,
                            or a .ch domain without another page language;
                            always = force them (imprint check, missing privacy link is an error);
                            never = no imprint check (default: auto)
  --rules <file>            JSON file with extra tracker rules
  --install-browser         Download the Chromium version this consentprobe was tested with, then exit
                            (add --with-deps on Linux to install system libraries too; needs root)
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage or runtime error.
Technical findings only; this is not legal advice.`;

/** Report a usage or runtime error. The exit code is set, not forced, so piped output is not cut off. */
function fail(message: string): void {
  // Error texts can quote the page (a thrown script error); keep them to one printable line.
  process.stderr.write(`consentprobe: ${plain(message)}\n`);
  process.exitCode = 2;
}

/**
 * Run the installer of the Playwright version bundled with consentprobe, so the browser matches it.
 * A plain "npx playwright install" may fetch a newer Playwright whose browser build does not fit.
 */
async function installBrowser(withDeps: boolean): Promise<void> {
  const pkg = createRequire(import.meta.url).resolve("playwright/package.json");
  const cli = pkg.replace(/package\.json$/, "cli.js");
  const args = [cli, "install", ...(withDeps ? ["--with-deps"] : []), "chromium"];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", () => resolve(2));
    child.on("exit", (c) => resolve(c ?? 2));
  });
  if (code !== 0) return fail("the browser download failed; see the output above.");
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
        "install-browser": { type: "boolean" },
        "with-deps": { type: "boolean" },
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
  if (values["install-browser"]) return installBrowser(Boolean(values["with-deps"]));
  const [input] = positionals;
  if (!input) return fail("missing <url>. Try --help.");
  if (positionals.length > 1) return fail(`one URL at a time, got ${positionals.length}: ${positionals.join(" ")}. Use scripts/scan-list.sh for lists.`);
  let url: string;
  try {
    url = normalizeUrlInput(input);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const format = values.format;
  if (format !== "text" && format !== "json" && format !== "md") return fail(`unknown --format "${format}"`);
  const failOn = values["fail-on"];
  if (failOn !== "error" && failOn !== "warn" && failOn !== "never") return fail(`unknown --fail-on "${failOn}"`);
  const browser = values.browser;
  if (browser !== "chromium" && browser !== "chrome") return fail(`unknown --browser "${browser}"`);

  const imprint = values.imprint;
  if (imprint !== "auto" && imprint !== "always" && imprint !== "never") return fail(`unknown --imprint "${imprint}"`);
  const options: ScanOptions = { browser, imprint, firstParty: values["first-party"] ?? [], screenshotDir: values.screenshots };
  try {
    if (values.settle !== undefined) options.settleMs = parseMs("settle", values.settle, 0);
    if (values.timeout !== undefined) options.timeoutMs = parseMs("timeout", values.timeout, 1000);
    if (values["banner-wait"] !== undefined) options.bannerWaitMs = parseMs("banner-wait", values["banner-wait"], 0);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (values["no-click-test"]) options.clickTest = false;
  if (values.rules) {
    let json: string;
    try {
      json = await readFile(values.rules, "utf8");
    } catch (err) {
      return fail(`cannot read --rules file "${values.rules}": ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      options.extraRules = parseRules(json);
    } catch (err) {
      return fail(`--rules file "${values.rules}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Check the output locations before the (slow) scan, so a typo does not throw away its result.
  try {
    if (values.out) {
      await mkdir(dirname(values.out), { recursive: true });
      await access(dirname(values.out), constants.W_OK);
    }
    if (values.screenshots) {
      await mkdir(values.screenshots, { recursive: true });
      await access(values.screenshots, constants.W_OK);
    }
  } catch (err) {
    return fail(`cannot write to the output location: ${err instanceof Error ? err.message : String(err)}`);
  }

  let result;
  try {
    result = await scan(url, options);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const output = format === "json" ? formatJson(result) : format === "md" ? formatMarkdown(result) : formatText(result);
  if (values.out) {
    try {
      await mkdir(dirname(values.out), { recursive: true });
      await writeFile(values.out, `${output}\n`);
    } catch (err) {
      return fail(`cannot write --out file "${values.out}": ${err instanceof Error ? err.message : String(err)}`);
    }
  } else process.stdout.write(`${output}\n`);

  const threshold: Severity[] = failOn === "error" ? ["error"] : failOn === "warn" ? ["error", "warn"] : [];
  if (result.findings.some((f) => threshold.includes(f.severity))) process.exitCode = 1;
}

await main();
// Safety net: if anything still holds the event loop after the scan, end anyway. The timer is
// unref'd, so it never delays a normal exit.
setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
