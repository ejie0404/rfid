import { createApp } from "./app.js";
const { app, store } = await createApp({ logger: true });
await app.listen(Number(process.env.PORT || 4100), "127.0.0.1");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await store.close();
    process.exit(0);
  });
