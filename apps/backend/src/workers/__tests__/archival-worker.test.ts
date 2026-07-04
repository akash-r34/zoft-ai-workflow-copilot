import { describe, expect, it } from "vitest";
import { cutoffDate, isArchivable } from "../archival-worker.js";

describe("isArchivable", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  it("is not archivable when created well within the retention window", () => {
    const createdAt = new Date("2026-07-01T00:00:00.000Z"); // 3 days old
    expect(isArchivable(createdAt, now, 90)).toBe(false);
  });

  it("is archivable when created well past the retention window", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z"); // ~6 months old
    expect(isArchivable(createdAt, now, 90)).toBe(true);
  });

  it("is not archivable exactly at the cutoff instant (strict less-than)", () => {
    const createdAt = cutoffDate(now, 90);
    expect(isArchivable(createdAt, now, 90)).toBe(false);
  });

  it("is archivable one millisecond past the cutoff instant", () => {
    const createdAt = new Date(cutoffDate(now, 90).getTime() - 1);
    expect(isArchivable(createdAt, now, 90)).toBe(true);
  });

  it("respects a configurable retention window", () => {
    const createdAt = new Date("2026-06-01T00:00:00.000Z"); // ~33 days old
    expect(isArchivable(createdAt, now, 90)).toBe(false);
    expect(isArchivable(createdAt, now, 30)).toBe(true);
  });
});
