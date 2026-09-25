#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFixtures } from "./fixtures.js";

export interface DemoResult {
  exitCode: number;
  targetUrl: string;
  screenshotDir: string;
}

export interface DemoDeps {
  mkTempDir?: () => Promise<string>;
  runCli?: (url: string, screenshotDir: string) => Promise<number>;
}

async function runBuiltCli(url: string, screenshotDir: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", url, "--screenshots", screenshotDir, "--fail-on", "never"], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`demo cli exited with signal ${signal}`));
      else resolve(code ?? 0);
    });
  });
}

export async function runDemo(deps: DemoDeps = {}): Promise<DemoResult> {
  const mkTempDir = deps.mkTempDir ?? (() => mkdtemp(join(tmpdir(), "consentprobe-demo-")));
  const runCli = deps.runCli ?? runBuiltCli;
  const screenshotDir = await mkTempDir();

  const fixtures = await startFixtures();
  const targetUrl = `${fixtures.origin}/banner-bad`;
  try {
    const exitCode = await runCli(targetUrl, screenshotDir);
    return { exitCode, targetUrl, screenshotDir };
  } finally {
    await fixtures.close();
  }
}

async function main(): Promise<void> {
  const result = await runDemo();
  process.exitCode = result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
