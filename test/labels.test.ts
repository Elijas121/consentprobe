import { describe, expect, it } from "vitest";
import { CANDIDATE_LABEL, isAcceptLabel, isRejectLabel } from "../src/consent.js";

describe("banner wording seen on large sites", () => {
  const accept = ["Geht klar", "Allen Zwecken zustimmen", "Allen zustimmen", "Allen Cookies zustimmen", "Alle Cookies zulassen", "Accept everything 🍪"];
  const reject = ["Nur notwendige Cookies", "Nur erforderliche Cookies zulassen", "Einwilligung ablehnen", "Optionale Cookies ablehnen"];

  it("recognizes general accept and reject labels, and every one passes the pre-filter", () => {
    for (const l of accept) {
      expect(isAcceptLabel(l), l).toBe(true);
      expect(CANDIDATE_LABEL.test(l), l).toBe(true);
    }
    for (const l of reject) {
      expect(isRejectLabel(l), l).toBe(true);
      expect(CANDIDATE_LABEL.test(l), l).toBe(true);
    }
  });

  it("does not take a single-service opt-out as a general reject", () => {
    for (const l of ["Einwilligung für Partner X ablehnen", "Marketing-Cookies ablehnen", "Optionale Cookies verwalten"]) {
      expect(isRejectLabel(l), l).toBe(false);
    }
  });

  it("does not take partial or opposite wording as a general accept", () => {
    for (const l of ["Allen Zwecken widersprechen", "Allen Partnern zustimmen", "Geht klar, aber nur notwendige", "Klar"]) {
      expect(isAcceptLabel(l), l).toBe(false);
    }
  });
});
