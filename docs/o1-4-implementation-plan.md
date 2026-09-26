# O1.4 implementation plan: complete household access lifecycle

Prepared 26 September 2026. This is the proposed next implementation phase after O1.3.

**Outcome:** HOA staff can retire one sold vehicle, schedule a household move-out, and find every relevant household or request. Residents can follow decisions and gate delivery from a phone browser. Historical records retain their original vehicle and occupancy attribution.

## 1. Starting point

O1.1 delivered lost-tag replacement. O1.2 delivered occupancy history and immediate move-out. O1.3 delivered household members, primary-contact changes, and resident vehicle corrections with HOA decisions and gate acknowledgement.

The latest recorded verification is 33 platform tests, 17 PostgreSQL checks against migrations `001`–`009`, and passing application builds, TypeScript, formatting, and protocol checks. These are prior verification results; preparing this plan does not rerun them. The lifecycle implementation remains uncommitted locally.

Current gaps that this phase addresses:

- Removing a sold vehicle without ending the entire household's access.
- Scheduling, changing, or cancelling a future move-out.
- Reaching records beyond the snapshot's 300 household-member and 100 vehicle-correction limits.
- Completing browser acceptance for the recent household changes.
- Exercising the platform and edge together for lifecycle configuration changes.

The platform already exports credential `valid_until`, and the edge denies a credential at or after that time. Scheduled expiry can use the existing protocol fields. End-to-end acceptance must establish that both processes apply the same cutoff.

## 2. Delivery order

| Block | Implementation                                                      | Completion evidence                                                                          |
| ----- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A     | Review the O1.3 browser flows and record the starting diff          | Correct role, household, request, and delivery state in management and resident apps         |
| B     | Vehicle sale and removal requests, decisions, and retirement        | One vehicle loses access; the household and its other vehicles retain access                 |
| C     | Scheduled move-out, local credential expiry, and durable processing | Due access ends even when the cloud worker is late; an informed offline edge rejects the tag |
| D     | Scoped pagination, search, and lifecycle work queues                | Records beyond the previous limits are reachable and pending work is discoverable            |
| E     | PostgreSQL, platform/edge exchange, and phone-browser acceptance    | Race, restart, outage, history, and role scenarios pass on the final code                    |
| F     | Documentation and reviewable changes                                | Evidence, remaining limitations, and separate platform/edge diffs are ready for review       |

Start implementation with Block B after the bounded baseline review. Block C should be a separate reviewable change because it changes when access ends automatically.

## 3. Block A: close the browser evidence gap

Record the existing Git diff before changes and preserve the pending migrations and lifecycle implementation. Verify the currently affected flows in local management and resident previews:

1. Invite a new household member and accept as an existing account.
2. Confirm the invited role and organization open correctly, including a person who holds both resident and HOA roles.
3. Change the primary contact, remove one member, and confirm that person's other household remains accessible.
4. Submit, approve, and decline a vehicle correction; check the resident's resulting status.
5. Show a controller waiting for configuration, then acknowledge the required version and confirm the delivery display changes.
6. Check narrow phone layouts, required fields, loading/error states, and a repeated button click.

Fix defects found in these flows before extending their lifecycle behavior. Record observed browser results separately from automated results and simulated controller results.

## 4. Block B: retire one sold or removed vehicle

**User flow**

A resident selects an active vehicle, chooses “Report vehicle sold or removed,” supplies a reason, and submits a request. The request stays pending until an HOA administrator approves or declines it. HOA staff can also remove a vehicle directly with a reason. A resident can withdraw their own pending request.

Approval ends that vehicle's gate access. Other vehicles, household members, and the occupancy stay active. The resident sees the decision and which affected gates have received it.

**Data and API**

- Add migration `010_vehicle_retirement_requests.sql`, subject to the migration sequence at implementation time. Use a request/decision record for both resident requests and direct HOA actions, plus a table of affected controller targets.
- Bind the record to organization, property, occupancy, vehicle, and requester. Store reason, source, decision actor/time, required configuration version, and stable vehicle details needed for the history view.
- Use `pending`, `approved`, `rejected`, and `cancelled` request states. Gate delivery is separate from the decision state.
- Enforce one pending retirement request per vehicle, valid state transitions, and organization-scoped foreign keys. Add indexes for the HOA pending queue and resident history.
- Add resident submit/withdraw routes and HOA approve/decline/direct-retirement routes. Resolve scope from the authenticated principal; validate ownership, current occupancy, and permission on every action.
- Use the existing `vehicles.active` flag and credential statuses rather than introducing a second active-access state that can disagree with them.

**Approval transaction**

