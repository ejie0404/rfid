# SmartGate Platform

The cloud and web repository for SmartGate. This first runnable milestone is a **local development prototype**, with real persistence and simulated gate hardware.

## Start the preview

Requirements: Node.js 24 and npm.

```sh
npm ci
npm run build
npm run demo
```

- Management: http://127.0.0.1:3000
- Guard web: http://127.0.0.1:3001
- Resident portal: http://127.0.0.1:3002
- API: http://127.0.0.1:4100/health

Start the separate edge repository to see controller status and simulate arrivals. The edge can also serve the guard export at http://127.0.0.1:4200, independently of this process.

The seeded village is fictional. The resident profile sees only the seeded property's vehicle. Management can enroll another sample vehicle; its owner does not acquire a real account automatically. API sessions are temporary, explicitly local demonstration sessions. There are no production passwords to configure.

## What works

- Separate Next.js management, guard, and resident applications.
- NestJS/Fastify API with server-side role and organization checks.
- PostgreSQL schema with tenant-scoped composite foreign keys.
- Atomic property/vehicle/credential enrollment, duplicate checks, assignment history, and mutation audit records.
- Suspension, reactivation of suspended credentials, and resident reporting of their own lost credential.
- Versioned configuration delivery and separate controller acknowledgement.
- Persistent, idempotent event ingestion, including concurrent retries.
- Draft configuration, event, and heartbeat JSON schemas.
- Mobile layouts and a statically exportable guard application.

## Data and local infrastructure

Without DATABASE_URL, the API uses **PGlite**, an embedded PostgreSQL runtime, under `.data/postgres`. This makes the prototype runnable without Docker. It is a local development option, not the intended production database deployment.

To use a separate PostgreSQL server, set DATABASE_URL in your shell before starting the API. The API uses the `pg` driver and the same migration. An optional PostgreSQL 17 Compose service is in `infrastructure/docker-compose.yml`; set your own POSTGRES_PASSWORD before running it. The external PostgreSQL/Compose path has not been exercised on this machine because Docker is unavailable.

Do not run multiple API processes against one PGlite directory. Keep backups and shared database operations out of the prototype until their own release gate is implemented.

## Development and checks

```sh
npm run dev:api
npm run dev:control
npm run dev:guard
npm run dev:resident

npm test
npm run format:check
npm run typecheck
npm run build
npm run protocol:check
npm run protocol:bundle
```

Run each development server in a separate terminal. Run `npm run build:packages` first when developing portals from a fresh checkout. The production-style preview serves the built static exports; rebuild and reload after UI changes.

## Repository boundary

The platform owns PostgreSQL migrations and `contracts/edge/v1`. The edge owns SQLite migrations and hardware adapters. Neither repository imports sibling source files. The guard export is an explicit build artifact supplied to the edge, not an automatic edge firmware deployment.

`npm run protocol:bundle` creates an explicit draft bundle with SHA-256 hashes. Review and copy a selected protocol bundle into the edge repository, pin its manifest, and run compatibility checks in both repositories. Published protocol versions must remain compatible; introducing a new incompatible shape requires a new version.

See [architecture](docs/architecture.md), [implementation status](docs/implementation-status.md), and [Hikvision commissioning requirements](docs/hikvision-pilot.md).

## Deployment boundary

This code intentionally refuses `NODE_ENV=production` and binds only to loopback. Real identity management, device provisioning, TLS, MQTT, local guard authentication, and physical commissioning must replace the demonstration boundaries before a live pilot. All physical actuation is disabled in the current executable.
