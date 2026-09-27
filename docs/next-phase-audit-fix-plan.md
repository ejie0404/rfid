# Fix plan: hosted API phase audit

Prepared 27 September 2026. This is the implementation plan for the four confirmed audit findings.

## Implementation result (27 September 2026)

The four source fixes and local regression coverage are implemented. A follow-up review corrected
the local database selection, the image build context, the README image instructions, and a probe
entrypoint that could skip its check. A second review made attempt limits follow the router's
matched route, closing a percent-encoded path bypass, and made trusted-proxy checks compare parsed
addresses. The full platform suite passed with 62 tests passing, none
failing, and one existing PostgreSQL-only test skipped. Typecheck, production builds, format,
protocol, and whitespace checks passed. The PostgreSQL verifier passed all 20 checks. Two production
worker entrypoints spanned the pool idle timeout, processed an actually due move-out at its recorded
cutoff with a single occupancy audit row, and stopped cleanly on SIGINT and SIGTERM. A restarted
worker then completed newly due work without duplicating the completed schedule. The verifier
cleaned up the 11 databases and two roles owned by that run.

The ignored local `.env` now selects `apps/api/.data/postgres`. That is the directory the local API
used before paths were anchored to the platform root; it has all 13 migrations and the five demo
accounts. The root `.data/postgres` copy stops at migration 007, has no accounts, and fails migration
008 on its legacy vehicle history, so it was kept untouched as an archive. With the selected
directory, the local development API became ready, all five demo accounts signed in, the HOA
snapshot loaded, and the development worker ran and stopped on SIGINT.

The readiness probe was tested as a separate process against a listening API with an exact
public-host allowlist on a non-default port, including database, migration, stopped-service,
unresponsive-service, and symlinked-invocation failures. Static tests guard the Dockerfile targets
and build-context exclusions; they are not container acceptance. Docker is unavailable locally, so
the API and worker image builds and container runtime acceptance remain outstanding. Provider
deployment and hosted browser/edge acceptance are also outside the completed local checks.

## 1. Evidence and intended result

The audit found four defects:

1. **P1: standalone worker lifetime.** A PostgreSQL-backed reproduction performed one pass and
   exited after 10.1 seconds. The pool closes idle connections after 10 seconds, while the worker's
   next poll is scheduled at 15 seconds and its timer is unreferenced.
2. **P1: API container readiness.** The container probes with `Host: 127.0.0.1:4100`, but the
   documented production configuration allows the public API hostname. The probe Host returned
   403; the configured public Host returned 200.
3. **P2: worker container healthcheck.** The deployment instructions reuse the API image for the
   worker, so it inherits an HTTP healthcheck despite having no HTTP listener.
4. **P2: local database selection.** The current `.env` and example both specify the relative path
   `.data/postgres`. Operator setup runs from the platform root, while API and worker development
   commands run from `apps/api`. They resolve that setting to different database directories.

The audit's 23 focused tests passed, so the current tests do not cover these failures. The Vercel
URL-validation matrix and `git diff --check` also passed.

**Clarification:** `scripts/migrate.mjs` already requires `DATABASE_URL` and uses PostgreSQL. The
embedded database path defect affects operator bootstrap, API startup, and worker startup; it does
not redirect that migration command into PGlite.

The intended result is a worker that stays alive and shuts down cleanly, an API probe that passes
with the exact production host policy, a background-worker image with appropriate supervision, and
consistent local database selection across commands.

## 2. Preflight and implementation order

Implement this as one focused fix slice in `smartgate-platform`:

1. Record the current Git status and diff, including untracked runtime, test, and infrastructure
   files. Use the current worktree as the baseline.
2. Fix the worker lifetime and add a subprocess regression.
3. Add shared embedded-database path resolution and determine the existing local database to use.
4. Add an API readiness probe that supplies the configured public Host.
5. Separate API and worker container targets and document their launch commands.
6. Run the focused regressions, existing verification gates, and container acceptance checks.
7. Update the phase status with the exact results and remaining deployment prerequisites.

## 3. Fix the standalone worker lifetime

### Files

- `apps/api/src/scheduled-move-out-worker.ts`
- `apps/api/src/move-out-worker-main.ts`, if shutdown adjustments are necessary
- `tests/scheduled-move-out-worker.test.mjs`
- Proposed subprocess regression: `tests/scheduled-move-out-worker-process.test.mjs`

### Changes

- Keep the polling interval referenced so it keeps the dedicated Node process alive between passes.
- Keep `stop()` responsible for clearing the interval, awaiting the active pass, and releasing the
  database lease before the entrypoint closes its Store.
- Verify SIGINT and SIGTERM use the same idempotent shutdown path.
- Preserve the existing failure reporting and retry behavior when a processing pass fails.

### Regression checks

- Launch a child process with the real worker function and a minimal Store adapter. Observe at
  least three polls, then stop it from the parent and require a clean exit.
- Put the test deadline and termination control in the parent process. An extra referenced timer
  or IPC listener in the child would mask the original lifetime defect.
- Keep the existing overlap, lease release, failure retry, and shutdown-drain tests.
- Extend isolated PostgreSQL verification with a schedule that becomes due after the initial pass
  and the pool's idle window. Start the real worker entrypoint and verify the later poll processes
  it without HTTP traffic. Inspect database rows directly from the parent so an API request cannot
  accidentally perform the scheduled work.
- Restart the worker and verify the completed schedule produces no duplicate closure or audit
  records. Include two-worker contention against the same isolated database.
