# SmartGate detailed implementation plan

Updated 25 September 2026. Scope: one supervised resident RFID pilot at one subdivision gate, followed by a decision about expansion. The plan uses two repositories: `smartgate-platform` for the NestJS API, PostgreSQL schema, shared contracts, and the three Next.js apps; `smartgate-edge` for Go, SQLite, local authorization, guard asset serving, and hardware adapters. The platform owns the versioned cloud-to-edge protocol.

## Current baseline and limits

The local prototype has login, organization membership, invitation and MFA flows, HOA enrollment, homeowner status/loss reporting, a guard station view, a simulated edge decision engine, a durable event queue, and draft protocol schemas. This implementation pass adds signed-in invitation acceptance, HOA site/lane setup, one-time controller enrollment, per-controller credentials, lane-scoped cloud sync, controller status in the HOA and guard views, and edge-side identity with a required offline policy in real mode. The platform and edge checks are recorded in `implementation-status.md`; PostgreSQL verification is run against the current five-migration set before this plan is finalized. No Git remote, deployment, purchased hardware, or real gate actuation is confirmed.

The real pilot path now uses enrolled controller identities and per-controller credentials; fixed demonstration IDs and the local simulator marker remain confined to demo mode. The guard web app is served locally by the edge, but offline guard sign-in and real barrier control are still open. The Hikvision models are integration targets, with exact Philippine SKUs, firmware, protocol, and wiring to confirm.

## Delivery order and parallel work

| Track                   | Order             | Output                                                                   | Depends on                                                     | Status                                                                   |
| ----------------------- | ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Account and app closure | A1 → A2           | Complete invitations; reviewable platform commit and PostgreSQL evidence | Current prototype                                              | A1 implemented; full browser matrix pending; A2 verification/commit done |
| Device foundation       | D1 → D2 → D3 → D4 | Real site inventory, controller enrollment, scoped sync, fleet views     | A2                                                             | Software implemented; real-device exchange and rollout remain unproven   |
| Hardware                | H1 → H2 → H3      | Confirmed Hikvision interface, bench driver, supervised lane             | H1 starts now; H2 needs device/interface evidence; H3 needs D4 | H1 blocked on exact regional hardware and installer evidence             |
| Daily operations        | O1 and O2 → O3    | HOA/homeowner lifecycle and local guard workflows                        | A2; O3 also needs D4                                           | O1 and O2 partial; O3 not started                                        |
| Deployment and pilot    | O3 → R1           | Reviewed deployment, then one supervised resident pilot                  | D4, H3, O1, O2                                                 | Not started; requires physical commissioning and operational sign-off    |

Hardware discovery and the HOA/homeowner flows can progress while controller identity is built. Physical barrier actuation stays disabled until the installer approves the wiring and safety behavior.

## A1. Close account onboarding in all three apps

**Status:** signed-in invitation acceptance is implemented in the management app and invitation context is retained through sign-in and MFA. The full first-time, existing-account, and rejoining browser acceptance matrix still needs to be walked through.

**Repository:** platform. **Size:** one small reviewable change.

- Add an invitation action in the signed-in dashboard. An existing account already scoped to Village A must be able to accept an invitation to Village B without using the API manually.
- Keep an invitation code available through password sign-in, MFA verification, and organization selection. After acceptance, show the newly granted village and the correct role.
- Keep first-time signup, existing-account acceptance, and revoked-member rejoining distinct. A token alone must never claim an existing identity.
- Confirm the guard and homeowner apps route users to their proper role-specific screens. Server permissions remain the authority if an app is opened with the wrong role.

**Acceptance:** a new HOA admin, guard, and homeowner can each accept an invitation through the web UI; a previously enrolled user can join a second village; an unauthenticated token cannot impersonate an existing account; revocation still ends the old session.

## A2. Verify and save the account slice

**Status:** all 14 PostgreSQL checks pass against PostgreSQL 17.11 and migrations `001`–`005`. The platform foundation is committed locally; no remote or deployment was created.

**Repository:** platform.

- Run migrations `001` through `005` against a disposable PostgreSQL server using separate migration and application roles. Rehearse backup/restore and confirm application startup refuses a missing or newer migration.
- Review the full platform diff, run its existing quality checks, inspect runtime data exclusions, and create a local commit containing the identity, lane policy, dashboard, and documentation work.
- Keep both repositories independent. Decide GitHub owner and visibility before creating remotes; a remote or deployment is not part of this slice.

