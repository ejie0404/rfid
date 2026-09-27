import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Identity } from "../apps/api/dist/identity.js";
import { resolveDataDirectory, SMARTGATE_PLATFORM_ROOT } from "../apps/api/dist/data-directory.js";
import { Store } from "../apps/api/dist/store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("relative embedded database paths are anchored to the platform root", () => {
  const id = randomUUID();
  assert.equal(resolveDataDirectory(`.data/tests/${id}`), resolve(root, `.data/tests/${id}`));
  assert.equal(SMARTGATE_PLATFORM_ROOT, root);
  assert.equal(
    resolveDataDirectory("/tmp/smartgate-explicit-path"),
    "/tmp/smartgate-explicit-path",
  );
});

test("operator setup and API startup share local records across working directories", async () => {
  const originalCwd = process.cwd();
  const variables = ["SMARTGATE_DATA_DIR", "DATABASE_URL", "SMARTGATE_SKIP_MIGRATIONS"];
  const originalEnvironment = new Map(variables.map((name) => [name, process.env[name]]));
  const relativeDirectory = `.data/tests/local-path-${randomUUID()}`;
  const dataDirectory = resolve(root, relativeDirectory);
  let setupStore;
  let apiStore;

  try {
    process.env.SMARTGATE_DATA_DIR = relativeDirectory;
    delete process.env.DATABASE_URL;
    delete process.env.SMARTGATE_SKIP_MIGRATIONS;
    process.chdir(root);
    assert.equal(resolveDataDirectory(), dataDirectory);

    setupStore = new Store();
    await setupStore.start({ demo: false });
    const identity = new Identity(setupStore);
    await identity.createOperator({
      email: `audit-${randomUUID()}@example.test`,
      name: "Synthetic local path test",
      password: "test-only-smartgate-password-2026",
    });
    assert.equal(await identity.hasOperator(), true);
    await setupStore.close();
    setupStore = undefined;

    process.chdir(resolve(root, "apps/api"));
    assert.equal(resolveDataDirectory(), dataDirectory);
    apiStore = new Store();
    await apiStore.start({ demo: false });
    assert.equal(await new Identity(apiStore).hasOperator(), true);
  } finally {
    await setupStore?.close();
    await apiStore?.close();
    process.chdir(originalCwd);
    rmSync(dataDirectory, { recursive: true, force: true });
    for (const name of variables) {
      const value = originalEnvironment.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
