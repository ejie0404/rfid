import { createApp } from "./app.js";
const { app, store } = await createApp({ logger: true });
await app.listen(Number(process.env.PORT || 4100), "127.0.0.1");
let stopping = false;
let processingDueMoveOuts: Promise<void> | null = null;
const processDueMoveOuts = () => {
  if (processingDueMoveOuts) return processingDueMoveOuts;
  if (stopping) return Promise.resolve();
  const task = (async () => {
    try {
      const results = await store.processDueScheduledMoveOuts();
      for (const result of results)
        if (result.status === "failed")
          console.error(
            "Scheduled move-out processing failed; it will be retried.",
            result.schedule_id,
            result.error,
            result.retry_at,
          );
    } catch (error) {
      console.error("Could not check due scheduled move-outs.", error);
    } finally {
      processingDueMoveOuts = null;
    }
  })();
  processingDueMoveOuts = task;
  return task;
};
void processDueMoveOuts();
const moveOutWorker = setInterval(() => void processDueMoveOuts(), 15_000);
moveOutWorker.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(moveOutWorker);
    await app.close();
    await processingDueMoveOuts;
    await store.close();
    process.exit(0);
  });
