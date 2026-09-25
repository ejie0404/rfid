# SmartGate implementation status

Updated 25 September 2026.

**Real accounts, organization membership, invitation acceptance, controller identity, scoped sync,
site/lane setup, and the first usable version of all three applications are implemented. The edge
still runs simulated hardware; this is not a completed V1 or a commissioned gate system.**

## Open the running previews

- [Village management](http://127.0.0.1:3000)
- [Guard web app](http://127.0.0.1:3001)
- [Resident portal](http://127.0.0.1:3002)
- [Guard app served by the edge](http://127.0.0.1:4200)

See the platform and edge READMEs for restart commands if these local processes have stopped.

## Delivered

| Area                | Implemented                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repositories        | Baseline commits in both repositories; two Git roots with independent CI workflows; no parent repository or shared source import                                                                         |
| Identity            | Users, scrypt password storage, server-side sessions with expiry and revocation, per-account lockout, password change that ends other sessions                                                           |
| Invitations         | Administrator-issued, single-use, expiring, organization/role/household/station scoped; an existing account must sign in to accept, so a token alone cannot claim an identity                            |
| Multi-factor        | RFC 6238 TOTP with single-use step tracking and one-time recovery codes                                                                                                                                  |
| Authorization       | Permission templates for platform operator, HOA administrator, guard, and resident, plus an unaffiliated state for an account with no membership                                                         |
| Tenancy             | Two villages concurrently; resident access limited to their households; guard access limited to assigned sites; revocation ends live sessions                                                            |
| Guard scoping       | A guard needs an active station assignment or is refused; sees only assigned stations, their lanes' activity, and a lookup of credentials valid at those lanes with no household names or raw tag values |
| Gate policy         | `credential_lanes` records which lanes a credential is valid at; enrollment can select gates and the controller configuration reflects it (no policy means every lane)                                   |
| Site and lane setup | HOA administrators can create organization-scoped sites and lanes; lane changes are audited and version the edge configuration                                                                           |
| Controller identity | Single-use expiring grants, hashed per-controller credentials, lane-scoped enrollment, credential rotation/revocation, and controller heartbeat state                                                    |
| Controller sync     | Real device configuration, event, and heartbeat routes resolve scope from the controller credential; demo marker is accepted only in demo mode                                                           |
| Platform boundary   | `platform.fleet.read` is platform-only, so a customer administrator cannot enumerate other customers; support elevation is read-only and audited                                                         |
| Platform operations | Explicit, reason-bearing, time-limited, read-only support access with audit records; operator-controlled first account                                                                                   |
| Persistence         | Tracked migration runner with per-migration checksums; separate migration and application roles; PostgreSQL 17 and embedded PGlite both exercised                                                        |
| Applications        | Management, guard, and resident apps use real sign-in and invitation acceptance, reject stale sessions, and show the signed-in account and role                                                          |
| Enrollment          | Property/contact, vehicle, credential, and gate-policy enrollment; duplicate protection; assignment history; audit records                                                                               |
| Household vehicles  | Administrators can add multiple vehicles to an existing household; household lookup is organization-scoped and cross-village selection returns not found                                                 |
| Access lifecycle    | Suspension, reactivation, resident lost-tag reporting, configuration versioning, and edge acknowledgement                                                                                                |
| Local controller    | Credential decisions, persistent cooldown, command reservation, durable event queue, HTTP synchronization                                                                                                |
| Guard               | Local status, simulated arrivals, recent activity, and static assets served from the edge                                                                                                                |
| Protocol            | Draft JSON schemas with byte-identical pinned manifests in both repositories                                                                                                                             |
| Hikvision           | Interfaces, conventional Wiegand decoder, I/O adapter boundary, uncommissioned-control rejection                                                                                                         |
| UI                  | Role-specific sign-in screens, invitation management, responsive layouts, explicit development banner                                                                                                    |
| Setup dashboard     | Site/lane creation, one-time controller grant, assigned-lane display, status, revocation, and credential rotation in HOA administration                                                                  |

## Validation observed

- Platform suite: **25 tests passed** across access-control, protocol, identity, and tenant
  scenarios, including adding a second vehicle to a household without duplicating the property.
  The suite also covers two-village isolation, session expiry and revocation, membership removal,
  invitation takeover refusal including a re-invitation token that must not claim an existing
  account, MFA replay refusal and concurrent-submission refusal, platform fleet-listing refusal for
  customer administrators, station-scoped guard data with fail-closed behaviour, gate-policy
  narrowing of a station's vehicle lookup, scope restoration after re-invitation, read-only support
  elevation, and 20 concurrent event deliveries storing one event.
- **14 PostgreSQL checks passed against PostgreSQL 17.11** with migrations `001`–`005`: separate
  migration/application roles, schema write restrictions, refusal of unmigrated and partial
  schemas, both test suites on PostgreSQL (10 API and 15 identity tests), backup/restore preserving
  representative state, and checksum refusal for a modified migration.
- All three Next.js production builds, API compilation, workspace TypeScript checks, formatting
  checks, and protocol manifest checks passed.
- Edge: race-enabled Go tests, `go vet`, and the edge binary build passed; the pinned protocol
  manifest matches the platform draft `1.0.0-draft.2` byte for byte.

## Important remaining work

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
- No password reset by email, no OIDC or SAML, no envelope encryption for TOTP secrets, bearer
  tokens in memory rather than httpOnly cookies, and no login rate limiting beyond per-account
  lockout. See [the authentication decision](authentication.md).
- Company fleet administration, full occupancy and reassignment workflows, named offline guard
  sessions, audited guard assistance, production guard authentication and PWA deployment, visitor
  QR, notifications, signed updates, and physical Hikvision transport and commissioning remain
  open.
- The prototype still refuses `NODE_ENV=production` and binds loopback only. A real deployment
  remains a separate, reviewed release.

## Git and environment

Both repositories are independent local repositories on `main`. The platform foundation is
committed locally; the edge foundation is committed as `bfd049b`. Neither repository has a remote.
No push, GitHub repository creation, deployment, or hardware purchase was performed.

Runtime data, `node_modules`, binaries, and the project-local Go toolchain are ignored by Git.

The PostgreSQL verification creates and drops its own databases, and leaves two clearly named
verification roles for inspection. It does not touch any existing database.
