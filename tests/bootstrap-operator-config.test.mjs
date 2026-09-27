import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrap = resolve(root, "scripts/bootstrap-operator.mjs");

function run(env) {
  return spawnSync(process.execPath, [bootstrap, "--email", "operator@example.test"], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 5000,
  });
}

function productionEnv() {
  return {
    ...process.env,
    NODE_ENV: "production",
    SMARTGATE_DEMO: "false",
    SMARTGATE_SKIP_MIGRATIONS: "true",
  };
}

test("production operator setup requires an external database", () => {
  const env = productionEnv();
  delete env.DATABASE_URL;
  const result = run(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("production operator setup refuses demonstration data", () => {
  const env = productionEnv();
  env.DATABASE_URL = "postgresql://unused.invalid/smartgate";
  env.SMARTGATE_DEMO = "true";
  const result = run(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SMARTGATE_DEMO=false/);
});

test("production operator setup requires a verified migrated schema", () => {
  const env = productionEnv();
  env.DATABASE_URL = "postgresql://unused.invalid/smartgate";
  env.SMARTGATE_SKIP_MIGRATIONS = "false";
  const result = run(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SMARTGATE_SKIP_MIGRATIONS=true/);
});
