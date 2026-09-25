import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runDemo } from "../src/demo.js";

test("runDemo targets local banner fixture and closes servers", async () => {
  let seenUrl = "";
  let seenScreenshotsDir = "";
  let seenRules = "";
  const dir = await mkdtemp(join(tmpdir(), "consentprobe-demo-test-"));

  const result = await runDemo({
    mkTempDir: async () => dir,
    runCli: async (url, screenshotsDir, rulesFile) => {
      seenUrl = url;
      seenScreenshotsDir = screenshotsDir;
      seenRules = await readFile(rulesFile, "utf8");
      return 0;
    },
  });

  expect(seenUrl).toMatch(/^http:\/\/localhost:\d+\/banner-bad$/);
  expect(seenScreenshotsDir).toBe(dir);
  expect(JSON.parse(seenRules)).toEqual([
    { id: "demo-analytics", name: "Demo Analytics", category: "analytics", hosts: ["127.0.0.1"] },
  ]);
  expect(result).toEqual({
    exitCode: 0,
    targetUrl: seenUrl,
    screenshotDir: dir,
  });
  await expect(fetch(seenUrl)).rejects.toThrow();
});
