import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("starts closed and allows attempts", () => {
    const breaker = new CircuitBreaker(3, 1000);
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canAttempt()).toBe(true);
  });

  it("trips open after the configured number of consecutive failures", () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("closed"); // 2 of 3 — not tripped yet
    breaker.onFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("a success resets the consecutive-failure count", () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("closed"); // count reset by the success, so 2 more failures isn't 3 consecutive
  });

  it("transitions from open to half-open once the cooldown elapses (injected clock)", () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 1000, () => now);
    breaker.onFailure(); // trips open at threshold 1
    expect(breaker.getState()).toBe("open");
    expect(breaker.canAttempt()).toBe(false);

    now += 999;
    expect(breaker.canAttempt()).toBe(false); // cooldown not yet elapsed

    now += 1;
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.getState()).toBe("half_open");
  });

  it("half-open success closes the breaker and resets the failure count", () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 1000, () => now);
    breaker.onFailure();
    now += 1000;
    expect(breaker.getState()).toBe("half_open");
    breaker.onSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("half-open failure reopens and restarts the cooldown clock", () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 1000, () => now);
    breaker.onFailure(); // opens at t=0
    now += 1000; // -> half-open at t=1000
    expect(breaker.getState()).toBe("half_open");

    breaker.onFailure(); // the trial fails -> reopens, cooldown restarts at t=1000
    expect(breaker.getState()).toBe("open");

    now += 999; // t=1999, only 999ms since the NEW openedAt
    expect(breaker.canAttempt()).toBe(false);

    now += 1; // t=2000, a full 1000ms since it reopened
    expect(breaker.canAttempt()).toBe(true);
  });
});
