import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../apps/api/dist/app.js";
import { checkApiReadiness, PROBE_TIMEOUT_MS } from "../infrastructure/api-readiness-probe.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probeCli = join(root, "infrastructure", "check-api-readiness.mjs");
const publicHost = "api.example.test";
const publicOrigin = "https://control.example.test";

const config = {
  host: "0.0.0.0",
  port: 4100,
  allowedHosts: [publicHost],
};

function responseRequest(statusCode) {
  const request = new EventEmitter();
  request.destroy = () => request.emit("error", new Error("request destroyed"));
  request.end = () => {
    if (statusCode === undefined) return;
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.resume = () => queueMicrotask(() => response.emit("end"));
    queueMicrotask(() => request.emit("response", response));
  };
  return request;
}

/** Runs the probe the way the API image HEALTHCHECK does: a separate process, production settings. */
function runProbe(port, script = probeCli) {
  return new Promise((resolveRun, rejectRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: String(port),
        // Satisfies production configuration validation; the probe never opens a database session.
        DATABASE_URL: "postgresql://probe:unused@127.0.0.1:1/unused",
        SMARTGATE_DEMO: "false",
        SMARTGATE_SKIP_MIGRATIONS: "true",
        SMARTGATE_ALLOWED_ORIGINS: publicOrigin,
        SMARTGATE_ALLOWED_HOSTS: publicHost,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolveRun({ code, signal, output, ms: Date.now() - started });
    });
  });
}

/** An embedded API fixture that allows only the public hostname, as production configuration does. */
async function startExactHostApi() {
  const names = ["SMARTGATE_ALLOWED_HOSTS", "SMARTGATE_ALLOWED_ORIGINS", "SMARTGATE_TEST_POSTGRES"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  process.env.SMARTGATE_ALLOWED_HOSTS = publicHost;
  process.env.SMARTGATE_ALLOWED_ORIGINS = publicOrigin;
  // This suite rewrites a migration checksum, so it always uses throwaway embedded state.
  delete process.env.SMARTGATE_TEST_POSTGRES;
  try {
    return await createApp({ test: true });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("API readiness probe connects locally with the exact configured public Host", async () => {
  let received;
  const ready = await checkApiReadiness(config, (options) => {
    received = options;
    return responseRequest(200);
  });

  assert.equal(ready, true);
  assert.deepEqual(received, {
    hostname: "127.0.0.1",
    port: 4100,
    method: "GET",
    path: "/health/ready",
    headers: { host: publicHost },
  });
});

test("API readiness probe fails closed for non-ready responses and connection errors", async () => {
  assert.equal(await checkApiReadiness(config, () => responseRequest(503)), false);
  assert.equal(await checkApiReadiness(config, () => responseRequest(403)), false);
  assert.equal(
    await checkApiReadiness(config, () => {
      const request = new EventEmitter();
      request.destroy = () => request.emit("error", new Error("connection refused"));
      request.end = () =>
        queueMicrotask(() => request.emit("error", new Error("connection refused")));
      return request;
    }),
    false,
  );
});

test("readiness probe process passes and fails with the API's exact public-host policy", async (t) => {
  const { app, store } = await startExactHostApi();
  let listening = true;
  t.after(async () => {
    if (listening) await app.close();
    await store.close();
  });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  assert.notEqual(port, 4100, "the fixture exercises a non-default port");
  const get = (url, headers) => app.inject({ method: "GET", url, headers });

  const ready = await runProbe(port);
  assert.equal(ready.code, 0, ready.output);
  assert.equal(ready.output, "", "a passing probe prints nothing");
  assert.equal((await get("/health/ready", { host: publicHost })).statusCode, 200);
  assert.equal(
    (await get("/health/ready", { host: `127.0.0.1:${port}` })).statusCode,
    403,
    "the loopback Host sent by the old probe is still refused",
  );
  assert.equal((await get("/snapshot", { host: "other.example.test" })).statusCode, 403);
  assert.equal(
    (await get("/health/ready", { host: publicHost, origin: "https://other.example.test" }))
      .statusCode,
    403,
  );

  const originalQuery = store.query;
  store.query = async () => {
    throw new Error("database unavailable");
  };
  try {
    const unavailable = await runProbe(port);
    assert.equal(unavailable.code, 1, "a database failure fails the probe");
    assert.equal(unavailable.output.trim(), "SmartGate API readiness check failed.");
  } finally {
    store.query = originalQuery;
  }

  const migration = (
    await store.query("SELECT version,checksum FROM schema_migrations ORDER BY version LIMIT 1")
  ).rows[0];
  await store.query("UPDATE schema_migrations SET checksum='mismatch' WHERE version=$1", [
    migration.version,
  ]);
  try {
    assert.equal((await runProbe(port)).code, 1, "a migration mismatch fails the probe");
  } finally {
    await store.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [
      migration.version,
      migration.checksum,
    ]);
  }
  assert.equal((await runProbe(port)).code, 0, "the probe recovers once the schema matches");

  await app.close();
  listening = false;
  assert.equal((await runProbe(port)).code, 1, "a stopped service fails the probe");

  const linkRoot = mkdtempSync(join(tmpdir(), "smartgate-probe-link-"));
  try {
    symlinkSync(join(root, "infrastructure"), join(linkRoot, "infrastructure"), "dir");
    const viaLink = await runProbe(
      port,
      join(linkRoot, "infrastructure", "check-api-readiness.mjs"),
    );
    assert.equal(viaLink.code, 1, "a probe started through a symlinked path still runs the check");
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }
});

test("readiness probe process fails within its bound when the service never responds", async () => {
  const sockets = new Set();
  const server = createServer((socket) => sockets.add(socket));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const hung = await runProbe(server.address().port);
    assert.equal(hung.code, 1);
    assert.ok(
      hung.ms >= PROBE_TIMEOUT_MS && hung.ms < PROBE_TIMEOUT_MS + 2_000,
      `the probe took ${hung.ms}ms`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
