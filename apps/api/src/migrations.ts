import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export interface SqlSession {
  exec(sql: string): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
export interface MigrationDriver extends SqlSession {
  transaction<T>(run: (tx: SqlSession) => Promise<T>): Promise<T>;
}
export interface AppliedMigration {
  version: string;
  checksum: string;
}
export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}
const pattern = /^\d+_[a-z0-9_]+\.sql$/;
export function migrationFiles(directory: URL): MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => pattern.test(name))
    .sort()
    .map((version) => {
      const sql = readFileSync(new URL(version, directory), "utf8");
      return { version, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}
/**
 * Applies unapplied migrations in order and records their checksum. A migration whose
 * content changed after it was applied is refused rather than silently re-run, so an
 * already-migrated database cannot drift from the reviewed source.
 */
export async function runMigrations(driver: MigrationDriver, directory: URL) {
  await driver.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const known = new Map(
    (
      (await driver.query("SELECT version, checksum FROM schema_migrations"))
        .rows as AppliedMigration[]
    ).map((row) => [row.version, row.checksum]),
  );
  const files = migrationFiles(directory);
  const pending: MigrationFile[] = [];
  for (const file of files) {
    const previous = known.get(file.version);
    if (previous && previous !== file.checksum)
      throw new Error(
        "Migration " + file.version + " changed after it was applied. Add a new migration instead.",
      );
    if (!previous) pending.push(file);
  }
  for (const file of pending) {
    await driver.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [
        file.version,
        file.checksum,
      ]);
    });
  }
  return { applied: pending.map((file) => file.version), total: files.length };
}
