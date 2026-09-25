import { describe, expect, it } from "vitest";
import { normalizeUrlInput, parseMs, parseRules } from "../src/input.js";

describe("URL input", () => {
  it("adds https:// when the scheme is missing", () => {
    expect(normalizeUrlInput("example.com")).toBe("https://example.com/");
    expect(normalizeUrlInput(" www.example.de/impressum ")).toBe("https://www.example.de/impressum");
    expect(normalizeUrlInput("localhost:3000/a")).toBe("https://localhost:3000/a");
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
  });
});
