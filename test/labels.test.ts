import { describe, expect, it } from "vitest";
import { CANDIDATE_LABEL, isAcceptLabel, isRejectLabel } from "../src/consent.js";

describe("banner wording seen on large sites", () => {
  const accept = ["Geht klar", "Allen Zwecken zustimmen", "Allen zustimmen", "Allen Cookies zustimmen", "Alle Cookies zulassen", "Accept everything 🍪", "I Accept All"];
  const reject = ["Nur notwendige Cookies", "Nur erforderliche Cookies zulassen", "Einwilligung ablehnen", "Optionale Cookies ablehnen", "Accept Only Essential Cookies", "Allow necessary cookies only", "Use strictly necessary cookies only"];

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

  it("does not take a mixed or partial English choice as a general reject", () => {
    for (const l of ["Accept all essential and marketing cookies", "Accept essential and analytics cookies", "Accept all", "Essential and functional"]) {
      expect(isRejectLabel(l), l).toBe(false);
    }
  });

  it("recognizes general controls in French, Italian, Spanish, Dutch and Polish, but not reject-and-subscribe", () => {
    const reject = ["Tout refuser", "Continuer sans accepter", "Rifiuta tutto", "Accetta solo i necessari", "Rechazar todas las cookies", "Continuar sin aceptar", "Alles weigeren", "Alleen noodzakelijke cookies", "Odrzuć wszystkie", "Tylko niezbędne"];
    const accept = ["Tout accepter", "Accepter et continuer", "J’accepte", "ACCETTA", "Accetta e chiudi", "Aceptar todas", "Alles accepteren", "Akkoord", "Akceptuję", "Zgadzam się"];
    for (const l of reject) {
      expect(isRejectLabel(l), l).toBe(true);
      expect(isAcceptLabel(l), l).toBe(false);
      expect(CANDIDATE_LABEL.test(l), l).toBe(true);
    }
    for (const l of accept) {
      expect(isAcceptLabel(l), l).toBe(true);
      expect(isRejectLabel(l), l).toBe(false);
      expect(CANDIDATE_LABEL.test(l), l).toBe(true);
    }
    for (const l of ["Rifiuta e abbonati", "Refuser et s’abonner", "Autoriser", "S’abonner", "Personalizza"]) {
      expect(isRejectLabel(l) || isAcceptLabel(l), l).toBe(false);
    }
  });

  it("does not take partial or opposite wording as a general accept", () => {
    for (const l of ["Allen Zwecken widersprechen", "Allen Partnern zustimmen", "Geht klar, aber nur notwendige", "Klar"]) {
      expect(isAcceptLabel(l), l).toBe(false);
    }
  });
});
