export interface PendingOAuthAuthorization<T> {
  targetId: string;
  generation: number;
  expiresAt: number;
  payload: T;
}

export class StaleOAuthAuthorizationError extends Error {
  constructor() {
    super('The connection request was cancelled. Start a new connection if you still want to connect Gmail.');
  }
}

/**
 * Tracks one current OAuth attempt per connection target. Consuming a callback
 * removes its state token, while the generation remains available to detect a
 * disconnect that happens during the remote token/profile requests.
 */
export class PendingOAuthAuthorizations<T> {
  private readonly entries = new Map<string, PendingOAuthAuthorization<T>>();
  private readonly generations = new Map<string, number>();

  begin(
    state: string,
    targetId: string,
    expiresAt: number,
    payload: T,
  ): PendingOAuthAuthorization<T> {
    const generation = this.bump(targetId);
    this.deleteTargetEntries(targetId);
    const pending = { targetId, generation, expiresAt, payload };
    this.entries.set(state, pending);
    return pending;
  }

  consume(state: string): PendingOAuthAuthorization<T> | undefined {
    const pending = this.entries.get(state);
    this.entries.delete(state);
    return pending;
  }

  cancel(targetId: string): void {
    this.bump(targetId);
    this.deleteTargetEntries(targetId);
  }

  assertCurrent(pending: PendingOAuthAuthorization<T>): void {
    if (this.generations.get(pending.targetId) !== pending.generation) {
      throw new StaleOAuthAuthorizationError();
    }
  }

  pruneExpired(now: number): void {
    for (const [state, pending] of this.entries) {
      if (pending.expiresAt < now) this.entries.delete(state);
    }
  }

  private bump(targetId: string): number {
    const generation = (this.generations.get(targetId) ?? 0) + 1;
    this.generations.set(targetId, generation);
    return generation;
  }

  private deleteTargetEntries(targetId: string): void {
    for (const [state, pending] of this.entries) {
      if (pending.targetId === targetId) this.entries.delete(state);
    }
  }
}