1. Lock the property, then the request and vehicle, following the existing lifecycle lock order.
2. Recheck active occupancy, vehicle, requester scope, and pending state.
3. Capture affected controllers from the current credential lane policy before closing assignments.
4. Revoke the vehicle's assigned credentials, close live assignments, and deactivate the vehicle.
5. Cancel pending correction and replacement requests for that vehicle and write their audit records.
6. Increment the organization's configuration version once, record controller targets and the decision, and commit atomically.

Move-out and member-removal paths must also cancel retirement requests that are no longer authorized. Correction/replacement approvals must refuse a vehicle that was retired while the request was pending. Competing approvals must serialize so the final state cannot contain a retired vehicle with an active assignment.

**Re-enrollment policy for this slice:** registering the same plate for a later household creates a new vehicle/history record and a new credential. The sold vehicle's revoked RFID value remains blocked. Preserve prior assignments and events instead of rewriting them to the new household.

**Acceptance:** retiring vehicle A blocks its tag and preserves its history; vehicle B in the same household continues to work. Repeated or concurrent approvals produce one retirement and one configuration change. An offline gate is shown as pending until it receives the change.

## 5. Block C: schedule a future move-out

**User flow and timing**

HOA staff select a household, enter an explicit date and time, and review the people, vehicles, and gates affected. Display the time zone clearly; use Asia/Manila for the current local workflow and store an unambiguous UTC instant. Residents see the scheduled cutoff and delivery state.

The HOA may change or cancel the schedule before it becomes due. At the cutoff, property access ends even if the API's background processor has not yet completed database housekeeping. An immediate move-out remains available through the existing flow and supersedes a pending schedule.

**Persistent schedule**

- Add migration `011_scheduled_move_outs.sql`, subject to sequence availability, with organization/property/occupancy linkage, cutoff, reason, issuer, state, revision, timestamps, and controller delivery targets for each published revision.
- Allow one active schedule per occupancy. Every create/change/cancel operation is audited and versions the configuration.
- Bind execution to the occupancy ID, so a late or retried job cannot end a later household in the same property.
- Keep the original approving actor and a distinct system execution actor. An approved schedule remains effective until cancelled or superseded; execution does not depend on the issuer still holding an interactive session.
- Freeze changes once the cutoff is due. Serialize cancellation, rescheduling, immediate move-out, enrollment, and invitation acceptance through the property lock.

**Publish expiry before the cutoff**

Compute each credential's effective `valid_until` as the earlier of its existing expiry and the occupancy's scheduled cutoff. Keep the credential's original expiry intact so cancellation cannot accidentally extend an unrelated validity limit.

Include the cutoff on every configuration response while the schedule is active. Apply it to vehicles enrolled and replacement credentials issued after scheduling. Refuse actions against a due occupancy, and avoid exporting a validity window whose end is at or before its start.

Reuse the existing protocol fields, configuration versioning, and edge validity check. Confirm expiry survives edge restart and is evaluated locally while the network is disconnected. Review the existing clock safeguards and test their limits; device clock suitability still needs commissioning evidence.

**Cloud access at the cutoff**

Use a shared effective-occupancy rule in session scope resolution, resident reads, invitations, enrollment, correction/replacement approvals, and other lifecycle writes. Checking only `ended_at IS NULL` would leave a due household accessible while processing is delayed. These paths must use the database cutoff as well.

Refactor the immediate move-out transaction into a shared occupancy-close operation with an explicit effective end time and operation identity. Scheduled processing records the cutoff as the historical end and records the actual processing time separately. Late uploaded events retain their original vehicle and occupancy attribution; an offline grant after the cutoff is evidence for investigation rather than permission to relabel history.

**Durable processing**

- Run a database-backed due-work processor at startup and on a bounded interval; an initial 15-second interval is proposed for the prototype.
- Select candidates, then lock the property and schedule in the established order and recheck state/revision before applying the shared close operation.
- Support multiple workers, retries, and process restart through transactions and idempotent execution. Do not depend on an in-memory timer for each household.
- Expose overdue/failed processing to HOA operations. Database and API scope checks enforce the due state while the processor recovers.
- Track schedule-delivery versions separately from the final closure version so the UI can explain both preparation and completion.

**Offline behavior that the UI must explain**

| Situation                                             | Expected behavior                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Gate received the schedule before losing internet     | Cached credential expires at the cutoff, subject to trusted device time and the existing cache-age policy             |
| Gate never received the schedule                      | No scheduled-cutoff guarantee; show pending delivery and require operational follow-up                                |
| Schedule changed or cancelled while a gate is offline | Gate may retain the earlier cutoff until it receives the new version; show the outstanding change                     |
| Cancellation arrives after the earlier cached cutoff  | Access resumes only after the gate applies the newer configuration, if the credential and occupancy remain valid      |
| Cloud processor is delayed                            | Cloud scope is closed at the due time; an informed edge still enforces its cached expiry; housekeeping retries safely |

