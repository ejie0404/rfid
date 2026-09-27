export type ScheduledMoveOutResult = {
  schedule_id: string;
  status: string;
  retry_at?: string;
};

export interface ScheduledMoveOutWorkerStore {
  acquireScheduledMoveOutWorkerLease(): Promise<(() => Promise<void>) | null>;
  processDueScheduledMoveOuts(limit?: number): Promise<ScheduledMoveOutResult[]>;
}

export interface ScheduledMoveOutWorkerOptions {
  intervalMs?: number;
  onFailure?: (result: ScheduledMoveOutResult) => void;
  onError?: (error: unknown) => void;
}

const reportSafely = (callback: ((...args: any[]) => void) | undefined, ...args: any[]) => {
  try {
    callback?.(...args);
  } catch {
    // Logging/reporting must not prevent the worker from releasing its database lease.
  }
};

/**
 * Poll durable move-out schedules without depending on HTTP requests. A local in-flight guard
 * prevents overlapping passes in one process; Store's PostgreSQL advisory lease coordinates
 * separate worker processes. The transaction locks and idempotent moveOut path remain the final
 * protection if a worker loses its database session during a pass.
 */
export function startScheduledMoveOutWorker(
  store: ScheduledMoveOutWorkerStore,
  options: ScheduledMoveOutWorkerOptions = {},
) {
  const intervalMs = options.intervalMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
    throw new RangeError("The scheduled move-out worker interval must be a positive integer.");

  let stopping = false;
  let active: Promise<void> | null = null;

  const runOnce = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (active) return active;

    const task = (async () => {
      let releaseLease: (() => Promise<void>) | null = null;
      try {
        releaseLease = await store.acquireScheduledMoveOutWorkerLease();
        if (!releaseLease) return;
        const results = await store.processDueScheduledMoveOuts();
        for (const result of results)
          if (result.status === "failed") reportSafely(options.onFailure, result);
      } catch (error) {
        reportSafely(options.onError, error);
      } finally {
        if (releaseLease) {
          try {
            await releaseLease();
          } catch (error) {
            reportSafely(options.onError, error);
          }
        }
      }
    })();
    active = task;
    void task.finally(() => {
      if (active === task) active = null;
    });
    return task;
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  void runOnce();

  return {
    runOnce,
    async stop() {
      if (!stopping) {
        stopping = true;
        clearInterval(timer);
      }
      await active;
    },
  };
}
