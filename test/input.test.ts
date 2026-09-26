import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { normalizeUrlInput, parseMs, parseRules } from "../src/input.js";

describe("URL input", () => {
  it("adds https:// when the scheme is missing", () => {
    expect(normalizeUrlInput("example.com")).toBe("https://example.com/");
    expect(normalizeUrlInput(" www.example.de/impressum ")).toBe("https://www.example.de/impressum");
  });

  it("uses http:// for localhost and IP addresses, which are nearly always local test servers", () => {
    expect(normalizeUrlInput("localhost:3000/a")).toBe("http://localhost:3000/a");
    expect(normalizeUrlInput("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(normalizeUrlInput("localhost.example.com")).toBe("https://localhost.example.com/");
  });

  it("keeps an explicit http or https URL", () => {
    expect(normalizeUrlInput("http://example.com/x?y=1")).toBe("http://example.com/x?y=1");
    expect(normalizeUrlInput("HTTPS://Example.com")).toBe("https://example.com/");
  });

  it("refuses other schemes and nonsense with a readable message", () => {
    expect(() => normalizeUrlInput("ftp://example.com")).toThrow(/Only http and https/);
    expect(() => normalizeUrlInput("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => normalizeUrlInput("exa mple.com")).toThrow(/not a valid URL/);
  });
});

describe("millisecond options", () => {
  it("accepts whole numbers at or above the minimum", () => {
    expect(parseMs("settle", "0", 0)).toBe(0);
    expect(parseMs("timeout", "30000", 1000)).toBe(30000);
  });

  it("refuses text, negatives, fractions and values below the minimum", () => {
    expect(() => parseMs("timeout", "abc", 1000)).toThrow(/whole number/);
    expect(() => parseMs("settle", "-5", 0)).toThrow(/whole number/);
    expect(() => parseMs("settle", "1.5", 0)).toThrow(/whole number/);
    expect(() => parseMs("timeout", "500", 1000)).toThrow(/at least 1000/);
    expect(() => parseMs("timeout", "999999999", 1000)).toThrow(/at most 600000/);
  });
});

describe("--rules files", () => {
  it("accepts a valid list and normalizes host names", () => {
    expect(parseRules('[{"id":"crm","name":"My CRM","category":"chat","hosts":["Widget.My-CRM.example"],"pathPrefix":"/w"}]')).toEqual([
      { id: "crm", name: "My CRM", category: "chat", hosts: ["widget.my-crm.example"], pathPrefix: "/w" },
    ]);
  });

  it("explains what is wrong", () => {
    expect(() => parseRules("{bad")).toThrow(/not valid JSON/);
    expect(() => parseRules('{"id":"x"}')).toThrow(/JSON array/);
    expect(() => parseRules('[{"name":"x","category":"chat","hosts":["a.example"]}]')).toThrow(/rule 1 needs an "id"/);
    expect(() => parseRules('[{"id":"x","category":"chat","hosts":["a.example"]}]')).toThrow(/needs a "name"/);
    expect(() => parseRules('[{"id":"x","name":"X","category":"tracking","hosts":["a.example"]}]')).toThrow(/unknown category "tracking".*analytics/);
    expect(() => parseRules('[{"id":"x","name":"X","category":"chat","hosts":[]}]')).toThrow(/non-empty list/);
    expect(() => parseRules('[{"id":"x","name":"X","category":"chat","hosts":["a.example"],"pathPrefix":"w"}]')).toThrow(/pathPrefix/);
    for (const host of ["https://a.example", "a.example/x", "*.a.example", "a.example:8080", "a example"]) {
      expect(() => parseRules(`[{"id":"x","name":"X","category":"chat","hosts":["${host}"]}]`), host).toThrow(/bare host name/);
    }
    for (const prefix of ["/tr/", "/a?b", "/a#b"]) {
      expect(() => parseRules(`[{"id":"x","name":"X","category":"chat","hosts":["a.example"],"pathPrefix":"${prefix}"}]`), prefix).toThrow(/pathPrefix/);
    }
  });
});

describe("exit codes of the built CLI", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8", timeout: 60000 }).status;
  it("uses 3 for a usage error and 2 for a page that cannot be measured", () => {
    expect(run("https://example.com", "--format", "pdf")).toBe(3);
    expect(run("a.example", "b.example")).toBe(3);
    // Nothing listens on port 9: the page cannot be loaded, which is the site's side, not a usage error.
    expect(run("http://127.0.0.1:9/", "--no-click-test", "--timeout", "5000")).toBe(2);
  }, 90000);
});
