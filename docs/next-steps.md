# SmartGate: next implementation plan

**Next milestone: real accounts and usable HOA, homeowner, and guard dashboards, with controller enrollment and Hikvision integration discovery running alongside the app work.**

The current prototype proves the simulated enrollment → local authorization → event synchronization flow. The next work should make that foundation usable by real organizations and establish the connection to the first actual gate.

This is a proposed sequence. Creating this plan does not start the implementation, publish repositories, purchase hardware, or deploy a system.

## App delivery tracks

The three applications already exist as local web prototypes in `smartgate-platform`. They should become usable throughout the next milestones, rather than appearing only after hardware integration. The homeowner portal is designed for a phone browser; a separately installed native app can follow if the pilot shows a need for push notifications or device-specific features.

| Application                                    | Current prototype                                                                  | First usable release                                                                                                              | Required before the resident pilot                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HOA and company administration (`control-web`) | Demonstration enrollment, credential status, access events, and configuration view | Real HOA administrator login; properties, residents, vehicles, and tag enrollment; suspend or replace a tag; scoped audit history | Gate and controller health, configuration acknowledgement, staff roles, incident review, and a company operations view across only its authorized customer sites       |
| Homeowner portal (`resident-web`)              | Demonstration vehicle, tag status, activity, and lost-tag report                   | Homeowner login tied to a household; own vehicles and tag status; lost-tag report and correction request                          | Clear request status, readable access history under HOA privacy policy, and mobile layout validated with participating households                                      |
| Security guard station (`guard-web`)           | Local simulator controls and recent decisions served by the edge                   | Named guard login and assigned gate; live read/decision feed; credential and vehicle lookup; clear denial reasons                 | Shift handover, incident notes, controlled manual assistance with a reason and audit trail, device/sync status, and an offline workflow verified on the actual station |

The platform controls user roles and records. The edge serves the guard station locally and continues local authorization during internet loss. A guard's manual action must have explicit authority and must respect the barrier's independent safety hardware. Visitor invitations and QR passes are a later release in Step 8.

## 1. Save the current baseline

**Repositories: both.**

- Review the initial source trees and create a baseline commit in each repository.
- Confirm the GitHub owner and repository visibility before creating or connecting remotes.
- Publish the two repositories when authorized and run their independent CI workflows.
- Record the matching draft protocol manifests and the current validation results.

**Complete when:** both repositories have a recoverable baseline, runtime data and credentials are excluded, and the first change can be reviewed independently. The current files are still uncommitted local work.

## 2. Build real authentication and tenant membership

**Repository: smartgate-platform. Start the first usable version of all three apps here.**

- Select a maintained authentication implementation that supports the required sessions, invitations, and MFA; document that choice before integration.
- Replace automatic demo profile selection with login, logout, session expiry/revocation, and administrator-issued invitations.
- Add real users and organization memberships. Derive organization scope from authenticated membership rather than the current fixed demonstration identity.
- Establish permission templates for platform administrator, HOA administrator, guard, and resident. Require MFA for privileged accounts before real deployments.
- Bind residents to their authorized property memberships and guards to their assigned sites. Keep platform support access explicit and audited.
- Separate seed/demo mode from the application used for real accounts. Configure the first account through an operator-controlled setup process.
- Replace the demo selectors in all three apps with role-specific login and account states. Give HOA staff an actual enrollment and suspension path, homeowners access to their own household and requests, and guards access only to their assigned station.

**Complete when:** two test HOAs can use the system simultaneously; a resident sees only authorized household data; guards cannot perform HOA administration; removing membership or revoking a session removes access. Demonstration shortcuts must not be reachable in the deployable configuration.

**Reviewable outputs:** an authentication decision, schema migration, login/invitation screens, working HOA/homeowner/guard journeys, server-side authorization, and focused session/tenant checks.

## 3. Verify the real PostgreSQL path

**Repository: smartgate-platform. Schedule this with the authentication work.**

- Run migrations and integration tests against a separate PostgreSQL service, including concurrent enrollment and duplicate event delivery.
- Introduce a tracked migration runner and separate application/migration database privileges.
- Establish a local backup-and-restore rehearsal before adding real resident information.

**Complete when:** the application passes its integration checks on PostgreSQL, and a restored database preserves memberships, configuration versions, and events. The current successful database checks used PGlite; they do not establish this deployment result.

## 4. Replace the demonstration device identity

**Repositories: platform and edge, with separately reviewed changes.**

- Add actual site, gate, lane, and controller enrollment records.
- Implement a short-lived, single-use enrollment exchange and unique controller credentials, scoped to one organization and installation.
- Remove the shared simulator bearer marker and hard-coded organization/site/device IDs from the operational path.
- Use authenticated, encrypted communication. Add MQTT notifications and scoped broker permissions while retaining explicit configuration versions and acknowledgements.
- Define credential renewal, device revocation, controller replacement, stale-configuration behavior, and recovery after interrupted synchronization.
- Publish the reviewed protocol bundle and pin it explicitly in the edge repository.
- Show enrollment, last contact, configuration version, and acknowledgement in the HOA/company dashboard. Show local controller and synchronization state at the guard station.

