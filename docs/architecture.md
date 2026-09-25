# SmartGate architecture decisions

## Two repositories

| Repository         | Owns                                                                                                                                     | Release boundary                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| smartgate-platform | NestJS API; management, guard, and resident web apps; TypeScript packages; PostgreSQL; edge protocol specification; cloud infrastructure | Cloud/web releases              |
| smartgate-edge     | Go runtime; SQLite; local authorization; hardware interfaces; event queue; synchronization; local guard hosting                          | Independent controller releases |

Infrastructure remains in the platform repository. Native mobile, separate infrastructure, public SDKs, and extra hardware vendors are deferred.

## First runnable milestone

The implementation establishes a complete **simulated** path:

```text
Management enrollment
  → PostgreSQL configuration version
  → edge polls a versioned configuration
  → atomic SQLite configuration storage
  → credential presented to local simulator
  → local permission decision
  → durable event and command reservation
  → simulated barrier call
  → finalized local event
  → idempotent cloud ingestion
  → management activity
```

Local decisions never await cloud requests. Network work has bounded timeouts. Pending-event snapshots exclude in-flight scans and release the lane mutex before upload.

## Data ownership and identity

Organization identity comes from the server's authenticated principal, resolved from an
organization membership row. It is never accepted from a browser form as an authorization boundary.
Property/vehicle/credential references use composite tenant foreign keys.

```text
user
 ├── platform role (platform_admin | platform_support)  → organization metadata only
 └── organization_memberships (hoa_admin | guard | resident)
      ├── property_memberships  → which households a resident reads
      └── site_assignments      → which sites a guard operates
```

Permission templates are per role, and the cross-customer listing is a platform-only permission, so
holding `organization.read` for a village does not let its administrator enumerate other customers.

A platform administrator does not receive household data implicitly. Reading a customer
organization requires a support grant with a recorded reason and an expiry, and the grant is
written to `audit_events`. The elevation is read-only on purpose: a support session diagnoses a
customer site, it never changes one.

A guard's read scope is the station they are assigned to. Lanes belong to sites, so their activity
feed is filtered to the lanes of the assigned sites; the household roster and controller heartbeats
are not returned; and their vehicle lookup is limited to credentials valid at one of those lanes,
carrying plate, make, colour and credential status only. Household names and raw tag values are not
sent to a station at all. With no active station assignment the read is refused rather than widened.

Gate policy is recorded in `credential_lanes`. The edge already evaluates a credential's lane list,
so recording policy makes the platform's configuration match what the controller enforces, and it
is what allows a station's vehicle lookup to be narrowed. A credential with no recorded policy is
authorized at every lane in its organization, which keeps the previous behaviour as the default;
selecting specific gates during enrollment narrows it.

Sessions are server-side rows with an absolute expiry, a revocation timestamp, an MFA-satisfied
flag, and a membership binding. Removing a membership or revoking a grant revokes the affected
sessions, so access ends immediately rather than at expiry. Changing a password ends every other
session for that account, and the MFA flag is re-checked on every request rather than only at
sign-in. The implementation choice and its limits are in [authentication.md](authentication.md).

Real device identity is per controller. An HOA administrator issues a short-lived, single-use
enrollment grant scoped to a site and selected lanes. The code is stored hashed and claimed once;
the controller receives a unique credential whose hash is stored by the platform. Configuration,
heartbeat, and event routes derive organization, site, and lane scope from that credential. The
local simulator marker is accepted only in explicit demo mode. The edge persists its identity in
SQLite, requires HTTPS and an operator-approved maximum configuration age in real mode, and fails
closed on stale or foreign configuration. This prototype does not yet provide a deployed TLS setup
or physical hardware transport.

A permanent property is distinct from a credential and vehicle. Village administrators can add
several vehicles to one existing household. Full dated occupancy memberships and household people
management remain a later domain slice. Residents are already bound to properties through
`property_memberships`.

Credentials distinguish EPC from Wiegand payloads. An identifier is not proof of cryptographic
authenticity. Assignment rows retain start/end timestamps; reassignment workflows and complete
historical occupancy queries are not implemented yet.

## Compatibility and schema ownership

The platform's canonical specification is `contracts/edge/v1`. The edge's `contracts/v1` is a
reviewed snapshot with the same manifest. TypeScript and Go models are implemented separately,
with schema checks and repository-level sync tests. A deployed cross-process exchange remains to
be verified.

Current draft: `1.0.0-draft.2`. Enrollment request and response contracts are included and pinned
byte-for-byte in the edge repository. No deployed compatibility promise is claimed. Configuration,
event, heartbeat, and enrollment envelopes use protocol version 1; remote command contracts remain
out of scope.

The draft event contract deliberately permits only unconfirmed passage and simulated actuation.
Adding actual hardware outcomes requires an explicit protocol review before deployment.

## Database schema ownership and migration

`database/migrations/*.sql` are applied by a tracked runner and recorded with a per-migration
checksum; a migration modified after it was applied is refused rather than re-run. The deployable
application runs with migration privileges removed and verifies the schema instead of changing it,
so a misprovisioned role cannot silently migrate. See [postgresql.md](postgresql.md).

## Deployment and guard hosting

The guard app builds separately as a static artifact. The edge accepts an explicit artifact
directory. Updating a dashboard does not trigger an edge release.

Local guard hosting was tested by cold-loading its assets from the edge while the cloud API was
stopped. This does not yet establish a production PWA cache, trusted local HTTPS, offline staff
identity, or supported industrial tablet deployment. Offline guard sign-in is a later step.

## Next development gates

1. Run final PostgreSQL verification and a cross-process enrollment/configuration/event sync check.
2. Confirm Hikvision control ownership and protocol capture; implement the first actual transport.
3. Verify real I/O feedback, safe installer commissioning, and hardware fault behavior.
4. Complete the company operations view across authorized customer sites and offline guard workflow.
5. Complete full property/occupancy workflows and permission-controlled guard assistance.
6. Add gate-bound visitor passes and durable local redemption with explicit outage limits.
7. Prepare production deployment: TLS, migration and secret management, alerts, signed updates, and
   operational support.

The original 36 slices remain planning references, not a completed checklist.
