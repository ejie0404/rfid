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

Organization identity comes from the server's principal or enrolled device context. It is never accepted from a browser form as an authorization boundary. Property/vehicle/credential references use composite tenant foreign keys.

A permanent property is distinct from a credential and vehicle. The current enrollment UI creates a property with a primary resident contact; full dated occupancy memberships and adding several vehicles to an existing household remain a later domain slice.

Credentials distinguish EPC from Wiegand payloads. An identifier is not proof of cryptographic authenticity. Assignment rows retain start/end timestamps; reassignment workflows and complete historical occupancy queries are not implemented yet.

## Compatibility and schema ownership

The platform's canonical specification is `contracts/edge/v1`. The edge's `contracts/v1` is a reviewed snapshot with the same manifest. TypeScript and Go models are implemented separately, with schema checks and a verified live exchange.

Current draft: `1.0.0-draft.1`. No deployed compatibility promise is claimed. Configuration, event, and heartbeat envelopes have protocol version 1. Provisioning and remote command contracts should be added only with their actual implementations.

The draft event contract deliberately permits only unconfirmed passage and simulated actuation. Adding actual hardware outcomes requires an explicit protocol review before deployment.

## Deployment and guard hosting

The guard app builds separately as a static artifact. The edge accepts an explicit artifact directory. Updating a dashboard does not trigger an edge release.

Local guard hosting was tested by cold-loading its assets from the edge while the cloud API was stopped. This does not yet establish a production PWA cache, trusted local HTTPS, offline staff identity, or supported industrial tablet deployment.

## Next development gates

1. Real user identity, membership lifecycle, privileged MFA, and scoped device provisioning.
2. Confirmed Hikvision control ownership and protocol capture; implement the first actual transport.
3. Real I/O feedback, safe installer commissioning, and hardware fault tests.
4. Full property/occupancy workflows and permission-controlled guard exceptions.
5. Gate-bound visitor passes and durable local redemption with explicit outage limits.
6. Production PostgreSQL migration/recovery, MQTT ACLs and TLS, certificate lifecycle, signed updates, and operational support.

The original 36 slices remain planning references, not a completed checklist.
