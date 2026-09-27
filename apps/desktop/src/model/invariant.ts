/**
 * A fact DevHub believed about itself, found to be false.
 *
 * Raised anywhere — the model's coordinator included, for a completion of an
 * operation it never started — and never drawn: main crashes on it
 * (`main/shell/invariant.ts`), because the stack at the moment the assumption
 * broke is the whole diagnosis.
 */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}
