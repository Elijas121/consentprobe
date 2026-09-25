import { CATEGORY_SEVERITY } from "./rules.js";
import type { Category, TrackerRule } from "./types.js";

/** Most people type "example.de", not "https://example.de". Anything without a scheme gets https://. */
export function normalizeUrlInput(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be scanned, got "${url.protocol}".`);
  }
  return url.href;
}

/** A duration in milliseconds: a whole number, at least `min`. */
export function parseMs(option: string, value: string, min: number): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`--${option} needs a whole number of milliseconds, got "${value}".`);
  const ms = Number(value);
  if (ms < min) throw new Error(`--${option} must be at least ${min} ms, got ${ms}.`);
  return ms;
}

const CATEGORIES = Object.keys(CATEGORY_SEVERITY) as Category[];

/** Validate a --rules file, so a typo fails loudly instead of silently matching nothing. */
export function parseRules(json: string): TrackerRule[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`the file is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!Array.isArray(data)) throw new Error("the file must contain a JSON array of rules.");
  return data.map((item: unknown, i) => {
    const where = `rule ${i + 1}`;
    if (typeof item !== "object" || item === null) throw new Error(`${where} is not an object.`);
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) throw new Error(`${where} needs an "id" string.`);
    if (typeof r.name !== "string" || !r.name) throw new Error(`${where} ("${r.id}") needs a "name" string.`);
    if (typeof r.category !== "string" || !CATEGORIES.includes(r.category as Category)) {
      throw new Error(`${where} ("${r.id}") has an unknown category "${String(r.category)}". Use one of: ${CATEGORIES.join(", ")}.`);
    }
    if (!Array.isArray(r.hosts) || r.hosts.length === 0 || !r.hosts.every((h) => typeof h === "string" && h.length > 0)) {
      throw new Error(`${where} ("${r.id}") needs "hosts": a non-empty list of host names.`);
    }
    if (r.pathPrefix !== undefined && (typeof r.pathPrefix !== "string" || !r.pathPrefix.startsWith("/"))) {
      throw new Error(`${where} ("${r.id}") has a "pathPrefix" that does not start with "/".`);
    }
    return {
      id: r.id,
      name: r.name,
      category: r.category as Category,
      hosts: (r.hosts as string[]).map((h) => h.toLowerCase()),
      ...(r.pathPrefix ? { pathPrefix: r.pathPrefix as string } : {}),
    };
  });
}