**Acceptance:** PostgreSQL behavior is recorded against the exact commit, no secrets or runtime database files are staged, and the next device work starts from a recoverable baseline. If PostgreSQL is unavailable, record that gap rather than treating PGlite as equivalent.

## D1. Model the real site and controller inventory

**Status:** implemented: HOA administrators can create sites and lanes and issue lane-scoped controller enrollment grants; controllers and assignments are persisted with audit history.

**Repository:** platform. **Protocol impact:** none until reviewed.

- Add durable records for the real organization, site, gate, lane, controller, installation, and controller-to-lane assignment. Existing `sites`, `lanes`, and `credential_lanes` are the starting point; add only the missing relationships and uniqueness constraints.
- Define who may create a site, assign a controller, move it, or retire it. A company operator may see fleet and support metadata across customers; an HOA administrator sees only its village; neither role automatically gains more household data than its permissions allow.
- Add authorized setup screens in `control-web`. A real village must be able to create its lanes before vehicle enrollment, rather than depending on demonstration seeds.
- Preserve gate and lane history when equipment is replaced so old access events remain attributable.

**Acceptance:** two villages can each create a site and controller without shared IDs; the same controller cannot belong to two installations at once; an HOA cannot read or change another HOA's inventory.

## D2. Specify one-time controller enrollment and protocol versioning

**Status:** implemented as contract draft `1.0.0-draft.2`, with enrollment request/response schemas and a byte-pinned platform-to-edge bundle. This is not yet a deployed compatibility guarantee.

**Owner:** platform contract, reviewed for edge compatibility before implementation.

- Define a short-lived, single-use enrollment grant tied to one installation, its issuer, and intended lanes. Choose the device credential format and renewal mechanism after deciding where its secret or key is stored on the actual edge computer.
- Extend the versioned protocol with enrollment, controller identity, configuration acknowledgement, and credential status. Keep the existing event UUID and sequence semantics so retries remain safe.
- Specify how a controller proves its identity on configuration, heartbeat, and event calls; how the server rejects another controller's organization/lane IDs; and how clock drift and lost connectivity affect enrollment and renewal.
- Document compatibility between platform and edge versions, including which older edge release remains supported during a platform rollout. Publish a protocol bundle from the platform and pin it explicitly in the edge repository.

**Acceptance:** the protocol has examples for first enrollment, retry, expiry, revocation, replacement, and an offline reconnect. Reviewers can identify exactly which IDs are server-assigned and which claims a controller may submit.

## D3. Implement platform-side controller enrollment and scoped sync

**Status:** implemented with hashed, single-use enrollment codes, per-controller credentials, revocation/rotation, and organization/site/lane-scoped config, event, and heartbeat handling. The final five-migration set passes the PostgreSQL rehearsal; deployment-level cross-process verification remains open.

**Repository:** platform.

- Add enrollment grant and controller credential persistence with one-time claim semantics and audit records. Rate-limit and bound the enrollment exchange.
- Make configuration downloads, heartbeat ingestion, and access-event upload resolve organization, site, gate, and lanes from the authenticated controller. Remove fixed demonstration IDs from the real path; keep simulator behavior isolated in development mode.
- Reject cross-site events and configuration requests. Keep configuration versions monotonic and event ingestion idempotent. Record the controller's last contact, software/protocol version, pending-event count, configuration version, and acknowledgement.
- Add revocation, replacement, and credential renewal operations. Write the intended offline behavior down before permitting a real gate to use cached permissions.

**Acceptance:** two enrolled controllers in different villages cannot exchange configuration or spoof each other's events; replayed events create one record; a revoked credential loses cloud access; a replaced controller receives only its assigned policy.

## D4. Implement edge-side identity, cache policy, and recovery

**Status:** implemented in the edge software: enrollment identity is persisted locally, real mode requires HTTPS and an explicit HOA-approved maximum configuration age, and stale or foreign configuration fails closed. Only simulator hardware can currently run.

**Repository:** edge. **Dependency:** D2 contract and D3 enrollment API.

- Enroll once through an operator-controlled local setup, store the unique device identity and secret/key with restricted local access, and reconnect with encrypted transport. Do not embed credentials in the binary, repository, or web assets.
- Bind the local SQLite state to the enrolled controller and installation. Persist the last verified configuration, acknowledgement, event queue, sequence, and software/protocol version across restart.
- Apply only increasing configuration versions for the assigned lanes. Deny unknown credentials. Define the maximum accepted age of cached permissions, the behavior when revocation cannot be received, and the manual fallback with the HOA before the pilot.
- Reconcile queued events after an outage without duplicates, including after a controller restart or replacement. Keep local authorization independent of cloud response time.
- Package the guard web assets with a compatible edge release and document rollback to the prior edge version.

