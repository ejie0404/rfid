import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerModule = new URL("../apps/api/dist/scheduled-move-out-worker.js", import.meta.url).href;

test("standalone worker stays alive between polls and stops on SIGTERM", async (context) => {
  const childSource = `
    import { startScheduledMoveOutWorker } from ${JSON.stringify(workerModule)};
    const worker = startScheduledMoveOutWorker({
      async acquireScheduledMoveOutWorkerLease() { return async () => {}; },
      async processDueScheduledMoveOuts() { console.log("pass"); return []; },
    }, { intervalMs: 25 });
    process.once("SIGTERM", () => {
      void worker.stop().then(
        () => console.log("stopped"),
        (error) => { console.error(error); process.exitCode = 1; },
      );
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  let passesReached;
  const threePasses = new Promise((resolvePasses, rejectPasses) => {
    passesReached = setTimeout(
      () => rejectPasses(new Error("worker exited or missed its polling deadline")),
      2_000,
    );
    child.stdout.on("data", () => {
      if ((stdout.match(/^pass$/gm) ?? []).length >= 3) {
        clearTimeout(passesReached);
        resolvePasses();
      }
    });
    child.once("error", rejectPasses);
    child.once("exit", (code, signal) => {
      if ((stdout.match(/^pass$/gm) ?? []).length < 3)
        rejectPasses(
          new Error(`worker exited before three passes (code=${code}, signal=${signal})`),
        );
    });
  });

  context.after(() => {
    clearTimeout(passesReached);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  await threePasses;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.match(stdout, /stopped/);
});
