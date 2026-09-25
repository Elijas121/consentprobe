import { expect, test } from "vitest";
import { runDemo } from "../src/demo.js";

test("runDemo targets local banner fixture and closes servers", async () => {
  let seenUrl = "";
  let seenScreenshotsDir = "";

  const result = await runDemo({
    mkTempDir: async () => "/tmp/consentprobe-demo-test",
    runCli: async (url, screenshotsDir) => {
      seenUrl = url;
      seenScreenshotsDir = screenshotsDir;
      return 0;
    },
  });

  expect(seenUrl).toMatch(/^http:\/\/localhost:\d+\/banner-bad$/);
  expect(seenScreenshotsDir).toBe("/tmp/consentprobe-demo-test");
  expect(result).toEqual({
    exitCode: 0,
    targetUrl: seenUrl,
    screenshotDir: "/tmp/consentprobe-demo-test",
  });
  await expect(fetch(seenUrl)).rejects.toThrow();
});
