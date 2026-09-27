import { loadRuntimeConfig } from "./runtime-config.js";
import { startScheduledMoveOutWorker } from "./scheduled-move-out-worker.js";
import { Store } from "./store.js";

const config = loadRuntimeConfig();
const store = new Store();

try {
  await store.start({ demo: config.demo });
} catch (error) {
  await store.close();
  throw error;
}

const worker = startScheduledMoveOutWorker(store, {
  onFailure: (result) =>
    console.error("Scheduled move-out processing failed; retry remains queued.", {
      scheduleId: result.schedule_id,
      retryAt: result.retry_at,
    }),
  onError: (error) =>
    console.error("Move-out worker pass failed.", error instanceof Error ? error.name : "unknown"),
});

let shutdown: Promise<void> | null = null;
const stop = () => {
  if (!shutdown) {
    shutdown = (async () => {
      await worker.stop();
      await store.close();
    })();
  }
  void shutdown.catch((error) => {
    console.error(
      "Move-out worker shutdown failed.",
      error instanceof Error ? error.name : "unknown",
    );
    process.exitCode = 1;
  });
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