**Acceptance:** local decisions continue under the agreed offline policy, a stale or foreign configuration is refused, and queued events survive restart and upload once after connectivity returns.

## H1. Resolve the Hikvision bill of materials and control boundary

**Status:** target topology recorded; exact Philippine SKUs, firmware, local protocol, wiring, and installer approval are still unverified, so hardware work remains blocked.

**Owner:** installer with SmartGate edge engineer. **Starts now.**

Target the DS-TRI900-1/A reader, DS-TME200-D/P controller line or local equivalent, DS-TMG320 barrier, DS-TMG035 radar, and compatible EPC C1 Gen2 windshield tags. Before ordering, record exact regional suffixes, firmware, Philippine radio variant, boom length/orientation, power and I/O ratings, and tag placement. The existing [Hikvision pilot notes](hikvision-pilot.md) list the open evidence.

Obtain the reader/controller SDK or protocol, sanitized real event samples, EPC-to-Wiegand mapping, command/acknowledgement behavior, and a manufacturer/installer-approved wiring and safety diagram. Confirm whether the UHF controller can report reads while leaving the access decision to SmartGate; prevent an unsynchronized internal allowlist from opening the barrier.

**Acceptance:** one reviewed integration path is chosen: supported local protocol or approved isolated I/O. The team can point to the exact event format, control signal, barrier feedback, and independent safety wiring. No driver is based on an assumed ISAPI endpoint or generic GPIO pinout.

## H2. Build and observe one bench driver

**Repository:** edge. **Dependency:** H1 documentation and bench equipment.

- Implement the selected Hikvision reader transport, barrier command/feedback, and detector input behind the existing Go interfaces. Keep the simulator for repeatable development.
- Normalize a read to the correct EPC or Wiegand format; record device timestamps, duplicates, and near-lane reads. Distinguish `decision`, `open requested`, `open acknowledged`, `boom raised`, and `vehicle passage observed`.
- Keep radar/anti-fall behavior wired to the barrier's safety system, independently of SmartGate and internet connectivity. Require commissioning mode and installer supervision before live output is enabled.
- Exercise unknown, suspended, lost, and wrong-lane tags; sensor failure, stalled boom, manual release, and edge restart.

**Acceptance:** a real tag reaches the local decision engine and produces an observed barrier outcome; denied reads never generate an open request; a command timeout or sensor fault is visible to the guard and logged accurately.

## H3. Commission one physical lane

**Owners:** installer, HOA, SmartGate. **Dependencies:** H2 and D4.

- Test actual cars and windshield placements, nearby-lane reads, tinted glass, queueing, tailgating observations, detector faults, obstruction, emergency/manual access, reboot, internet loss, and the agreed power-loss behavior.
- Verify the boom's independent safety protections and document the installer sign-off, physical manual fallback, and who can disable SmartGate control.
- Record read, decision, command, feedback, and passage timings separately. Tune placement and read power on the site without weakening the safety design.

**Acceptance:** the installer and HOA approve a written operating procedure. The recorded evidence shows that authorized access, denial, and common faults behave as agreed on physical equipment.

## O1. Complete HOA and homeowner lifecycle workflows

**Status:** partial. Site/lane setup, controller monitoring, and adding another vehicle to an existing household are present. Dated occupancy, household people management, replacement requests, and per-controller delivery acknowledgement workflows remain.

**Repository:** platform. **Can advance while D2-D4 run.**

- Reuse an existing property for multiple vehicles and people. Represent ownership/tenancy start and end dates so move-outs, vehicle sales, and tag replacements preserve historical attribution.
- Add explicit request/review states for homeowner vehicle corrections, lost tags, and replacement. Make an HOA decision auditable and show when each controller has acknowledged a changed credential.
- Make the resident portal show its own household, credential and request status, and a privacy-scoped activity view. Confirm the flow on a phone browser with pilot households.
- Give the HOA a reliable view of pending enrollments, stale gates, and exceptions. Company support may see fleet health only through its approved role and support grant.

**Acceptance:** a homeowner reports loss, HOA staff replace the tag without reopening the old one, the resident sees progress, and an offline gate's pending delivery is clear. A move-out removes access while historical events remain attributable to the correct occupancy period.