**Acceptance:** schedule a cutoff, deliver it to the simulated edge, disconnect the network, restart the edge, and prove the tag is denied at the cutoff. Cancellation/rescheduling updates are versioned, visible, and cannot restore lost or revoked credentials.

## 6. Block D: make household records and pending work reachable

Replace dependence on capped snapshot arrays with dedicated scoped list endpoints. Keep the snapshot useful for summaries while loading full rosters and request histories through their own endpoints.

- Page household/property search, members for a selected property, and correction, replacement, retirement, and move-out records.
- Use a proposed default page size of 50 and maximum of 100. Provide a next cursor and an explicit end-of-list state.
- Use a stable ordering with an ID tie-breaker. Filter pending and resolved requests into separate views so decision changes do not destabilize one mixed-status cursor.
- Keep organization, property/occupancy, and resident filters in the database query. Validate cursors against the selected filters; a cursor must never expand authorization.
- Add search by household label, resident name where permitted, and plate. Include matching indexes and inspect PostgreSQL query plans with representative data.
- Make pending requests and gates awaiting delivery discoverable without paging through closed history. Show counts from scoped queries rather than the length of a capped array.
- Preserve filters and selection after a decision. Reset pagination when switching organizations or households and prevent an older response from replacing the newly selected scope.
- Handle empty, loading, failed, and retry states without suggesting that unseen rows do not exist.

**Acceptance:** seed more than 300 member records and more than 100 request records, then retrieve every intended record through API and UI pagination. Confirm records from another village or a former household are excluded, including when cursors are reused across scopes.

## 7. Block E: verification and application acceptance

Add focused regression coverage for the new state transitions and failure cases. Preserve the existing 33-test baseline and extend the PostgreSQL verifier to include the new migrations and lifecycle suite; report actual final counts rather than predicting them.

| Area               | Required scenarios                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vehicle retirement | Resident/HOA permissions, household isolation, repeated decisions, retirement against correction/replacement approval, and same-plate re-enrollment                |
| Scheduled move-out | Create/change/cancel, exact cutoff, original expiry preservation, worker outage/restart, two workers, immediate move-out race, and protection of a later occupancy |
| Scheduled scope    | Due household loses resident scope, stale invitations fail, and new enrollment or replacement cannot bypass the cutoff                                             |
| Edge expiry        | Just before/at/after cutoff, network loss, SQLite restart, cancellation delivery, stale configuration, and clock anomaly behavior                                  |
| Gate delivery      | Relevant controllers only, disconnected controller, required version acknowledgement, and distinct schedule/closure delivery states                                |
| Pagination         | Previous limits exceeded, stable cursor ordering, search/filter changes, and cross-organization cursor refusal                                                     |
| History            | Former household events remain attributed correctly, including events uploaded after retirement or move-out                                                        |
| Applications       | Management and resident phone/desktop flows, invitation role/MFA context, stale session, duplicate submission, and organization switching                          |

Run platform tests, PostgreSQL verification, TypeScript, affected production builds, formatting, diff checks, and protocol checks on the final changes. Run edge tests and the build when edge behavior or its acceptance fixtures change.

Exercise actual platform and edge processes together: enroll a controller, fetch scoped configuration, publish the lifecycle change, acknowledge it, authorize/deny locally, upload events, and replay delivery without duplicating events. Record the environment and transport used. A local simulator exchange establishes software behavior; deployed HTTPS and physical barrier acceptance remain separate evidence.

## 8. Expected files and review boundaries

| Repository                     | Expected changes                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform database              | New migrations for vehicle retirement and scheduled move-out; scoped constraints, indexes, and controller targets                                                           |
| Platform API                   | `apps/api/src/store.ts`, `identity.ts`, `routes.ts`, and a lifecycle processor/shared service where needed                                                                  |
| Platform permissions/contracts | Explicit resident request and HOA decision permissions; API DTOs/types; existing edge validity fields retained unless a concrete incompatibility requires contract revision |
| Platform UI                    | `packages/ui/src/portal.tsx`, styles, scoped lists, lifecycle dialogs, and delivery states shared by the existing apps                                                      |
| Platform verification          | Focused retirement/scheduling/pagination tests and `scripts/postgres-verify.mjs`                                                                                            |
| Edge                           | Validity, persistence, clock, and platform-exchange acceptance coverage; implementation changes only where those checks expose a gap                                        |
| Documentation                  | Implementation status, detailed roadmap, startup/worker instructions, and recorded acceptance results                                                                       |

