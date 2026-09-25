# SmartGate implementation status

Updated 25 September 2026.

**The first runnable software milestone is implemented in two independent local Git repositories. This is a development prototype, not a completed V1 or a commissioned gate system.**

## Open the running previews

- [Village management](http://127.0.0.1:3000)
- [Guard web app](http://127.0.0.1:3001)
- [Resident portal](http://127.0.0.1:3002)
- [Guard app served by the edge](http://127.0.0.1:4200)

See the platform and edge READMEs for restart commands if these local processes have stopped.

## Delivered

| Area             | Implemented                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Repositories     | Separate smartgate-platform and smartgate-edge Git roots and CI workflows; no parent repository or shared source import |
| Platform         | NestJS/Fastify API; three Next.js apps; shared UI, permissions, and protocol package                                    |
| Persistence      | PostgreSQL schema with PGlite for local development; independent SQLite edge storage                                    |
| Enrollment       | Fictional village seed; property/contact, vehicle, and credential enrollment; duplicate protection; audit records       |
| Access lifecycle | Suspension, reactivation, resident lost-tag reporting, configuration versioning and edge acknowledgement                |
| Local controller | Credential decisions, persistent cooldown, command reservation, durable event queue, HTTP synchronization               |
| Guard            | Local status, simulated arrivals, recent activity, and static assets served from the edge                               |
| Protocol         | Draft JSON schemas and identical pinned manifests in both repositories                                                  |
| Hikvision        | Interfaces, conventional Wiegand decoder, I/O adapter boundary, uncommissioned-control rejection                        |
| UI               | Responsive village, guard, and resident interfaces with explicit development mode                                       |

## Validation observed

- Platform API suite: 7 tests passed. Includes authentication boundaries, cross-tenant reads/writes, atomic enrollment, role restrictions, lost-tag scope, and 20 concurrent deliveries storing one event.
- All three Next.js production builds and API compilation passed.
- TypeScript checks across workspaces passed.
- Formatting checks passed and are included in platform CI.
- Protocol manifest checks passed.
- Go race-enabled tests and go vet passed.
- Native macOS ARM64 and Linux ARM64 controller builds passed.
- Browser enrollment created a sample Honda City with tag E2000017221101441890DCBA and plate SGT 2026. The UI displayed pending controller acknowledgement before synchronization.
- Guard browser presented that tag and displayed access granted with a simulated opening, while explicitly leaving passage unconfirmed.
- With the API stopped, the guard app cold-loaded from the edge and recorded a new offline grant.
- With the API still stopped, the edge restarted and retained configuration version 2 and the queued event.
- After the API restarted, the pending queue became zero. Two local event IDs matched exactly two cloud records, including the offline event; both complied with the platform JSON schema.
- Resident portal was inspected at 390 × 844; document width matched the viewport, and only the seeded resident's vehicle was visible.

- Browser suspension: the in-app confirmation changed the sample credential to suspended; the controller acknowledged configuration version 3 and denied the same tag without requesting an opening.

## Important remaining work

Real login/account management, privileged MFA, live device certificates/provisioning, MQTT/TLS, company administration, full occupancy and reassignment workflows, production guard authentication/PWA deployment, visitor QR, notifications, signed updates, restore drills, and physical Hikvision transport/commissioning remain open.

The external PostgreSQL server and Docker Compose path are supplied but were not run. Cloud/API development checks used embedded PostgreSQL. Linux cross-compilation does not prove execution on a physical controller.

The supplied Hikvision model choices are incorporated, but no real device protocol, physical wiring, radio variant, or installed safety system has been validated. See [Hikvision pilot requirements](hikvision-pilot.md).

## Git and environment

Both repositories are new local repositories on main. No remote, commit, push, GitHub repository creation, deployment, or hardware purchase was performed. Runtime data, node_modules, binaries, and the project-local Go toolchain are ignored by Git.

The next substantial milestone is authenticated tenant/device provisioning alongside the confirmed Hikvision transport. Physical gate commissioning is a separate acceptance gate.
