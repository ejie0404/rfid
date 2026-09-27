# Environment configuration

## Local development

Copy `.env.example` to `.env` at the repository root. It contains local demo settings only. The API
development command and the root migration, operator setup, and PostgreSQL verification commands
load that file when present. Values exported in the shell take precedence.

Each Next.js app reads its own ignored `.env.local` file:

- `apps/control-web/.env.local`
- `apps/guard-web/.env.local`
- `apps/resident-web/.env.local`

For a local run, each app needs:

```dotenv
NEXT_PUBLIC_SMARTGATE_API_URL=http://127.0.0.1:4100
```

Only a guard station that can reach a local edge service should also set
`NEXT_PUBLIC_SMARTGATE_EDGE_URL`. Simulator controls additionally require
`NEXT_PUBLIC_SMARTGATE_SIMULATOR_ENABLED=true`. Cloud guard pages do not have a local connection to
a station controller; with no edge URL, the cloud dashboard still loads and local status is shown
as unconfigured.

`SMARTGATE_DEMO=true` seeds fictional demo data. Leave it disabled for real local accounts and all
hosted environments. For a real local account, run `npm run setup:operator` and enter a password at
the prompt. Never place that password in a frontend environment file.

## Database commands

Use the migration role for `npm run migrate` and the data-only application role for the API. The
local root `.env` is loaded by these root commands so they use the same selected database as API
development. See [PostgreSQL setup](postgresql.md) for role creation, privileges, migration checks,
and restore notes.

With no `DATABASE_URL`, local development uses embedded PostgreSQL persisted under
`SMARTGATE_DATA_DIR`. Relative values are resolved from the platform repository root, independent
of which workspace launches the API, worker, or operator setup command. An absolute path is also
accepted. A hosted API must use external PostgreSQL and verify its schema before taking traffic.

## Vercel frontends

Set `NEXT_PUBLIC_SMARTGATE_API_URL` in each of the three Vercel projects, then create a new
deployment. A Vercel build fails unless it is a public HTTPS base URL. Outside Vercel, a built app
accepts plain HTTP only for a loopback address such as the local API, and never falls back to a
default address; a missing or unsafe value shows a configuration screen. Changing a Vercel environment
value does not change an already-built deployment. These public variables are embedded in browser code;
never put database passwords, operator passwords, setup tokens, or private credentials in a
`NEXT_PUBLIC_` variable.

The edge URL is for a station browser that has an authenticated, reachable local edge service. It
is not a public controller URL and should not be added to the resident or cloud guard deployment.
Hosted builds leave simulator controls disabled.

## Backend deployment

The API container and scheduled-move-out worker are built from this repository. Run them as
separate supervised processes against the same external PostgreSQL database. Use a migration role
for schema changes, then run the API and worker with the data-only application role and schema
verification enabled. The API needs an explicit HTTPS origin allowlist for the control, guard, and
resident sites. Do not allow arbitrary preview origins.

The API deployment requires `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=4100`, an external
`DATABASE_URL`, `SMARTGATE_DEMO=false`, `SMARTGATE_SKIP_MIGRATIONS=true`, and exact comma-separated
`SMARTGATE_ALLOWED_ORIGINS` and `SMARTGATE_ALLOWED_HOSTS` lists. For the current Vercel projects,
the production origins are `https://smartgate-control.vercel.app`,
`https://smartgate-guard.vercel.app`, and `https://smartgate-resident.vercel.app`; use the matching
staging URLs when configuring staging. `SMARTGATE_ALLOWED_HOSTS` contains the public API hostname.
Add `SMARTGATE_TRUSTED_PROXIES` only with the provider's verified proxy IP addresses. The API
exposes `/health/live` and `/health/ready`; route traffic only after readiness succeeds.

Production always requires MFA for platform and village administrator accounts; setting
`SMARTGATE_REQUIRE_PRIVILEGED_MFA=false` fails startup. Set it to `true` in local real-mode
development to exercise the same policy. Demo mode ignores it.

