# Authentication decision

This document records the authentication implementation selected for Step 2 of the implementation plan, why it was selected, and the limits that remain open. It is written before the integration so the choice can be reviewed on its own.

## Decision

**First-party identity in the platform API, on PostgreSQL, using the built-in Node.js `crypto` primitives.**

The platform API owns users, credentials, sessions, invitations, and multi-factor state. PostgreSQL is the single source of truth. There is no external identity service and no third-party authentication runtime dependency.

## Components as implemented

| Concern             | Implementation                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage    | `scrypt` (N=16384, r=8, p=1, 64-byte derived key, 16-byte per-user salt) with a versioned `scrypt$N$r$p$salt$key` encoding                                                   |
| Password compare    | `crypto.timingSafeEqual`, with a dummy derivation performed when the account does not exist so response timing does not confirm account presence                             |
| Session token       | 256-bit `randomBytes` value returned once; only its SHA-256 hash is stored                                                                                                   |
| Session lifetime    | Absolute expiry plus explicit revocation; membership-bound; carries an MFA-satisfied flag                                                                                    |
| MFA enforcement     | Checked on every request: a session belonging to an account with MFA enabled is refused unless that session passed verification                                              |
| MFA claims          | The challenge row is locked, and the time step and recovery code are each claimed with a conditional update, so concurrent submissions cannot both succeed                   |
| Invitations         | 256-bit token, SHA-256 hashed at rest, single-use, expiring, bound to one organization, role, and optional property or site; an existing account must be signed in to accept |
| Invitation delivery | The three apps have an invitation acceptance screen, and an invitation link carries its code, so a new member never needs the API                                            |
| Multi-factor        | RFC 6238 TOTP (SHA-1, 6 digits, 30-second step, ±1 step drift) with single-use step tracking, plus hashed one-time recovery codes                                            |
| Authorization       | Permission templates resolved from an authenticated organization membership; never from a request body                                                                       |
| Platform support    | Explicit, reason-bearing, time-limited, and audited support sessions rather than standing cross-tenant access                                                                |

## Two properties worth stating explicitly

**Enabling MFA cannot leave a bypassable session behind.** The flag is re-checked on every request
rather than only at sign-in, and a scope change or invitation acceptance carries the verification
state of the session it replaces. Enrolment state alone is never treated as evidence of
verification, and when MFA is enabled every other session of that account is revoked.

Relatedly, `platform.fleet.read` is a platform-only permission, so a customer administrator holding
`organization.read` for its own village cannot enumerate other customers.

**An existing account must authenticate before it can be claimed.** An account that already exists
can never be entered from an invitation token alone, whether or not it currently holds access: a
forwarded or leaked token would otherwise issue a session as that person without their password. An
account with no organization membership can still sign in, so a withdrawn member can prove who they
are and then accept a new invitation; such a session is `unaffiliated`, is granted no permissions,
and has no organization scope at all.

## Why not a managed identity provider

- **The deployment boundary forbids it today.** The platform is a local prototype that must run without Docker or an external service, using embedded PostgreSQL (PGlite) for local development. A hosted or containerized identity service would be a new hard dependency before the first pilot.
- **The required feature set is small and specific.** Sessions, invitations, and MFA are the entire Step 2 requirement. Federation, social login, and delegated compliance are not.
- **The primitives are standard and auditable.** `scrypt`, HMAC, SHA-256, and constant-time comparison are in the Node.js standard library. No bespoke cryptography is introduced.
- **Reversibility is deliberate.** `users`, `credentials`, and `sessions` are plain tables. Adopting OIDC later is an additive change to the login boundary, not a data migration away from a proprietary format.

**Revisit this decision when** the platform needs single sign-on for staff, an external HOA wants to federate with its own directory, or a customer contract requires a certified identity provider. At that point an OIDC provider should replace the login endpoints while the membership and permission model below is retained.

## Authorization model

Organization scope is derived from an authenticated membership row, never from the client.

```text
user
 ├── platform role (platform_admin | platform_support)   → platform-level, sees organization metadata only
 └── organization_memberships (hoa_admin | guard | resident)
      ├── property_memberships  → which households a resident may see
      └── site_assignments      → which sites a guard may operate
```

Permission templates:

| Role               | Template purpose                                                    |
| ------------------ | ------------------------------------------------------------------- |
| `platform_admin`   | Customer and device fleet metadata; no household data by default    |
| `platform_support` | Read-only fleet view and audited, time-limited support access       |
| `hoa_admin`        | Enrollment, credential lifecycle, memberships, invitations, audit   |
| `guard`            | Read access for assigned sites; no administration                   |
| `resident`         | Own property's vehicles, own access history, own lost-tag reporting |

A platform administrator does **not** receive household data implicitly. Reading a customer organization requires an explicit support grant with a recorded reason and an expiry, and the grant is written to `audit_events`.

## Demonstration mode is separated

`SMARTGATE_DEMO=true` seeds the fictional village and enables `POST /demo/session`. Without it the process runs in **real mode**: the demo endpoint does not exist, no fictional data is seeded, and the first account is created by an operator either through `POST /setup/operator` (requiring a one-time token from `SMARTGATE_SETUP_TOKEN`, and only while no platform administrator exists) or through `npm run setup:operator`.

`NODE_ENV=production` refuses demonstration mode outright.

## Open limits

These are known and are owned by later steps or the hardening gate. They are listed so the current state is not mistaken for production-ready identity.

1. **No password reset by email.** Recovery is operator-assisted. Outbound email is not configured.
2. **No federation.** No OIDC, SAML, or social login.
3. **TOTP secrets are not envelope-encrypted.** The secret is stored in the database. Key management and encryption at rest belong to the hardening gate.
4. **Bearer tokens in memory, not httpOnly cookies.** The three web apps are static exports served from separate loopback ports, so a same-origin cookie deployment with CSRF protection is a follow-on rather than a drop-in change.
5. **No login rate limiting beyond per-account failed-attempt lockout.** Network-level throttling is part of the hardening gate.
6. **Device identity is a separate trust boundary.** Real edge controllers claim a single-use enrollment grant and then authenticate with a unique per-controller credential; the local simulator marker is limited to explicit demo mode. Hardware-backed keys and production credential provisioning remain open.
7. **Local guard authentication is unchanged.** Offline guard sign-in at the station is Step 6.
