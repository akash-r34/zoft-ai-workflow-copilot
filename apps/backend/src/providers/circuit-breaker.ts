// Per-provider circuit breaker for ProviderRouter (router.ts). Classic
// closed/open/half-open state machine:
//   - CLOSED: attempts allowed; counts consecutive failures; trips OPEN at
//     `failureThreshold`.
//   - OPEN: attempts blocked until `cooldownMs` has elapsed since it
//     opened, then transitions to HALF_OPEN.
//   - HALF_OPEN: one trial allowed — success resets to CLOSED, failure
//     reopens (restarting the cooldown clock).
// `now` is injected so tests can drive transitions without real timers.
export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private syncHalfOpen(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half_open";
    }
  }

  canAttempt(): boolean {
    this.syncHalfOpen();
    return this.state !== "open";
  }

  onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  onFailure(): void {
    this.syncHalfOpen();
    if (this.state === "half_open") {
      // The one trial this state grants has failed — reopen and restart the cooldown.
      this.state = "open";
      this.openedAt = this.now();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  getState(): BreakerState {
    this.syncHalfOpen();
    return this.state;
  }
}