The API limits sensitive attempts by client IP inside each process. Configure shared rate limiting
at the provider or gateway before running multiple API replicas, and set trusted proxy IPs only
when the service is behind those proxies so client IP attribution stays accurate.

Build the API and worker image targets from the repository root. The default target is the API;
do not run the worker command in the API image, because it would inherit the API readiness check.

```sh
docker build -f infrastructure/Dockerfile --target api -t smartgate-api .
docker build -f infrastructure/Dockerfile --target worker -t smartgate-move-out-worker .
```

The commands below are the Docker equivalent of the provider service settings. Export the
non-secret values and replace the placeholder API hostname with the verified public hostname. Load
each `DATABASE_URL` from your secret store into the shell instead of typing it on the command line;
`-e NAME` passes the current value to the container without printing it.

```sh
export HOST=0.0.0.0 PORT=4100 SMARTGATE_DEMO=false SMARTGATE_SKIP_MIGRATIONS=true
export SMARTGATE_ALLOWED_ORIGINS=https://smartgate-control.vercel.app,https://smartgate-guard.vercel.app,https://smartgate-resident.vercel.app
export SMARTGATE_ALLOWED_HOSTS=api.example.com

# 1. Before each release, with DATABASE_URL set to the migration role:
docker run --rm --no-healthcheck -e DATABASE_URL smartgate-api node scripts/migrate.mjs

# 2. Then, with DATABASE_URL set to the data-only application role:
docker run -d --name smartgate-api --restart unless-stopped -p 4100:4100 \
  -e HOST -e PORT -e DATABASE_URL -e SMARTGATE_DEMO -e SMARTGATE_SKIP_MIGRATIONS \
  -e SMARTGATE_ALLOWED_ORIGINS -e SMARTGATE_ALLOWED_HOSTS smartgate-api
docker run -d --name smartgate-move-out-worker --restart unless-stopped \
  -e HOST -e PORT -e DATABASE_URL -e SMARTGATE_DEMO -e SMARTGATE_SKIP_MIGRATIONS \
  -e SMARTGATE_ALLOWED_ORIGINS -e SMARTGATE_ALLOWED_HOSTS smartgate-move-out-worker

# 3. Once per environment, with the application role, create the first platform administrator.
#    The command prompts for the password, so it needs an interactive terminal.
docker run --rm -it --no-healthcheck -e DATABASE_URL -e SMARTGATE_DEMO -e SMARTGATE_SKIP_MIGRATIONS \
  smartgate-api node scripts/bootstrap-operator.mjs --email operator@example.com --name "Operations lead"
```

After the API is ready, set each Vercel project's `NEXT_PUBLIC_SMARTGATE_API_URL` to its HTTPS
address and redeploy. The operator then signs in to the management app, adds the customer village
on the **Villages** screen, and delivers the first administrator's one-time invitation code or link.
That administrator invites guards and residents from **Staff & access**. Village names are unique
regardless of case and spacing, and every village creation is recorded in that village's audit
history. Platform support accounts can view the village list but cannot add villages or send
invitations.

The worker validates the same production settings as the API even though it serves no HTTP, so
give both services the same environment. The API target checks `/health/ready` using the first
exact hostname in `SMARTGATE_ALLOWED_HOSTS`; it does not add a loopback exception to the
application host policy. Both images start Node directly, so `docker stop` delivers SIGTERM to the
application. The worker finishes its active pass and releases its database lease before exiting.

Run the worker as a supervised background service that is restarted when it exits, and alert on
unexpected exits. A running worker process does not prove that schedules are being processed:
until worker progress and oldest-due-schedule monitoring exist, release acceptance must check due
work directly.

`.dockerignore` excludes `.env` files and embedded `.data` directories at any depth, so neither
image contains local configuration or a local database. Configure secrets in the service provider
directly.

Provider resource creation and live deployment require the selected API/database provider, region,
verified HTTPS hostname, and secrets entered directly into that provider. The deployment artifact
and configuration checks can be prepared without copying credentials into this repository.
