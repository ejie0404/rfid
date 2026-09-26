/** Verifies the real PostgreSQL path (implementation plan, step 3).
 *
 * It performs four things a PGlite run cannot:
 *   1. Creates separate migration and application roles and proves the application role cannot
 *      change the schema.
 *   2. Applies the tracked migrations with the migration role.
 *   3. Runs the platform test suites against real PostgreSQL, each suite in its own database.
 *   4. Rehearses backup and restore, then checks that memberships, configuration versions,
 *      users, and access events survive.
 *
 * It also checks that a migration modified after it was applied is refused.
 *
 * Every database and role it creates is named smartgate_verify_* / smartgate_*. They are dropped
 * on the way out, including after a failure. Nothing here touches an existing database.
 */
import { Pool } from "pg";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/dist/app.js";
import { migrationFiles } from "../apps/api/dist/migrations.js";

const adminUrl = process.env.SMARTGATE_PG_ADMIN_URL || "postgresql://127.0.0.1:5432/postgres";
const host = new URL(adminUrl).hostname;
const port = new URL(adminUrl).port || "5432";
const runId = randomBytes(5).toString("hex");
const migratorRole = `smartgate_verify_${runId}_migrate`;
const appRole = `smartgate_verify_${runId}_app`;
const migratorPassword = randomBytes(18).toString("base64url");
const appPassword = randomBytes(18).toString("base64url");
const databases = {
  api: `smartgate_verify_${runId}_api`,
  identity: `smartgate_verify_${runId}_identity`,
  replacement: `smartgate_verify_${runId}_replacement`,
  occupancy: `smartgate_verify_${runId}_occupancy`,
  household: `smartgate_verify_${runId}_household`,
  lifecycle: `smartgate_verify_${runId}_lifecycle`,
  unmigrated: `smartgate_verify_${runId}_unmigrated`,
  partial: `smartgate_verify_${runId}_partial`,
  restoreSource: `smartgate_verify_${runId}_restore_a`,
  restoreTarget: `smartgate_verify_${runId}_restore_b`,
};
const createdDatabases = [];
const createdRoles = [];
const workspace = mkdtempSync(join(tmpdir(), "smartgate-postgres-"));
const steps = [];
/** Starts the application once against DATABASE_URL to observe its startup decision. */
const startupProbe =
  "import('./apps/api/dist/store.js').then(async (m) => { const s = new m.Store(); await s.start({ demo: false }); await s.close(); })";
// This rehearsal exercises the development boundary on purpose: it drives the prototype API
// against a local server. A production deployment is a separate, reviewed release, and the
// application refuses production mode. So the mode is chosen here rather than inherited.
delete process.env.NODE_ENV;
const url = (role, password, database) =>
  `postgresql://${role}:${password}@${host}:${port}/${database}`;