**Complete when:** a controller can enroll once, access only its assigned configuration, reconnect after an outage, and upload queued events without duplicates. Revoking its identity must prevent new cloud access; the separate effect on already-cached local permissions must be documented.

## 5. Confirm and build the first Hikvision transport

**Start the discovery now. Repository for the driver: smartgate-edge.**

Keep the selected target: DS-TRI900-1/A reader, DS-TME200 controller line, DS-TMG320 barrier series, and DS-TMG035 radar series. Exact regional SKUs and firmware remain open.

| Input needed                                                             | Decision it enables                            |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| Exact reader/controller model and firmware                               | Which local integration interface is available |
| Controller protocol/SDK documentation and sample reader events           | A real reader-event adapter                    |
| Confirmed EPC or Wiegand mapping                                         | Correct enrollment and identity comparison     |
| Command/acknowledgement documentation or selected isolated I/O interface | A real barrier-control adapter                 |
| Installer wiring and safety diagram                                      | Safe actuation, feedback, and failure behavior |
| Bench equipment or a supervised test lane                                | Evidence that the integration works physically |

Resolve whether the controller can leave authorization to SmartGate without independently granting access from a conflicting allowlist. General Hikvision ISAPI support is not sufficient evidence for the exact selected controller.

Once the interface is confirmed, connect the existing reader, barrier, and detector abstractions to it. Extend the draft protocol deliberately to represent physical command outcomes and independently observed passage. Keep HikCentral optional.

Connect real reader events and barrier feedback to the guard station. The operator must see the current lane state and any failed command; a manual opening workflow needs a named, authorized guard, a recorded reason, and installer-approved safety behavior.

**Complete when:** a real tag produces a local decision; a permitted test vehicle receives an observed barrier response; passage is recorded only when independently detected; denied credentials do not produce an opening request. Installer-supervised fault and manual-operation checks are part of this milestone.

Adapter development can begin as soon as the documents and equipment are available. The dashboards and adapter can advance together.

## 6. Finish the app workflows for the pilot

**Repository: platform, with edge changes for local guard operation.**

- Support multiple vehicles per existing property, dated ownership/tenancy, move-outs, vehicle sales, and tag replacement without destroying history.
- Add enrollment review, lost-tag replacement, and a clear view of which gates have applied each change to the HOA dashboard. Give company operators a scoped fleet view for support and maintenance without broad access to household data.
- Implement named guard sessions, shift handover, authorized overrides with reasons, and incident records.
- Define offline guard authentication and revocation limits. Validate local HTTPS and cold-start behavior on the actual guard device.
- Let homeowners view vehicles, check tag status, request corrections, report loss, and track each request to resolution. Apply explicit permissions to movement history and notifications.

**Complete when:** HOA staff, homeowners, and guards can handle a resident in a different car, a failed tag, a move-out, and a network outage using their respective apps and documented workflows. Historical activity remains attributed to the correct vehicle and occupancy period.

## 7. Prepare one supervised resident pilot

**Repositories: both; installer and HOA participation required.**

- Complete physical safety commissioning, including detection faults, nearby-lane reads, stalled movement, manual release, emergency access, and the selected power-loss behavior.
- Rehearse controller replacement, queued-event recovery, database restoration, and a signed software update with rollback.
- Establish monitoring, escalation contacts, spare equipment, support responsibilities, privacy notices, and data retention.
- Cost the installation and recurring support. Agree on the pilot's operating hours, participating households, success measures, and manual fallback.
- Measure read success, manual assistance, decision latency, queue delay, and synchronization age against an agreed baseline.

**Complete when:** the software, installer, and HOA acceptance checks pass and the site has an approved operating procedure. A successful simulation or Linux build cannot substitute for physical commissioning.

A limited resident RFID pilot can precede visitor QR if the HOA has an agreed existing visitor procedure. Resident enrollment should expand only after the initial supervised group produces acceptable results.

## 8. Add the visitor experience and expand gradually

- Add resident-issued invitations with validity windows and clear entry, exit, and re-entry rules.
- Initially bind a one-time entry pass to one gate authority with durable redemption state. Define the behavior during disconnection, cancellation, and controller replacement.
- Add the necessary privacy controls, resident notifications, and visitor assistance workflow.
- Extend the pilot after visitor replay and outage cases pass.

Native mobile apps, cameras, ANPR, additional hardware vendors, automated billing, and a separate infrastructure repository remain later work driven by demonstrated demand.

## Recommended starting order

**Baseline → real login and first usable version of all three apps, alongside PostgreSQL verification → enrolled device identity and live device views → real Hikvision gate and guard workflow → finish pilot app workflows → supervised pilot → visitor expansion.**

The immediate software deliverable is Step 2. In parallel, the most useful hardware deliverable is the exact controller manual/SDK and a confirmed test installation from Step 5. A reliable calendar estimate for physical integration should follow those inputs.
