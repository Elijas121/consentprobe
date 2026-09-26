import { createRequire } from "node:module";

export const VERSION = "0.1.0";

/** Version of the Playwright package in use (it decides the browser build). */
export const PLAYWRIGHT_VERSION: string = (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
