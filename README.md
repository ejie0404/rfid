# SmartGate Platform

The cloud and web repository for SmartGate. Real user accounts, organization membership, and the
three web applications are implemented; gate hardware is still simulated.

## Two ways to run it

### Demonstration preview

Seeds a fictional village with demonstration accounts and enables a one-click sign-in. Use this to
look at the product.

```sh
npm ci
npm run build
npm run demo
```

- Management: http://127.0.0.1:3000
- Guard web: http://127.0.0.1:3001
- Resident portal: http://127.0.0.1:3002
- API: http://127.0.0.1:4100/health

Demonstration sign-in is only offered because the API reports that it is enabled. It signs in as a
seeded account through the real login path, so it cannot reach anything the equivalent real account
could not.

### Real accounts

No fictional data, no demonstration shortcut. The first account is created by an operator, and
everyone else joins through an invitation.

```sh
npm ci
npm run build:packages
SMARTGATE_OPERATOR_PASSWORD='a-long-passphrase' npm run setup:operator -- \
  --email operator@example.com --name "Operations lead"
```

Then start the API without `SMARTGATE_DEMO` and sign in at `/auth/login`. The platform
administrator onboards a customer by inviting its first HOA administrator, who then invites
guards and residents from **Staff & access** in the management app. Invited people accept from the
app at **I have an invitation**, or from a link carrying the code, so nobody needs the API. An
account that already exists must sign in first.

Two test villages can be operated at the same time. Organization scope comes from an authenticated
membership, never from the browser.

See [the authentication decision](docs/authentication.md) and
[the PostgreSQL path](docs/postgresql.md) for the design and the operating procedure.

## What works

- Real sign-in with server-side sessions, absolute expiry, revocation, and per-account lockout.
- Administrator-issued invitations: single-use, expiring, bound to one organization, role, and
  household or station, with an acceptance screen in all three apps.
- Multi-factor authentication: TOTP with replay protection, plus one-time recovery codes.
- Organization membership with permission templates for platform operator, HOA administrator,
  guard, and resident. Residents are scoped to their households and guards to their assigned
  stations, including which credentials a station may look up.
- Platform operator access to a customer is an explicit, reason-bearing, time-limited,
  read-only grant recorded in the audit history.
- Enrollment, credential lifecycle, duplicate protection, assignment history, and audit records.
- Versioned configuration delivery and separate controller acknowledgement.
- Persistent, idempotent event ingestion, including concurrent retries.
- Draft configuration, event, and heartbeat JSON schemas.
- Mobile layouts and a statically exportable guard application.

## Data and local infrastructure

Without `DATABASE_URL`, the API uses **PGlite**, an embedded PostgreSQL runtime, under
`.data/postgres`, so the prototype runs without Docker. That is a local development option, not a
deployment, and only one API process may use a given directory.

For a real database, separate migration and application roles are required. The application
verifies the schema instead of changing it.

```sh
DATABASE_URL='postgresql://smartgate_migrate:...@127.0.0.1:5432/smartgate' npm run migrate
DATABASE_URL='postgresql://smartgate_app:...@127.0.0.1:5432/smartgate' \
  SMARTGATE_SKIP_MIGRATIONS=true npm run dev:api
```

Details, including the privilege grants and the backup/restore rehearsal, are in
[docs/postgresql.md](docs/postgresql.md). An optional PostgreSQL 17 Compose service is in
`infrastructure/docker-compose.yml`; set your own `POSTGRES_PASSWORD` before running it.

## Development and checks

```sh
npm run dev:api
npm run dev:control
npm run dev:guard
npm run dev:resident

npm test
npm run typecheck
npm run build
npm run format:check
npm run protocol:check
npm run protocol:bundle

npm run migrate           # apply migrations with migration credentials
npm run verify:postgres   # privilege separation, PostgreSQL suites, and a restore rehearsal
```

Run each development server in a separate terminal. Run `npm run build:packages` first when
developing portals from a fresh checkout. The production-style preview serves the built static
exports; rebuild and reload after UI changes.

## Repository boundary

The platform owns PostgreSQL migrations and `contracts/edge/v1`. The edge owns SQLite migrations
and hardware adapters. Neither repository imports sibling source files. The guard export is an
explicit build artifact supplied to the edge, not an automatic edge firmware deployment.

`npm run protocol:bundle` creates an explicit draft bundle with SHA-256 hashes. Review and copy a
selected protocol bundle into the edge repository, pin its manifest, and run compatibility checks
in both repositories. Published protocol versions must remain compatible; introducing a new
incompatible shape requires a new version.

See [architecture](docs/architecture.md), [implementation status](docs/implementation-status.md),
and [Hikvision commissioning requirements](docs/hikvision-pilot.md).

## Deployment boundary

This code intentionally refuses `NODE_ENV=production` and binds only to loopback. Real device
enrollment, TLS, MQTT, local guard authentication, and physical commissioning must replace the
demonstration boundaries before a live pilot. All physical actuation is disabled in the current
executable.
