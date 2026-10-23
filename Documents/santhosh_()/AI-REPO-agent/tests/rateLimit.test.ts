import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, clearRateLimit } from "../src/middleware/rateLimit.js";

// RATE_LIMIT_SECONDS defaults to 30 in the test env.
describe("checkRateLimit", () => {
  let uid = 0;
  const user = () => `U_RL_${++uid}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows the first invocation", () => {
    expect(checkRateLimit(user())).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("blocks a second invocation inside the cooldown with a rounded-up retry", () => {
    const u = user();
    checkRateLimit(u);
    expect(checkRateLimit(u)).toEqual({ allowed: false, retryAfterSeconds: 30 });
    vi.advanceTimersByTime(10_500);
    expect(checkRateLimit(u)).toEqual({ allowed: false, retryAfterSeconds: 20 });
    vi.advanceTimersByTime(19_499);
    expect(checkRateLimit(u)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("allows again exactly when the cooldown elapses", () => {
    const u = user();
    checkRateLimit(u);
    vi.advanceTimersByTime(30_000);
    expect(checkRateLimit(u).allowed).toBe(true);
  });

  it("does not extend the window on blocked attempts", () => {
    const u = user();
    checkRateLimit(u);
    vi.advanceTimersByTime(29_000);
    expect(checkRateLimit(u).allowed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(checkRateLimit(u).allowed).toBe(true);
  });

  it("restarts the window after a successful invocation", () => {
    const u = user();
    checkRateLimit(u);
    vi.advanceTimersByTime(30_000);
    checkRateLimit(u);
    vi.advanceTimersByTime(5_000);
    expect(checkRateLimit(u)).toEqual({ allowed: false, retryAfterSeconds: 25 });
  });

  it("tracks users independently", () => {
    const a = user();
    const b = user();
    checkRateLimit(a);
    expect(checkRateLimit(b).allowed).toBe(true);
    expect(checkRateLimit(a).allowed).toBe(false);
  });

  it("clearRateLimit resets a user's cooldown", () => {
    const u = user();
    checkRateLimit(u);
    clearRateLimit(u);
    expect(checkRateLimit(u).allowed).toBe(true);
    expect(() => clearRateLimit("never-seen")).not.toThrow();
  });
});
