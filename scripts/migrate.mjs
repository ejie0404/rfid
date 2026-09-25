/** Applies pending migrations using migration credentials.
 *
 * The application itself runs with migration privileges removed, so this is the only path that
 * changes the schema. It requires DATABASE_URL (the migration role) and records each applied
 * migration's checksum.
 *
 *   DATABASE_URL='postgresql://smartgate_migrate:...@127.0.0.1:5432/smartgate' npm run migrate
 */
import { Pool } from "pg";
import { runMigrations } from "../apps/api/dist/migrations.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (use the migration role, not the application role).");
  process.exit(1);
}
const directory = new URL("../database/migrations/", import.meta.url);
const pool = new Pool({ connectionString: url, max: 1 });
const driver = {
  exec: async (sql) => {
    await pool.query(sql);
  },
  query: (sql, values) => pool.query(sql, values),
  transaction: async (run) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        exec: async (sql) => {
          await client.query(sql);
        },
        query: (sql, values) => client.query(sql, values),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
try {
  const result = await runMigrations(driver, directory);
  console.log(
    result.applied.length
      ? "Applied: " + result.applied.join(", ")
      : "No pending migrations. " + result.total + " recorded.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
