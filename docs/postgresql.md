# PostgreSQL deployment path

This document records how the platform uses PostgreSQL, how the migration and application
privileges are separated, and how the backup and restore rehearsal was performed. It corresponds
to step 3 of the implementation plan.

## Local development versus a server

| Setting                          | Behaviour                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL` unset             | Embedded PostgreSQL (PGlite) on disk at `.data/postgres`. Single process only. |
| `DATABASE_URL` set               | A PostgreSQL server is used with the `pg` driver.                              |
| `SMARTGATE_SKIP_MIGRATIONS=true` | The application verifies the schema instead of applying migrations.            |
| `SMARTGATE_TEST_POSTGRES=true`   | Test runs use `DATABASE_URL` instead of throwaway embedded state.              |

Embedded PostgreSQL is a local development convenience, not a deployment. It does not establish
concurrency, durability, or recovery behaviour for a real installation.

## Two roles

The schema is owned and changed by a migration role. The application runs as a separate role that
can read and write rows but cannot change the schema.

```text
smartgate_migrate   owns the schema; runs `npm run migrate`
smartgate_app       CONNECT + USAGE, and SELECT/INSERT/UPDATE/DELETE on tables
```

Provisioning outline:

```sql
CREATE ROLE smartgate_migrate LOGIN PASSWORD '...';
CREATE ROLE smartgate_app LOGIN PASSWORD '...';
CREATE DATABASE smartgate OWNER smartgate_migrate;
```

Then apply migrations and grant the application role its data privileges:

```sh
DATABASE_URL='postgresql://smartgate_migrate:...@127.0.0.1:5432/smartgate' npm run migrate
```

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE smartgate TO smartgate_app;
GRANT USAGE ON SCHEMA public TO smartgate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO smartgate_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO smartgate_app;
ALTER DEFAULT PRIVILEGES FOR ROLE smartgate_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smartgate_app;
ALTER DEFAULT PRIVILEGES FOR ROLE smartgate_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO smartgate_app;
GRANT SELECT ON schema_migrations TO smartgate_app;
```

The application is started with the application role and `SMARTGATE_SKIP_MIGRATIONS=true`. If the
schema has not been migrated, the application refuses to start with an explicit message rather
than creating tables, so a misprovisioned role cannot silently migrate.

## Migration runner

`database/migrations/*.sql` are applied in filename order and recorded in `schema_migrations` with
a SHA-256 checksum. A migration whose content changed after it was applied is **refused**, not
re-run, so an already-migrated database cannot drift from the reviewed source. Add a new file to
change the schema.

## Verification

```sh
npm run verify:postgres
```

This creates disposable roles and databases, runs the checks below, and drops the databases
afterwards, including after a failure. Set `SMARTGATE_PG_ADMIN_URL` to point at a different local
server. Override nothing else; the role names it uses are prefixed `smartgate_verify_`.

Checks performed:

1. Separate migration and application roles are created.
2. Migrations are applied with the migration role and recorded.
3. The application role cannot create a table, cannot run migrations, and the application refuses
   to start against a database with no applied migrations or one that is missing a migration this
   build requires. The full recorded set is compared, so a database missing the identity migration
   is refused at startup rather than failing later during a sign-in. A database with migrations
   this build does not know about is refused as well.
4. Both platform suites pass against real PostgreSQL, each in its own fresh database.
5. Backup and restore: representative state is seeded, the database is dumped, the source is
   dropped, the dump is restored into a new database, application privileges are reapplied, and
   users, memberships, configuration version, and access events are compared before and after.

The last verification reported 14 checks passing against PostgreSQL 17.11, with both suites passing
(7 and 15 tests). The roles `smartgate_verify_migrate` and `smartgate_verify_app` are intentionally
left behind for inspection; remove them with `DROP ROLE` when they are no longer useful.

## Restore precautions

- The rehearsal proves the procedure, not a production recovery objective. Timing and retention
  policy still need to be agreed with the operator.
- Passwords are stored as scrypt hashes, so a restored database retains working credentials. A
  restored database therefore also restores live sessions until they expire or are revoked.
  Revoke sessions after a restore if the restore was not authorised by the account holders.
- Restoring an older dump reintroduces access that was revoked after the dump was taken. Because
  controller configuration versions are monotonic, a gate that is already ahead will reject the
  older configuration rather than silently reverting it.
