/**
 * That every reason the model can compute is a reason a person can read.
 *
 * `model/wire.test.ts` pins the other half: the diagnostic crosses the wire
 * with the state that carries it, instead of being dropped and the tag
 * arriving alone. The two together are the rule — a stop or a close that
 * failed says *why*, in one vocabulary, wherever it is shown.
 */

import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES } from "../../../model/domain";
import { closeDiagnosticLabel } from "./diagnosticLabel";

describe("the close vocabulary", () => {
  it("gives every diagnostic a sentence of its own", () => {
    const labels = DIAGNOSTIC_CODES.map(closeDiagnosticLabel);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it("never names a control somewhere else, or a code", () => {
    for (const code of DIAGNOSTIC_CODES) {
      const label = closeDiagnosticLabel(code);
      expect(label).not.toContain(code);
      expect(label).not.toMatch(/from the Sidebar/);
    }
  });
});
