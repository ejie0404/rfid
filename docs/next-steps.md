# SmartGate: plan from the current prototype to one supervised gate pilot

For slice-by-slice deliverables, dependencies, and acceptance checks, see the [detailed implementation plan](detailed-implementation-plan.md).

Updated 25 September 2026. This plan covers the platform repository (API and three web apps) and the separate Go edge repository. It does not assume that a Hikvision device protocol or Philippine hardware SKU has been confirmed.

## Current starting point

- Both repositories are separate Git roots on `main`; the platform foundation is committed locally and the edge foundation is committed as `bfd049b`. Neither repository has a remote.
- The HOA can create sites and lanes, issue a single-use enrollment grant, and view controller scope and sync health. Real sync authenticates with a per-controller credential; only demo mode accepts the local simulator marker.
- The edge stores controller identity locally, requires HTTPS and an explicit cached-authorization age in real mode, rejects stale or foreign configuration, and queues events offline. Physical hardware remains disabled.
- Protocol draft `1.0.0-draft.2` is pinned byte-for-byte across the repositories. All 14 isolated PostgreSQL checks passed against PostgreSQL 17.11 and migrations `001`–`005`; complete the local diff review and create reviewable local commits before moving into the next feature slice.

## 1. Finish and save the account and app slice

**Owner: platform. Invitation browser acceptance remains the immediate verification gate; the PostgreSQL and commit steps are complete.**

- Signed-in invitation acceptance is implemented. Walk through a new HOA administrator, guard, and homeowner plus an existing user accepting a second-village invitation. Preserve evidence that invitation context survives password and MFA sign-in.
- Walk through first-time HOA administrator, guard, and homeowner invitations; existing-account acceptance; revoked-member rejoining; and switching between two organizations. Ensure each app opens in the correct role and organization after acceptance.
- The PostgreSQL migration and restore rehearsal with migrations `001` through `005` has passed, including an application role that cannot change the schema. Repeat the relevant test suite after any changes made during diff review.
- The platform implementation, migration, and documentation are committed together. Keep runtime data and credentials out of Git. Choose GitHub owner and visibility before adding remotes or publishing.

**Acceptance gate:** all three account journeys work through the web apps; existing accounts cannot be claimed by an invitation token alone; the final schema works on PostgreSQL and restores correctly; platform and edge changes have reviewable local commits.

## 2. Give each controller its own identity and scope

**Owners: platform and edge. Core software is implemented; joint deployment verification remains.**

1. Model the real HOA, site, gate, lane, controller, and installation relationships. Add an authorized company/HOA setup flow for creating and assigning them. Keep household data out of the company fleet view by default.
2. Issue one-time enrollment material for a specific installation and give each controller a unique, renewable credential. Record who enrolled it, when, its assigned lanes, and its last acknowledged configuration version.
3. Bind configuration downloads, heartbeats, and event uploads to the enrolled controller identity. Remove the shared simulator token and fixed IDs from the operational path; reject cross-organization and cross-lane claims. Retain a separate development simulator mode.
4. Define what revocation does while the edge is offline, when cached permissions expire, how a replacement controller inherits a site, and how queued events remain attributable. Carry those choices in the versioned platform-to-edge protocol.
5. Add controller status and configuration-delivery views to HOA/company administration and the assigned guard station. Use authenticated, encrypted transport in the deployment design.

**Acceptance gate:** two controllers in different villages can enroll and synchronize independently; a stolen or revoked controller credential cannot access another site; an offline controller follows a documented cached-policy rule; event replay stays idempotent.

## 3. Connect one real Hikvision lane

**Owner: edge, with an installer and bench equipment. Discovery starts alongside Step 2.**

Target the DS-TRI900-1/A reader, DS-TME200 controller line, DS-TMG320 barrier series, and DS-TMG035 radar series. Confirm the exact regional models, firmware, local interface, wiring, tag frequency, and safety inputs before purchasing or writing a transport-specific driver. Obtain sample reader events, EPC/Wiegand mapping, command acknowledgement or isolated I/O details, and an installer-approved wiring diagram.

Then implement the selected reader, barrier, and detector adapters behind the existing Go interfaces. Verify that SmartGate's local decision is authoritative and no independent allowlist opens the barrier. Keep radar and barrier safety functions independent of cloud availability. The guard station must show observed lane state and failed commands, not merely a requested opening.

**Acceptance gate:** on supervised hardware, an authorized tag opens the boom, a denied tag does not request an opening, passage is recorded only from an independent observation, and power, detector, obstruction, and manual-release behavior match the approved operating procedure.

## 4. Finish the three operating dashboards before expanding the pilot

Build these workflows while Steps 2 and 3 advance; do not wait until hardware integration ends.

| App                                                     | Pilot-critical work                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HOA and company administration (`control-web`)          | Reuse existing properties for multiple vehicles; manage moves, sales, lost/replacement tags, lane policy, staff access, gate sync, and incident review. Give company operators a scoped fleet/support view without automatic household access.                               |
| Homeowner portal (`resident-web`)                       | Show the household's vehicles, tags, gate-delivery status, loss/correction requests, and request resolution. Keep the phone-browser layout and define who may see movement history.                                                                                          |
| Guard station (`guard-web`, served locally by the edge) | Provide named shift sessions, assigned lane status, live reads and clear denial reasons, incident notes, and an authorized manual-assistance flow with a reason and audit record. Prove local authentication, HTTPS, cold start, and offline behavior on the actual station. |

**Acceptance gate:** HOA staff, a homeowner, and a guard can each complete their part of a failed-tag, different-car, move-out, and internet-outage scenario. A manual barrier action is attributable and obeys the physical safety system.

## 5. Run one supervised resident pilot

Agree with one HOA and installer on the lane, participating households, operating hours, manual fallback, support contacts, privacy notice, retention, and success measures. Commission the barrier and safety devices; rehearse controller replacement, queued-event recovery, database restore, signed update rollback, emergency access, and power-loss behavior. Measure read success, assistance rate, local decision latency, and synchronization age before wider enrollment.

**Acceptance gate:** installer, HOA, and SmartGate operators sign off on the physical lane and its operating procedure. Simulator results and software builds alone do not satisfy this gate.

## After the resident pilot

Add visitor invitations and QR passes with expiry, one-time redemption, cancellation, and offline rules. Expand to more lanes and villages only after the first site's results are acceptable. A separately installed homeowner mobile app, cameras, ANPR, billing, and more hardware vendors should follow demonstrated demand.

**Immediate order:** walk the invitation acceptance matrix in the browser → verify platform-to-edge enrollment/configuration/event sync together → finish dated occupancy, replacement requests, and offline guard sessions → obtain exact Hikvision SKU/protocol/wiring evidence → commission a supervised lane and rehearse the resident pilot.