const appUrl = (database) => url(appRole, appPassword, database);
function record(name, detail) {
  steps.push(name);
  console.log("  ok  " + name + (detail ? " — " + detail : ""));
}
function run(command, args, env = {}, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, cwd });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}
async function query(pool, sql, values) {
  return (await pool.query(sql, values)).rows;
}
async function migrate(database) {
  const result = await run(process.execPath, ["scripts/migrate.mjs"], {
    DATABASE_URL: url(migratorRole, migratorPassword, database),
  });
  if (result.code !== 0)
    throw new Error("Migration failed for " + database + ":\n" + result.output);
  return result.output.trim();
}
/** Application privileges are deliberately data-only: no CREATE, no DDL, no ownership. */
async function grantApplication(pool, database) {
  await query(pool, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await query(pool, `REVOKE ALL ON SCHEMA public FROM ${appRole}`);
  await query(pool, `GRANT CONNECT ON DATABASE ${database} TO ${appRole}`);
  await query(pool, `GRANT USAGE ON SCHEMA public TO ${appRole}`);
  await query(
    pool,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`,
  );
  await query(pool, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
  await query(
    pool,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
  );
  await query(
    pool,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
  );
}
async function createDatabase(admin, database) {
  await query(admin, `CREATE DATABASE ${database} OWNER ${migratorRole}`);
  createdDatabases.push(database);
}
async function prepare(admin, database) {
  await createDatabase(admin, database);
  const detail = await migrate(database);
  const pool = new Pool({
    connectionString: url(migratorRole, migratorPassword, database),
    max: 1,
  });
  try {
    await grantApplication(pool, database);
  } finally {
    await pool.end();
  }
  return detail;
}
const admin = new Pool({ connectionString: adminUrl, max: 1 });
try {
  console.log("PostgreSQL path verification\n");
  const version = (await query(admin, "SELECT version() AS version"))[0].version;
  console.log("  target: " + version.split(" on ")[0]);

  await query(admin, `CREATE ROLE ${migratorRole} LOGIN PASSWORD '${migratorPassword}'`);
  createdRoles.push(migratorRole);
  await query(admin, `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}'`);
  createdRoles.push(appRole);
  record("created separate migration and application roles", `${migratorRole}, ${appRole}`);

  // 1 and 2: migrate each database with the migration role, then grant data-only privileges.
  const migrationDetail = await prepare(admin, databases.api);
  record("applied tracked migrations with the migration role", migrationDetail);
  await prepare(admin, databases.identity);
  await prepare(admin, databases.replacement);
  await prepare(admin, databases.occupancy);
  await prepare(admin, databases.household);
  await prepare(admin, databases.lifecycle);
  await prepare(admin, databases.restoreSource);
  record("granted data-only privileges to the application role");

  const historyPool = new Pool({
    connectionString: url(migratorRole, migratorPassword, databases.api),
    max: 1,
  });
  let recorded;
  try {
    recorded = await query(historyPool, "SELECT version FROM schema_migrations ORDER BY version");
  } finally {
    await historyPool.end();
  }
  const expectedMigrations = migrationFiles(
    new URL("../database/migrations/", import.meta.url),
  ).map((file) => file.version);
  if (recorded.map((row) => row.version).join(",") !== expectedMigrations.join(","))
    throw new Error(
      "Expected migrations " +
        expectedMigrations.join(", ") +
        ", found " +
        recorded.map((row) => row.version).join(", "),
    );
  record("recorded migration history", recorded.map((row) => row.version).join(", "));

  // 3: prove the application role cannot change the schema.
  const application = new Pool({ connectionString: appUrl(databases.api), max: 1 });
  try {
    let refused = "";
    try {
      await application.query("CREATE TABLE should_not_exist (id int)");
    } catch (error) {
      refused = error.message;
    }
    if (!refused) throw new Error("The application role was able to create a table.");
    if (!/permission denied/i.test(refused))
      throw new Error("Unexpected error instead of a permission denial: " + refused);
    record("application role cannot change the schema", refused.split("\n")[0]);
    // It also cannot migrate, because the tracked runner would need to create its own table.
    const asApplication = await run(process.execPath, ["scripts/migrate.mjs"], {
      DATABASE_URL: appUrl(databases.api),
    });
    if (asApplication.code === 0)
      throw new Error("Migrations unexpectedly succeeded with the application role.");
    // ...and the application refuses to start when the schema is absent. The role is given
    // connection rights first so the failure can only be the missing schema, not permission.
    const unmigrated = databases.unmigrated;
    await createDatabase(admin, unmigrated);
    await query(admin, `GRANT CONNECT ON DATABASE ${unmigrated} TO ${appRole}`);
    const unmigratedPool = new Pool({
      connectionString: url(migratorRole, migratorPassword, unmigrated),
      max: 1,
    });
    try {
      await query(unmigratedPool, `GRANT USAGE ON SCHEMA public TO ${appRole}`);
    } finally {
      await unmigratedPool.end();
    }
    const startup = await run(process.execPath, ["-e", startupProbe], {
      DATABASE_URL: appUrl(unmigrated),
      SMARTGATE_SKIP_MIGRATIONS: "true",
    });
    if (startup.code === 0)
      throw new Error("The application started against a database with no migrations.");
    if (!/no applied migrations/.test(startup.output))
      throw new Error("Unexpected startup failure:\n" + startup.output);
    record("unmigrated database is refused at startup", "clear operator message");

    // A partially migrated database is refused too, so a database that is missing the identity
    // migration cannot start and then fail later during a sign-in.
    const partial = databases.partial;
    await createDatabase(admin, partial);
    await migrate(partial);
    const partialPool = new Pool({
      connectionString: url(migratorRole, migratorPassword, partial),
      max: 1,
    });
    try {
      await grantApplication(partialPool, partial);
      await query(partialPool, "DELETE FROM schema_migrations WHERE version<>'001_foundation.sql'");
    } finally {
      await partialPool.end();
    }
    const partialStartup = await run(process.execPath, ["-e", startupProbe], {
      DATABASE_URL: appUrl(partial),
      SMARTGATE_SKIP_MIGRATIONS: "true",
    });
    if (partialStartup.code === 0)
      throw new Error("The application started against a partially migrated database.");
    if (!/missing required migrations/.test(partialStartup.output))
      throw new Error("Unexpected partial-migration failure:\n" + partialStartup.output);
    record(
      "a partially migrated database is refused at startup",
      "the full migration set is compared",
    );
  } finally {
    await application.end();
  }

  // 4: run the suites against real PostgreSQL. Each gets its own database so state cannot leak.
  const suites = [
    ["tests/api.test.mjs", databases.api],
    ["tests/identity.test.mjs", databases.identity],
    ["tests/replacement.test.mjs", databases.replacement],
    ["tests/occupancy.test.mjs", databases.occupancy],
    ["tests/household-vehicle-changes.test.mjs", databases.household],
    ["tests/lifecycle.test.mjs", databases.lifecycle],
    ["tests/lifecycle-audit-regressions.test.mjs", databases.lifecycle],
  ];
  for (const [file, database] of suites) {
    const result = await run(process.execPath, ["--test", file], {
      DATABASE_URL: appUrl(database),
      SMARTGATE_TEST_POSTGRES: "true",
      SMARTGATE_SKIP_MIGRATIONS: "true",
    });
    const passed =
      /# pass (\d+)/.exec(result.output)?.[1] ?? /ℹ pass (\d+)/.exec(result.output)?.[1];
    if (result.code !== 0)
      throw new Error(file + " failed against PostgreSQL:\n" + result.output.slice(-4000));
    record(file + " passed against PostgreSQL", passed + " tests on " + database);
  }

  // 5: backup and restore rehearsal on a database holding representative state.
  process.env.SMARTGATE_SKIP_MIGRATIONS = "true";
  process.env.DATABASE_URL = appUrl(databases.restoreSource);
  const { app, store, identity } = await createApp({ test: false, demo: false });
  const call = (method, path, body, token) =>
    app.inject({
      method,
      url: path,
      headers: { host: "localhost", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { payload: body }),
    });
  let expected;
  try {
    const password = "restore-rehearsal-passphrase";
    await identity.createOperator({
      email: "operator@verify.example",
      name: "Verify operator",
      password,
    });
    const login = await call("POST", "/auth/login", {
      email: "operator@verify.example",
      password,
    });
    const platformToken = login.json().token;
    const organizations = await store.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Restore Village') RETURNING id",
      [randomUUID()],
    );
    const organizationId = organizations.rows[0].id;
    const invitation = await call(
      "POST",
      "/invitations",
      { email: "hoa@verify.example", role: "hoa_admin", organization_id: organizationId },
      platformToken,
    );
    const accepted = await call("POST", "/auth/invitations/accept", {
      token: invitation.json().token,
      name: "Restore admin",
      password,
    });
    const enrollment = await call(
      "POST",
      "/enrollments",
      {
        resident: "Restore resident",
        property: "Lot 1",
        plate: "RST 0001",
        make: "Toyota",
        color: "White",
        format: "epc",
        value: "A1B2C3D4",
      },
      accepted.json().token,
    );
    if (enrollment.statusCode !== 201)
      throw new Error("Seeding enrollment failed: " + enrollment.body);
    // The access event is written directly: the device endpoints are still bound to the
    // demonstration organization, and replacing that device identity is its own step. Writing the
    // row through the application role still proves that events are captured and restorable.
    await store.query(
      `INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload)
       VALUES($1,$2,$3,$4,$5)`,
      [
        randomUUID(),
        organizationId,
        randomUUID(),
        enrollment.json().vehicle_id,
        JSON.stringify({
          schema_version: 1,
          event_id: randomUUID(),
          organization_id: organizationId,
          value: "A1B2C3D4",
          decision: "granted",
          reason: "VALID_CREDENTIAL",
          barrier_outcome: "simulated_open",
          passage_confirmed: false,
          offline: false,
        }),
      ],
    );
    const counters = await store.query(
      `SELECT (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM organization_memberships) AS memberships,
              (SELECT count(*)::int FROM access_events) AS events,
              (SELECT count(*)::int FROM audit_events) AS audit,
              (SELECT config_version FROM organizations WHERE id=$1) AS config_version`,
      [organizationId],
    );
    expected = counters.rows[0];
    expected.organizationId = organizationId;
    expected.password = password;
  } finally {
    await app.close();
    await store.close();
  }
  if (!expected.memberships || !expected.events)
    throw new Error("Seeding did not produce memberships and events to restore.");
  record(
    "seeded representative state",
    `${expected.users} users, ${expected.memberships} memberships, configuration version ${expected.config_version}, ${expected.events} event`,
  );

  const dumpFile = join(workspace, "smartgate.dump");
  const dump = await run("pg_dump", [
    "--format=custom",
    "--file=" + dumpFile,
    url(migratorRole, migratorPassword, databases.restoreSource),
  ]);
  if (dump.code !== 0) throw new Error("pg_dump failed:\n" + dump.output);
  record("dumped the database", "custom format");

  // Destroy the source, restore into a fresh database, and reapply application privileges.
  await query(admin, `DROP DATABASE ${databases.restoreSource} WITH (FORCE)`);
  const restoreDatabase = databases.restoreTarget;
  await createDatabase(admin, restoreDatabase);
  const restore = await run("pg_restore", [
    "--dbname",
    url(migratorRole, migratorPassword, restoreDatabase),
    "--exit-on-error",
    dumpFile,
  ]);
  if (restore.code !== 0) throw new Error("pg_restore failed:\n" + restore.output);
  const restoredPool = new Pool({
    connectionString: url(migratorRole, migratorPassword, restoreDatabase),
    max: 1,
  });
  try {
    await grantApplication(restoredPool, restoreDatabase);
  } finally {
    await restoredPool.end();
  }
  record("dropped the source and restored the dump into a new database");

  // Read the restored data back through the application, with the application role.
  process.env.DATABASE_URL = appUrl(restoreDatabase);
  const restored = await createApp({ test: false, demo: false });
  try {
    const snapshot = await restored.app.inject({
      method: "GET",
      url: "/health",
      headers: { host: "localhost" },
    });
    if (snapshot.statusCode !== 200) throw new Error("Restored application is not healthy.");
    const after = await restored.store.query(
      `SELECT (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM organization_memberships) AS memberships,
              (SELECT count(*)::int FROM access_events) AS events,
              (SELECT count(*)::int FROM audit_events) AS audit,
              (SELECT config_version FROM organizations WHERE id=$1) AS config_version`,
      [expected.organizationId],
    );
    const result = after.rows[0];
    for (const key of ["users", "memberships", "events", "audit", "config_version"])
      if (result[key] !== expected[key])
        throw new Error(`Restored ${key} is ${result[key]}, expected ${expected[key]}.`);
    const login = await restored.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "localhost" },
      payload: { email: "operator@verify.example", password: expected.password },
    });
    if (login.statusCode !== 201)
      throw new Error("An operator restored from backup could not sign in.");
    record(
      "restored database preserved users, memberships, configuration version and events",
      `configuration version ${result.config_version}, ${result.memberships} memberships, ${result.events} event`,
    );
  } finally {
    await restored.app.close();
    await restored.store.close();
  }

  // A migration modified after it was applied must be refused rather than silently re-run.
  const tamper = new Pool({
    connectionString: url(migratorRole, migratorPassword, databases.api),
    max: 1,
  });
  try {
    await query(
      tamper,
      "UPDATE schema_migrations SET checksum='tampered' WHERE version='002_identity.sql'",
    );
  } finally {
    await tamper.end();
  }
  const tampered = await run(process.execPath, ["scripts/migrate.mjs"], {
    DATABASE_URL: url(migratorRole, migratorPassword, databases.api),
  });
  if (tampered.code === 0 || !/changed after it was applied/.test(tampered.output))
    throw new Error("A modified applied migration was not refused:\n" + tampered.output);
  record("a modified applied migration is refused", "checksum recorded per migration");

  console.log("\nAll " + steps.length + " PostgreSQL checks passed.");
} catch (error) {
  console.error("\nFAILED: " + (error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  const cleanupFailures = [];
  for (const database of createdDatabases) {
    try {
      await query(admin, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } catch (error) {
      cleanupFailures.push(`${database}: ${error.message}`);
    }
  }
  for (const role of createdRoles.reverse()) {
    try {
      await query(admin, `DROP ROLE IF EXISTS ${role}`);
    } catch (error) {
      cleanupFailures.push(`${role}: ${error.message}`);
    }
  }
  await admin.end();
  rmSync(workspace, { recursive: true, force: true });
  if (cleanupFailures.length) {
    process.exitCode = 1;
    console.error(`Cleanup failed for run ${runId}:\n${cleanupFailures.join("\n")}`);
  } else
    console.log(
      "\nCleaned up " +
        createdDatabases.length +
        " databases and " +
        createdRoles.length +
        " roles created by run " +
        runId +
        ".",
    );
}
