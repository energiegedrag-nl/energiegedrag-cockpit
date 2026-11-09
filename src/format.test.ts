import { describe, expect, it } from "vitest";
import { ago, durationLabel, fromDateInput, toDateInput } from "./format";

describe("ago", () => {
  const now = 1_800_000_000;
  it("handles missing times", () => expect(ago(null, now)).toBe("–"));
  it("says just now", () => expect(ago(now - 30, now)).toBe("zojuist"));
  it("uses minutes, hours and days", () => {
    expect(ago(now - 10 * 60, now)).toBe("10 min geleden");
    expect(ago(now - 5 * 3600, now)).toBe("5 uur geleden");
    expect(ago(now - 86400 * 1.6, now)).toBe("2 dagen geleden");
  });
});

describe("durationLabel", () => {
  it("reads days, hours and minutes", () => {
    expect(durationLabel("P1D")).toBe("1 dag");
    expect(durationLabel("P2DT6H")).toBe("2 dagen 6 uur");
    expect(durationLabel("PT30M")).toBe("30 min");
  });
  it("keeps what it cannot read", () => expect(durationLabel("P1Y")).toBe("P1Y"));
  it("says none for empty", () => expect(durationLabel("")).toBe("geen"));
});

describe("date inputs", () => {
  it("round-trips a local date", () => {
    const unix = fromDateInput("2026-11-10");
    expect(unix).toBeDefined();
    expect(toDateInput(unix)).toBe("2026-11-10");
  });
  it("rejects garbage", () => expect(fromDateInput("10-11-2026")).toBeUndefined());
});