## O2. Complete the local guard workflow

**Status:** partial. The guard view reports its assigned lanes and local configuration freshness/authorization availability. Named offline shift sessions, incident notes, audited assistance, and device-level acceptance remain.

**Repositories:** guard app in platform; local auth/status and asset serving in edge. **Dependency:** D4 for controller identity.

- Add named guard shift start/end, assigned station, live reads/denial reason, searchable vehicle assistance, and incident notes. Avoid sending household rosters or raw tag inventories to the guard browser.
- Define a local sign-in mechanism that works during WAN loss, including how credentials and revocations reach the station and how long cached guard authorization remains valid. Serve the app locally over HTTPS and verify a cold start on the intended guard device.
- Implement manual assistance only for an explicit guard permission and reason, with an audit record, command outcome, and installer-approved physical safety path. Provide a clear procedure for emergencies and for a dead edge computer.

**Acceptance:** a named guard can complete a shift with the internet disconnected, identify an unknown or denied vehicle, escalate an incident, and perform only authorized manual action. A revoked guard's offline access follows the documented expiry rule.

## O3. Build production operations and recovery

**Repositories:** both. **Dependencies:** D4, O1, O2.

- Replace the prototype-only runtime boundary with a reviewed deployment configuration: HTTPS, secret storage, privileged-account MFA enforcement, session/cookie strategy, reverse proxy, access logs, and least-privilege PostgreSQL credentials.
- Define backups, restore rehearsal, configuration and edge-update signing, rollback, controller health alerts, queue-age alerts, and support escalation. Keep platform and edge releases independent.
- Publish privacy notices, data-retention choices, audit access rules, and incident response responsibilities for the pilot HOA. Decide whether the company operates the database and support channel or the HOA does.
- Rehearse loss of cloud, database, edge disk, controller credentials, and a bad software release on a staging setup before the site is left unattended.

**Acceptance:** an operator can restore the platform and replace or roll back one edge controller without losing attribution or silently restoring revoked access. Monitoring and on-call ownership are documented.

## R1. Pilot preparation and controlled launch

**Dependencies:** H3 and O3. **Participants:** one HOA, installer, SmartGate operator.

- Select one lane and a small, explicitly enrolled group of resident vehicles. Agree on operating hours, existing visitor procedure, manual fallback, signage, support contacts, and who may suspend the pilot.
- Agree before launch on acceptable read success, manual-assistance rate, false/near-lane reads, local decision latency, cloud sync delay, uptime, and safety incidents. Measure baseline traffic and set numeric thresholds with the HOA and installer; do not invent them from the simulator.
- Run a supervised observation period, review daily exceptions and queue health, and stop or roll back if safety or access outcomes differ from the approved procedure.

**Acceptance:** the HOA and installer sign off on observed outcomes and the support team can operate the lane without a developer present. Expansion requires a written pilot review, not only a successful demo.

## R2. Expansion after the resident pilot

Visitor invitations and QR passes come next, with one-time redemption, cancellation, expiry, re-entry, offline handling, and guard assistance. Then consider more lanes, additional villages, billing, notifications, cameras, and a native homeowner app based on pilot demand. A third infrastructure repository and a separate contracts repository are not required for this pilot.

## Decisions to close before committing to dates or equipment

| Decision                                                        | Needed for                        | Evidence or owner                                    |
| --------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Exact reader, controller, barrier, radar, tag SKUs and firmware | Purchase and H2 driver            | Local Hikvision supplier and installer               |
| Reader event and barrier command interface                      | H2 implementation                 | Device protocol/SDK, event capture, wiring diagram   |
| UHF radio variant and tag placement                             | On-site read reliability          | Regional documentation and supervised vehicle trials |
| Maximum offline authorization age and revocation rule           | D4 and pilot safety/access policy | HOA and SmartGate operations                         |
| Edge computer, credential storage, guard station device         | D2, D4, O2                        | Installer and operations                             |
| Hosting, support owner, retention, and backup target            | O3                                | SmartGate business and pilot HOA                     |
| Site-specific success thresholds and manual fallback            | R1                                | HOA, installer, SmartGate                            |

The immediate critical path is **A1 → A2 → D1 → D2 → D3 → D4 → H3/O3 → R1**. H1 starts in parallel; H2 waits for real device evidence. O1 can start after A2, and O2 begins as the edge identity and local station design settle.
