// The ET helpers moved out of tick.ts, plus the two the second Worker added.
import { describe, expect, it } from "vitest";
import { etParts, isCalendarDay, shiftDay } from "../src/time";
import { etParts as fromTick } from "../src/tick";

describe("time.ts", () => {
  it("is what tick.ts re-exports", () => {
    expect(fromTick).toBe(etParts);
  });

  it("accepts only real calendar days in YYYY-MM-DD", () => {
    expect(isCalendarDay("2026-10-21")).toBe(true);
    expect(isCalendarDay("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "20261021", "2026-1-5", "", "2026-10-21T00:00", "tomorrow"]) {
      expect(isCalendarDay(bad), bad).toBe(false);
    }
  });

  it("shifts days across month and year boundaries", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftDay("2026-10-21", 0)).toBe("2026-10-21");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});
