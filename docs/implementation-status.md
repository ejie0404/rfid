# SmartGate implementation status

Updated 27 September 2026.

**Real accounts, organization membership, invitation acceptance, controller identity, scoped sync,
site/lane setup, and the first usable version of all three applications are implemented. The edge
still runs simulated hardware; this is not a completed V1 or a commissioned gate system.**

## Open the running previews

The local URLs below work only while their development servers are running. The three Vercel
frontend projects were previously published and their sign-in pages were checked on 26 September;
authenticated use still depends on deploying the API and rebuilding each frontend with its HTTPS
API URL.

- [Village management](http://127.0.0.1:3000)
- [Guard web app](http://127.0.0.1:3001)
- [Resident portal](http://127.0.0.1:3002)
- [Guard app served by the edge](http://127.0.0.1:4200)

- [Management deployment](https://smartgate-control.vercel.app)
- [Guard deployment](https://smartgate-guard.vercel.app)
- [Resident deployment](https://smartgate-resident.vercel.app)

See the platform and edge READMEs for restart commands if these local processes have stopped.

## Delivered

| Area                | Implemented                                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repositories        | Baseline commits in both repositories; two Git roots with independent CI workflows; no parent repository or shared source import                                                                                                                                |
| Identity            | Users, scrypt password storage, server-side sessions with expiry and revocation, per-account lockout, password change that ends other sessions                                                                                                                  |
| Invitations         | Administrator-issued, single-use, expiring, organization/role/household/station scoped; an existing account must sign in to accept, so a token alone cannot claim an identity                                                                                   |
| Multi-factor        | RFC 6238 TOTP with single-use step tracking and one-time recovery codes                                                                                                                                                                                         |
| Authorization       | Permission templates for platform operator, HOA administrator, guard, and resident, plus an unaffiliated state for an account with no membership                                                                                                                |
| Tenancy             | Two villages concurrently; resident access limited to their households; guard access limited to assigned sites; revocation ends live sessions                                                                                                                   |
| Guard scoping       | A guard needs an active station assignment or is refused; sees only assigned stations, their lanes' activity, and a lookup of credentials valid at those lanes with no household names or raw tag values                                                        |
| Gate policy         | `credential_lanes` records which lanes a credential is valid at; enrollment can select gates and the controller configuration reflects it (no policy means every lane)                                                                                          |
| Site and lane setup | HOA administrators can create organization-scoped sites and lanes; lane changes are audited and version the edge configuration                                                                                                                                  |
| Controller identity | Single-use expiring grants, hashed per-controller credentials, lane-scoped enrollment, credential rotation/revocation, and controller heartbeat state                                                                                                           |
| Controller sync     | Real device configuration, event, and heartbeat routes resolve scope from the controller credential; demo marker is accepted only in demo mode                                                                                                                  |
| Platform boundary   | `platform.fleet.read` is platform-only, so a customer administrator cannot enumerate other customers; support elevation is read-only and audited                                                                                                                |
| Platform operations | Explicit, reason-bearing, time-limited, read-only support access with audit records; operator-controlled first account                                                                                                                                          |
| Persistence         | Tracked migration runner with per-migration checksums; separate migration and application roles; PostgreSQL 17 and embedded PGlite both exercised                                                                                                               |
| Applications        | Management, guard, and resident apps use real sign-in and invitation acceptance, reject stale sessions, and show the signed-in account and role                                                                                                                 |
| Enrollment          | Property/contact, vehicle, credential, and gate-policy enrollment; duplicate protection; assignment history; audit records                                                                                                                                      |
| Household vehicles  | Administrators can add multiple vehicles; residents can request plate, make, or color corrections or report a sold vehicle; HOA decisions are audited and tracked separately from affected-gate delivery                                                        |
| Household roster    | HOA can invite household members with relationship labels, change the primary contact, and end one member's access to a selected property without removing other home access                                                                                    |
| Access lifecycle    | Vehicle retirement preserves other household access; due move-outs cannot be rescheduled or cancelled; a database-backed worker retries failed closures fairly and preserves the scheduled cutoff; prior household events and decision actors remain attributed |
| Household records   | Organization-scoped cursor pages cover household search, household members, occupancies, and correction, replacement, retirement, and move-out history; pending work is separated from resolved history                                                         |
| Local controller    | Credential decisions, persistent cooldown, command reservation, durable event queue, HTTP synchronization                                                                                                                                                       |
| Guard               | Local status, simulated arrivals, recent activity, and static assets served from the edge                                                                                                                                                                       |
| Protocol            | Draft JSON schemas with byte-identical pinned manifests in both repositories                                                                                                                                                                                    |
| Hikvision           | Interfaces, conventional Wiegand decoder, I/O adapter boundary, uncommissioned-control rejection                                                                                                                                                                |
| UI                  | Role-specific sign-in screens, invitation management, responsive layouts, explicit development banner                                                                                                                                                           |
| Setup dashboard     | Site/lane creation, one-time controller grant, assigned-lane display, status, revocation, and credential rotation in HOA administration                                                                                                                         |

## Validation previously observed (26 September 2026)

- Platform suite: **36 tests passed, with one PostgreSQL-only lock regression skipped in PGlite**
  (**37 total**) across access-control, protocol, identity, occupancy, and
  tenant scenarios, including vehicle retirement, scheduled move-out/cutoff processing with
  concurrent-worker idempotency, history paging and cross-scope cursor rejection, stale-invitation
  rejection, the move-out race, migrations
  `007`–`008` backfill and ambiguity checks, household roster changes, and vehicle correction review.
  The suite also covers two-village isolation, session expiry and revocation, membership removal,
  invitation takeover refusal including a re-invitation token that must not claim an existing
  account, MFA replay refusal and concurrent-submission refusal, platform fleet-listing refusal for
  customer administrators, station-scoped guard data with fail-closed behaviour, gate-policy
  narrowing of a station's vehicle lookup, scope restoration after re-invitation, read-only support
  elevation, 20 concurrent event deliveries storing one event, and the due-schedule, retry, controller
  target, and active-member pagination regressions.
- Migration `008` also refuses active legacy vehicles with no current resident, uses the earliest
  current membership when checking older activity, and recovers closed occupancy dates from
  recorded memberships, assignments, and events. Resident vehicle reads require the same occupancy.
- PostgreSQL 17.11 verification passed **19 checks** with migrations `001`–`013`, including all
  platform suites, the new lifecycle regressions, data-only application privileges, migration
  refusal checks, and backup/restore. The verifier now uses run-specific database and role names and
  only drops resources created by that run.
- All three Next.js production builds, API compilation, workspace TypeScript checks, formatting
  checks, and protocol manifest checks passed.
- The platform protocol manifest check passed for all five schemas. The edge race-enabled test suite
  passed using its pinned Go 1.27.1 toolchain, including SQLite restart, exact-cutoff offline denial,
  and cancellation reauthorization. `go vet ./...` and the simulator binary build passed.
- Local browser acceptance confirmed resident retirement request, HOA approval and resident status,
  plus move-out schedule, reschedule, cancellation, and immediate household-row refresh. The browser
  also showed the demo controller connected and reporting configuration version 5. The browser
  remained at 1280×720, so phone-width acceptance, invitation/role changes, and vehicle correction
  approve/decline still need a responsive authenticated browser run.
- The isolated platform demo and edge simulator exchanged configuration and heartbeat data. The edge
  applied configuration version 5, denied the retired demo RFID credential as
  `UNKNOWN_CREDENTIAL`, uploaded one event, and retained the same configuration and event after a
  SQLite process restart. This used the demo-only controller identity and simulated hardware. No
  real enrolled HTTPS controller or physical gate was used.

## Initial next-phase implementation snapshot (27 September 2026)

- `npm test`: 49 passed, no failures, and one existing PostgreSQL-only race test skipped.
- `npm run typecheck`, `npm run build`, `npm run format:check`, and `npm run protocol:check` passed;
  the protocol manifest contains five schemas.
- `npm run verify:postgres`: all 19 checks passed against local PostgreSQL 17.11. The verifier
  applied migrations `001` through `013` with a separate migration role, confirmed the application
  role cannot change schema, ran PostgreSQL integration tests, dumped and restored representative
  data, checked migration checksums, and removed its 10 temporary databases and two roles.
- The modified edge access regression passed with `go test -race ./internal/access`. The full edge
  race suite could not run its HTTP sync test because the sandbox denied binding the test listener.
- Docker is not installed here, so the container image has not been built. PostgreSQL verification
  and an isolated dump/restore rehearsal passed locally; provider deployment and service restart
  acceptance have not run.
- The Vercel frontends build locally, but no hosted API URL exists yet. Deployed authentication,
  responsive role workflows, and enrolled HTTPS controller acceptance remain unverified.

## Hosted API audit fixes (27 September 2026)

- Fixed all four audited source defects: the standalone worker stays referenced between polls; its
  production entrypoint now passes the PostgreSQL idle window and processes a due move-out; the API
  readiness probe sends an allowed public Host while connecting locally; API and worker Docker
  targets have separate launch and health behavior; and relative embedded-data paths resolve from
  the platform root.
- A follow-up review corrected four gaps. `.dockerignore` now excludes `.data` and `.env` files at
  any depth, so the `apps/api` embedded database can no longer enter an image. The README now
  documents per-target image builds instead of running the worker in the API image. The probe
  entrypoint always runs its check; it previously skipped the check and exited 0 when started
  through a symlinked path. A failed lease lock or unlock now destroys that database session.
- A second review fixed two request-boundary defects. Attempt limits now use the router's matched
  route; previously a percent-encoded path such as `/auth/log%69n` reached the sign-in or controller
  enrollment handler after the raw path was limited. Trusted proxies are now compared as parsed
  addresses, so IPv4-mapped, compressed or expanded, and uppercase IPv6 spellings of a configured
  proxy are accepted instead of receiving 403. Fastify client-IP attribution uses the same check;
  it previously also trusted the distinct IPv4-compatible form (`::a.b.c.d`) of a mapped entry,
  which would have let that peer choose the client IP used for attempt limits.
- The ignored root `.env` now selects `apps/api/.data/postgres`, the directory the local API used
  before paths were anchored to the platform root (all 13 migrations, the five demo accounts). The
  root `.data/postgres` copy stops at migration 007, has no accounts, and fails migration 008 on its
  legacy vehicle history; it was kept untouched as an archive. No database was moved, merged, reset,
  or overwritten. On the selected directory, the local development API became ready, all five demo
  accounts signed in, the HOA snapshot loaded, and the development worker ran and stopped on SIGINT.
- `npm test`: **62 passed, 0 failed, 1 existing PostgreSQL-only test skipped**. This includes
  encoded-path sign-in and enrollment limits, equivalent-address proxy matching with untrusted-peer
  refusal, the subprocess worker-lifetime and cross-working-directory PGlite regressions, and probe
  processes run
  against a listening exact-host API on a non-default port: 403 for loopback, unapproved Host, and
  unapproved Origin requests; failure on database outage, migration mismatch, stopped and
  unresponsive services, and symlinked invocation. Static tests guard the Dockerfile targets and
  build-context exclusions.
- `npm run typecheck`, `npm run build`, `npm run format:check`, `npm run protocol:check`, and
  `git diff --check` passed. The protocol manifest contains five schemas.
- `npm run verify:postgres`: **all 20 checks passed** against PostgreSQL 17.11. In addition to
  migration-role separation, application-role DDL denial, PostgreSQL suites, and dump/restore, two
  production worker entrypoints survived the real pool idle period, processed one due move-out at
  its stored cutoff, wrote one occupancy audit record, and stopped on SIGINT and SIGTERM. A
  restarted worker completed a newly due schedule without duplicating the completed one. The
  verifier cleaned up all 11 run-owned databases and both run-owned roles.
- Docker is unavailable in this environment. The API and worker targets are implemented and pass
  static checks, but image builds and container runtime acceptance have not run. Hosted
  API/database setup and Vercel-to-API authentication remain unverified.

## Customer onboarding and current local checks (27 September 2026)

- Real mode had no way to create a village. Invitations require an existing organization, and no
  API route, screen, or command created one, so a hosted operator could not onboard a customer
  without direct SQL. An operator who signed in to the management app reached a "No access yet"
  screen.
- `POST /platform/organizations` now creates a village. It requires `organization.manage`, held
  only by platform administrators; platform support and support-grant sessions are refused. Names
  are trimmed, internal spacing is collapsed, and duplicates are refused regardless of case and
  spacing under a transaction advisory lock. Each creation writes `organization.created` to the new
  village's audit history.
- The management app shows platform accounts a **Villages** screen: the village list, an add form,
  and a per-village administrator invitation with a one-time code, an `?invite=` link, and copy
  buttons. Platform support sees the list read-only.
- The shared portal no longer shows demonstration labels to real villages. The breadcrumb, guard
  heading, resident greeting, and gate card previously read "Palm Grove", "Andrea", and "Main gate ·
  Hikvision pilot target" for every village; they now use the village's own name, site, and lanes
  and the user's first name, and say when no gate is set up. A session without a selected village no
  longer requests the village snapshot every four seconds.
- Built apps rejected every plain-HTTP API address, a regression from the Slice 1 URL validation:
  every local static export, including `npm run demo` and the edge-served guard app, showed "This
  portal is not configured". Plain HTTP is now accepted only for an explicitly configured loopback
  address. A build with `http://api.example.test` still shows the configuration screen, HTTPS and
  local loopback exports show sign-in, and a Vercel build with a loopback address fails. The demo
  command now loads the root `.env`.
- `npm test`: **70 passed, 0 failed, 2 PostgreSQL-only tests skipped** (72 total), including the
  onboarding and privileged-account MFA suites.
- `npm run verify:postgres`: **all 21 checks passed** against PostgreSQL 17.11. The onboarding suite
  ran its 4 tests there, including a concurrent duplicate-name check that holds the creation lock so
  both submissions wait at it. The production worker check now enrolls MFA for its operator and
  village administrator, as production requires, and creates its village through the onboarding
  endpoint; without that it stopped at a refused invitation. The verifier cleaned up all 12
  run-owned databases and both roles.
- `npm run typecheck`, `npm run build`, `npm run format:check`, `npm run protocol:check`, and
  `git diff --check` passed.
- A headless Brave run passed 24 checks at 1280×900 and 390×844 against the production static
  export and a throwaway real-mode API. It covered operator sign-in to the Villages screen, village
  creation, the duplicate-name alert, the invitation code and link with clipboard copy and focus
  handling, a first administrator accepting on desktop and a second on phone, no horizontal
  overflow, and no unexpected browser errors. The API then held one village with two members. This
  used embedded PostgreSQL over loopback HTTP with the MFA policy off, not a hosted HTTPS
  deployment. It passed again on the build that includes the Security screens.

## Important remaining work

- Each app has a **Security** tab, and the platform console has a panel, for authenticator
  enrollment and one-time recovery codes. Setup shows a manual key and an `otpauth://` link; there
  is no QR code yet. It is disabled for shared demo accounts. Production requires MFA for platform
  and village administrator accounts: until they enroll, the API refuses everything except account
  routes and the apps show a setup screen. Guards and residents remain optional. Neither the screen
  nor the enforced policy has had a browser acceptance pass.

- O1.4 still needs a responsive authenticated browser pass for phone width, invitation/role changes,
  vehicle-correction decisions, session/organization switching, and paged-history retention. The
  enrolled HTTPS controller workflow with a recorded acknowledgement, explicit event-replay check,
  and supervised physical-gate commissioning also remain open. Local simulator evidence does not
  establish real gate delivery or commissioning.
- The HOA UI can issue a grant and view enrolled controllers, but controller enrollment has not
  been exercised against a physical edge installation. The single-use grant code and returned
  controller credential are shown once; losing either requires revocation and a new grant or
  credential rotation.
- A deployed cross-process HTTPS exchange is still unverified. Current API integration tests,
  edge sync tests, and byte-pinned contracts verify each repository's behavior independently.
- Support elevation is read-only and audited, but the company operations view across authorized
  customer sites is not implemented yet.
- A credential with no explicit lane rows remains valid on all lanes in its village. Controller
  configuration is narrower: each edge receives only credentials valid on its assigned lanes.
  HOA policy requiring lane-by-lane vehicle restrictions still needs product confirmation.
- A withdrawn member rejoins by signing in and accepting a new invitation, which restores the
  household or station assignment. The invitation token alone cannot do it.
- Legacy records cannot always identify each past household. Older ended memberships and inactive
  vehicles may share one archive marked for review; ambiguous active vehicles stop migration until
  their ownership periods are reconciled.
- No password reset by email, no OIDC or SAML, no envelope encryption for TOTP secrets, and bearer
  tokens in memory rather than httpOnly cookies. Sensitive requests now have bounded per-process
  IP limits alongside account lockout; multiple API replicas still need shared provider-level rate
  limits. See [the authentication decision](authentication.md).
- Company fleet administration, full occupancy and reassignment workflows, named offline guard
  sessions, audited guard assistance, production guard authentication and PWA deployment, visitor
  QR, notifications, signed updates, and physical Hikvision transport and commissioning remain
  open.
- API source now validates production database, migration, demo, host, origin, and proxy settings,
  and exposes separate liveness and readiness routes. The API and database have not been deployed,
  so hosted sign-in and lifecycle flows remain unverified.

## Git and environment

Both repositories are independent local repositories on `main`. The platform foundation is
committed as `747f371` and tracks `origin/main` at `https://github.com/ejie0404/rfid.git`. The edge
foundation is committed as `bfd049b`; that repository currently has no remote. The platform has
three Vercel frontend projects as listed above. The API and PostgreSQL have not been deployed.

The current platform worktree contains uncommitted environment, container, API-runtime, worker, and
frontend changes. The edge worktree contains a pre-existing uncommitted access-engine test change;
keep that change intact while working on the platform phase.

Runtime data, `node_modules`, binaries, and the project-local Go toolchain are ignored by Git.

The PostgreSQL verifier creates run-specific databases and roles, refuses name reuse, and drops only
the resources created by the current run. It does not alter fixed verification roles or drop existing
databases.