- Bound subprocess execution and clean up only the temporary resources created by the test run.

**Acceptance:** the standalone process remains alive through idle periods, executes later due work
once, survives recoverable pass failures, and exits cleanly after a termination signal.

## 4. Resolve the local database consistently

### Files

- Proposed shared resolver: `apps/api/src/data-directory.ts`
- `apps/api/src/store.ts`
- `.env.example`, `README.md`, and `docs/environment.md`
- Proposed regression: `tests/data-directory.test.mjs`

### Changes

- Determine the platform root from the resolver module's file URL. Source and compiled API files
  have the same directory depth, so this works in development and the compiled runtime.
- Resolve relative `SMARTGATE_DATA_DIR` values against that root, rather than `process.cwd()`.
- Resolve the default `.data/postgres` through the same rule.
- Accept explicit absolute directories. Have bootstrap, API, and worker use the resolver through
  Store so there is one implementation of the rule.
- Document that this setting selects embedded local storage; `DATABASE_URL` selects external
  PostgreSQL.

### Existing-data transition

1. Inspect the root and `apps/api` database locations and identify which location the current local
   API is using. Avoid opening an active embedded database from a second process.
2. Select the intended existing database before changing the running local services. Set the
   ignored local `.env` to an explicit absolute directory during the transition if needed.
3. Take a consistent backup before any relocation. Do not automatically merge, overwrite, or move
   the two directories; they may contain different account and activity histories.
4. Apply the resolver and restart known SmartGate processes against the selected directory.
5. Verify the expected accounts and representative existing records are present. Production
   operator credentials remain user-entered through the controlled setup command.

### Regression checks

- Compare resolver results from the platform root, `apps/api`, and another working directory for
  both the default and a configured relative path. All results must be identical.
- Cover absolute paths and paths containing spaces.
- In an isolated run-specific database, bootstrap a synthetic operator from the root, close that
  process, then read/sign in to that account from an API process started in the workspace directory.
- Verify external PostgreSQL selection and migration-role checks still work.

**Acceptance:** local command working directories cannot silently select different databases, and
the transition retains the chosen existing local records.

## 5. Make the API readiness probe compatible with host enforcement

### Files

- Proposed probe: `infrastructure/check-api-readiness.mjs`
- `infrastructure/Dockerfile`
- Proposed regression: `tests/api-readiness-probe.test.mjs`

### Changes

- Replace the inline Docker fetch with a reusable probe script.
- Reuse the validated runtime configuration for the port and allowed Host. Connect to the local
  service and explicitly send an allowed public Host header.
- Use `/health/ready`, a bounded request timeout, and a nonzero exit for non-200 responses,
  connection failures, or timeout. Report only a short status; do not print response bodies or
  database credentials.
- Keep the public host and origin restrictions intact. The probe does not require a broad host
  exception for application routes.

### Regression checks

- Run the probe against a listening API fixture with the documented exact public-host policy.
- Verify a healthy database/schema returns a successful probe exit.
- Verify database failure and migration mismatch produce 503 and a failing probe exit.
- Verify a non-default port, a stopped service, and a timed-out response.
- Verify ordinary requests with an unapproved Host or Origin still receive 403.

**Acceptance:** the production API can become healthy with its documented allowlist, and the probe
fails promptly when readiness fails.

## 6. Give API and worker containers distinct launch and health behavior

### Files

- `infrastructure/Dockerfile`
- `README.md` and `docs/environment.md`

### Changes

- Keep a shared compiled runtime stage and add named `worker` and `api` targets.
- Make the default final target the API, with its readiness probe and exposed HTTP port.
- Give the worker target `HEALTHCHECK NONE` and its own standalone worker command. Document that
  it must run as a supervised background service with restart/exit monitoring.
- Use direct Node entrypoints for each role so termination signals reach the application process.
- Document explicit target build/run commands for both images, their shared application database
  role, and the separate migration command.
- Record that process supervision alone does not establish job freshness; later release acceptance
  still needs worker progress and due-work monitoring.

### Container acceptance

- Build both targets from the same candidate source and inspect their commands and health settings.
- Start the API with production configuration and an isolated migrated PostgreSQL database. Require
  readiness to pass with only the public API hostname in the allowlist.
- Start the worker target as a background container. Require it to stay running beyond the idle
  window and process later due work without an HTTP listener or inherited HTTP probe.
- Stop each container and verify clean signal handling, bounded shutdown, and lease release.
- Verify both use the application role and do not contain ignored local environment files.

**Acceptance:** each image starts the intended process and has health/supervision behavior suitable
for that role.

## 7. Verification and handover

Run the new regressions, then the existing candidate checks once:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run format:check`
- `npm run protocol:check`
- `npm run verify:postgres`, including the worker integration added above
- `git diff --check`
- Both container build and runtime checks from section 6

Docker was unavailable during the audit. If it remains unavailable locally, execute container checks
in a Docker-capable environment and record that result separately from local source verification.
Do not describe a probe unit test or Dockerfile inspection as a successful container deployment.

Update `docs/implementation-status.md`, `docs/next-phase-implementation-plan.md`, and the environment
guide with the actual check results, selected local data directory rule, role-specific image
commands, and any unfinished acceptance items.

This fix slice is complete when all four defects have regression coverage, the local database
transition is verified, both container roles pass runtime acceptance, and the status record matches
the evidence. Hosted API/database provisioning, authenticated desktop/phone workflows, enrolled
HTTPS edge exchange, and release recovery remain separate acceptance work for the hosted phase.