Keep the platform and edge as independent repositories and releases. Review the current uncommitted work before organizing later changes into commits; preparation of this plan does not publish or deploy it.

## 9. Completion gate and following phase

O1.4 is complete when every block's acceptance evidence is recorded, pending work is reachable, sold vehicles lose only their own access, scheduled deadlines govern both cloud scope and informed edge caches, and historical attribution survives all transitions.

The following phase is O2: named guard shifts, incident notes, local authentication during internet loss, and audited assistance. Design the guard credential expiry/revocation policy and command audit path before implementation. Physical manual opening requires the confirmed installer-approved control and safety path.

Production readiness still depends on O3 deployment/recovery work and H1–H3 hardware evidence and commissioning. Report progress by these completed acceptance gates rather than converting implemented slices into a production percentage.

**First implementation deliverable:** vehicle-retirement migration, scoped API transitions, HOA/resident UI, affected-gate delivery status, and focused regression evidence.

## Implementation and acceptance record — 26 September 2026

The implementation deliverable is present in the platform working tree. Migrations `010`–`012` add
vehicle retirement, scheduled move-outs, and lifecycle pagination. The API enforces resident scope at
the scheduled cutoff, processes due schedules from the database with idempotent occupancy-bound
execution, and reports separate decision and gate-delivery state. The UI supports resident removal
requests, HOA approval/decline/direct retirement, scheduled move-out create/change/cancel, Manila-time
display, and searchable/paged household and lifecycle history. The household search row now refreshes
after schedule changes so its controls reflect the current schedule.

The move-out processor runs in the standard API process: one check at startup followed by a 15-second
interval. Database locking and state rechecks make concurrent instances and process restarts safe;
failed work is logged and retried on a later interval. Apply the tracked migrations before starting
the API against PostgreSQL; no separate worker command is required.

**Verified:** platform TypeScript checks, all three production builds, formatting, protocol manifest,
and **34 platform tests** passed, including two concurrent due-work processors closing an occupancy
once. The pinned Go 1.27.1 edge race suite, `go vet ./...`, simulator binary build, and `gofmt` check
passed. Browser acceptance in the isolated local demo confirmed a
resident retirement request and HOA approval, resident status, and schedule create/change/cancel
(revisions 1–3) with the household row updating immediately.

**Local process exchange:** the platform demo and Go edge simulator ran as separate local processes
with isolated platform and SQLite data. The edge reported cloud connected, one assigned demo lane,
configuration version 5, and zero queued events after syncing. The management view reported the demo
controller at version 5. A scan of the retired demo EPC was denied as `UNKNOWN_CREDENTIAL`, its event
uploaded, and the local event plus version 5 remained after an edge process restart. This used the
demo-only controller identity and simulated barrier; it does not establish real enrollment or a
physical-gate result.

**Still open for the completion gate:** `npm run verify:postgres` could not connect to
`127.0.0.1:5432` (`EPERM`), so migrations `010`–`012` need a PostgreSQL run. The available browser
viewport stayed at 1280×720, leaving the phone-width pass and remaining invitation/role and vehicle
correction approve/decline flows unverified in the browser. The demo exchange did not exercise a
real enrolled HTTPS controller, explicit same-event replay, or physical hardware. Record those
results before declaring O1.4 accepted; continue with O2 after the gate is satisfied.

## Audit remediation update — 26 September 2026

Due-time decisions now use the database wall clock after taking the property, occupancy, and schedule
locks. A due schedule cannot be rescheduled or cancelled; if staff complete it before the worker runs,
the recorded occupancy end remains the original cutoff. The worker records bounded retry state with
backoff, exposes failures in HOA history, lets later due schedules proceed, and drains in-flight work
on shutdown. Controllers enrolled during an active schedule are added to that schedule's delivery
targets.

The portal now remounts authenticated state when the principal or session scope changes, retains
loaded request history through polling, shows current household members ahead of former-member pages,
and accepts the UI's pending move-out filter. The PostgreSQL verifier uses unique per-run databases
and roles and cleans up only resources created in that run.

**Verified after remediation:** 36 platform tests passed and one PostgreSQL-only lock regression was
skipped in PGlite (37 total); PostgreSQL 17.11 passed all 19 checks with
migrations `001`–`013`, including the lifecycle regressions and backup/restore; platform TypeScript
checks and all three production builds passed. Phone-width browser acceptance, authenticated
invitation/role and correction-decision flows, real enrolled HTTPS delivery, same-event replay, and
physical-gate commissioning remain open before O1.4 acceptance.
