import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  HouseholdRelationship,
  MembershipRole,
  MembershipSummary,
  Principal,
  Role,
} from "@smartgate/permissions";
import {
  hashPassword,
  newRecoveryCodes,
  newToken,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  recoveryCodeHash,
  tokenHash,
  totpCode,
  verifyPassword,
  verifyTotp,
} from "./crypto.js";
import type { Store, Tx } from "./store.js";

const SESSION_HOURS = 8;
const CHALLENGE_MINUTES = 5;
const INVITATION_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_MINUTES = 15;
const MINIMUM_PASSWORD = 12;
const SUPPORT_MINUTES = 60;
const MAXIMUM_SUPPORT_MINUTES = 480;
const emailPattern = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}
export interface IssuedSession {
  token: string;
  expires_at: string;
  principal: Principal;
  memberships: MembershipSummary[];
  mfa_enabled: boolean;
  platform_role?: string;
}
export function assertPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MINIMUM_PASSWORD)
    throw new BadRequestException(`Password must be at least ${MINIMUM_PASSWORD} characters.`);
  if (password.length > 200) throw new BadRequestException("Password is too long.");
  return password;
}
export function assertEmail(email: unknown): string {
  if (typeof email !== "string" || !emailPattern.test(email.trim()) || email.trim().length > 160)
    throw new BadRequestException("A valid email address is required.");
  return email.trim().toLowerCase();
}
export function assertText(value: unknown, label: string, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new BadRequestException("Invalid " + label);
  return value.trim();
}
export function assertRelationship(value: unknown): HouseholdRelationship {
  if (value !== "owner" && value !== "tenant" && value !== "family_member" && value !== "occupant")
    throw new BadRequestException("Invalid household relationship.");
  return value;
}
/**
 * Identity owns users, memberships, sessions, invitations, and multi-factor state.
 * Every tenant decision comes from a membership row, never from caller-supplied input.
 */
export class Identity {
  constructor(private readonly store: Store) {}
  private now() {
    return new Date();
  }
  private sessionExpiry() {
    return `now() + interval '${SESSION_HOURS} hours'`;
  }
  async audit(
    q: Tx,
    input: {
      organizationId: string;
      actorId: string;
      action: string;
      entityId: string;
      detail: Record<string, unknown>;
      supportGrantId?: string | null;
    },
  ) {
    await q(
      "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        input.organizationId,
        input.actorId,
        input.action,
        input.entityId,
        JSON.stringify(input.detail),
        input.supportGrantId ?? null,
      ],
    );
  }
  async hasOperator() {
    return (
      (await this.store.query("SELECT id FROM users WHERE platform_role='platform_admin' LIMIT 1"))
        .rows.length > 0
    );
  }
  async createOperator(input: { email: string; name: string; password: string }) {
    const email = assertEmail(input.email);
    assertPassword(input.password);
    if (await this.hasOperator())
      throw new ConflictException("A platform administrator already exists.");
    const id = randomUUID();
    await this.store.transaction(async (q) => {
      await q(
        "INSERT INTO users(id,email,name,password_hash,status,platform_role) VALUES($1,$2,$3,$4,'active','platform_admin')",
        [id, email, assertText(input.name, "name"), await hashPassword(input.password)],
      );
    });
    return { user_id: id, email };
  }
  async createUser(input: {
    email: string;
    name: string;
    password: string;
    platformRole?: "platform_admin" | "platform_support" | null;
  }) {
    const email = assertEmail(input.email);
    assertPassword(input.password);
    const id = randomUUID();
    try {
      await this.store.query(
        "INSERT INTO users(id,email,name,password_hash,status,platform_role) VALUES($1,$2,$3,$4,'active',$5)",
        [
          id,
          email,
          assertText(input.name, "name"),
          await hashPassword(input.password),
          input.platformRole ?? null,
        ],
      );
    } catch (error: any) {
      if (error.code === "23505") throw new ConflictException("That email is already registered.");
      throw error;
    }
    return { user_id: id, email };
  }
  private async userByEmail(email: string) {
    return (
      await this.store.query(
        "SELECT id,email,name,password_hash,status,platform_role,mfa_secret,mfa_confirmed_at,mfa_last_step,locked_until FROM users WHERE email=$1",
        [email],
      )
    ).rows[0];
  }
  private async registerFailure(userId: string) {
    await this.store.query(
      `UPDATE users SET failed_attempts=failed_attempts+1,
         locked_until=CASE WHEN failed_attempts+1>=${MAX_FAILED_ATTEMPTS}
           THEN now()+interval '${LOCK_MINUTES} minutes' ELSE locked_until END,
         updated_at=now()
       WHERE id=$1`,
      [userId],
    );
  }
  async memberships(userId: string): Promise<MembershipSummary[]> {
    return (
      await this.store.query(
        `SELECT m.id AS membership_id, m.organization_id, o.name AS organization_name, m.role, m.status
         FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
         WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name`,
        [userId],
      )
    ).rows.map((row) => ({
      membershipId: row.membership_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      role: row.role as MembershipRole,
      status: row.status,
    }));
  }
  async login(email: unknown, password: unknown, meta: SessionMeta = {}) {
    const normalized = assertEmail(email);
    if (typeof password !== "string" || !password)
      throw new BadRequestException("A password is required.");
    const user = await this.userByEmail(normalized);
    if (user?.locked_until && new Date(user.locked_until) > this.now())
      throw new ForbiddenException("This account is temporarily locked. Try again later.");
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok) {
      if (user) await this.registerFailure(user.id);
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    if (user.status !== "active") throw new ForbiddenException("This account is not active.");
    await this.store.query(
      "UPDATE users SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1",
      [user.id],
    );
    const memberships = await this.memberships(user.id);
    if (user.mfa_secret && user.mfa_confirmed_at) {
      const challenge = newToken();
      await this.store.query(
        `INSERT INTO mfa_challenges(id,token_hash,user_id,membership_id,expires_at)
         VALUES($1,$2,$3,$4, now()+interval '${CHALLENGE_MINUTES} minutes')`,
        [
          randomUUID(),
          tokenHash(challenge),
          user.id,
          memberships.length === 1 ? memberships[0]!.membershipId : null,
        ],
      );
      return {
        mfa_required: true as const,
        challenge,
        expires_in_seconds: CHALLENGE_MINUTES * 60,
      };
    }
    // One membership scopes the session automatically. None or several means the session starts
    // unscoped and the client selects one, which keeps an unaffiliated sign-in possible.
    const scope = memberships.length === 1 ? memberships[0]! : null;
    return {
      mfa_required: false as const,
      ...(await this.issue(user.id, scope, false, meta)),
    };
  }
  private async issue(
    userId: string,
    scope: MembershipSummary | null,
    mfaSatisfied: boolean,
    meta: SessionMeta,
    support?: { grantId: string; organizationId: string },
  ): Promise<IssuedSession> {
    const token = newToken();
    const user = (
      await this.store.query("SELECT platform_role, mfa_confirmed_at FROM users WHERE id=$1", [
        userId,
      ])
    ).rows[0];
    // An account with MFA enabled may only hold sessions that passed verification, so this is
    // refused here rather than left for the next request to discover.
    if (user?.mfa_confirmed_at && !mfaSatisfied)
      throw new ForbiddenException(
        "Multi-factor verification is required before this session can be issued.",
      );
    const rows = (
      await this.store.query(
        `INSERT INTO sessions(id,token_hash,user_id,membership_id,support_grant_id,organization_id,mfa_satisfied,expires_at,user_agent,created_ip)
         VALUES($1,$2,$3,$4,$5,$6,$7,${this.sessionExpiry()},$8,$9) RETURNING expires_at`,
        [
          randomUUID(),
          tokenHash(token),
          userId,
          scope?.membershipId ?? null,
          support?.grantId ?? null,
          scope?.organizationId ?? support?.organizationId ?? null,
          mfaSatisfied,
          meta.userAgent?.slice(0, 200) ?? null,
          meta.ip?.slice(0, 60) ?? null,
        ],
      )
    ).rows[0];
    const issued: IssuedSession = {
      token,
      expires_at: new Date(rows.expires_at).toISOString(),
      principal: await this.resolve(token),
      memberships: await this.memberships(userId),
      mfa_enabled: !!(
        await this.store.query("SELECT mfa_confirmed_at FROM users WHERE id=$1", [userId])
      ).rows[0]?.mfa_confirmed_at,
    };
    // A platform session is reported explicitly so the client can tell it apart from a
    // membership-scoped one instead of guessing from the role name.
    if (user.platform_role) issued.platform_role = user.platform_role;
    return issued;
  }
  async resolve(token: string): Promise<Principal> {
    if (!token) throw new UnauthorizedException();
    const row = (
      await this.store.query(
        `SELECT s.id AS session_id, s.user_id, s.mfa_satisfied, s.expires_at, s.revoked_at,
                s.support_grant_id, s.organization_id AS session_organization_id,
                u.name, u.email, u.status AS user_status, u.platform_role, u.mfa_confirmed_at,
                m.id AS membership_id, m.organization_id AS membership_organization, m.role AS membership_role, m.status AS membership_status,
                g.expires_at AS grant_expires_at, g.revoked_at AS grant_revoked_at
         FROM sessions s
         JOIN users u ON u.id=s.user_id
         LEFT JOIN organization_memberships m ON m.id=s.membership_id
         LEFT JOIN support_access_grants g ON g.id=s.support_grant_id
         WHERE s.token_hash=$1`,
        [tokenHash(token)],
      )
    ).rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) <= this.now())
      throw new UnauthorizedException("Your session has ended. Sign in again.");
    if (row.user_status !== "active") throw new ForbiddenException("This account is not active.");
    // An account with MFA enabled may only be used by a session that passed verification. This is
    // checked on every request, so a session created by any other path cannot bypass it.
    if (row.mfa_confirmed_at && !row.mfa_satisfied)
      throw new ForbiddenException(
        "Multi-factor verification is required for this session. Sign in again.",
      );
    // A removed membership must stop working immediately, not only at session expiry.
    if (row.membership_id && row.membership_status !== "active")
      throw new ForbiddenException("Your access to this organization has been removed.");
    if (
      row.support_grant_id &&
      (row.grant_revoked_at || new Date(row.grant_expires_at) <= this.now())
    )
      throw new ForbiddenException("Support access to this organization has expired.");
    const organizationId = row.membership_organization ?? row.session_organization_id ?? null;
    const role: Role = row.membership_role ?? row.platform_role ?? "unaffiliated";
    const principal: Principal = {
      id: row.user_id,
      name: row.name,
      email: row.email,
      role,
      sessionId: row.session_id,
      organizationId,
      membershipId: row.membership_id ?? null,
      properties: [],
      sites: [],
      mfaSatisfied: !!row.mfa_satisfied,
    };
    if (row.support_grant_id) principal.supportGrantId = row.support_grant_id;
    if (row.membership_id && row.membership_role === "resident")
      principal.properties = (
        await this.store.query(
          `SELECT pm.property_id
           FROM property_memberships pm
           JOIN property_occupancies o
             ON o.organization_id=pm.organization_id AND o.id=pm.occupancy_id
           WHERE pm.membership_id=$1 AND pm.ended_at IS NULL AND o.ended_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_move_outs s
               WHERE s.organization_id=pm.organization_id AND s.occupancy_id=pm.occupancy_id
                AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
             )`,
          [row.membership_id],
        )
      ).rows.map((r) => r.property_id);
    if (row.membership_id && row.membership_role === "guard")
      principal.sites = (
        await this.store.query(
          "SELECT site_id FROM site_assignments WHERE membership_id=$1 AND revoked_at IS NULL",
          [row.membership_id],
        )
      ).rows.map((r) => r.site_id);
    await this.store.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1", [row.session_id]);
    return principal;
  }
  async logout(token: string) {
    await this.store.query(
      "UPDATE sessions SET revoked_at=now(), revoke_reason='signed out' WHERE token_hash=$1 AND revoked_at IS NULL",
      [tokenHash(token)],
    );
    return { ok: true };
  }
  async revokeSession(sessionId: string, reason: string) {
    await this.store.query(
      "UPDATE sessions SET revoked_at=now(), revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL",
      [sessionId, reason],
    );
  }
  async sessionsForUser(userId: string) {
    return (
      await this.store.query(
        `SELECT s.id, s.created_at, s.expires_at, s.revoked_at, s.mfa_satisfied, s.user_agent, s.organization_id,
                o.name AS organization_name
         FROM sessions s LEFT JOIN organizations o ON o.id=s.organization_id
         WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 50`,
        [userId],
      )
    ).rows;
  }
  /** Moves a session into one organization the user is genuinely entitled to act in. */
  async scopeSession(
    principal: Principal,
    organizationId: string,
    meta: SessionMeta = {},
  ): Promise<IssuedSession> {
    const membership = (
      await this.store.query(
        `SELECT m.id AS membership_id, m.organization_id, o.name AS organization_name, m.role, m.status
         FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
         WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active'`,
        [principal.id, organizationId],
      )
    ).rows[0];
    if (membership) {
      await this.revokeSession(principal.sessionId, "scope changed");
      return await this.issue(
        principal.id,
        {
          membershipId: membership.membership_id,
          organizationId: membership.organization_id,
          organizationName: membership.organization_name,
          role: membership.role,
          status: membership.status,
        },
        // Carry the verification state of the session being replaced. Enrolment state is not
        // evidence of verification, so it must never be substituted here.
        principal.mfaSatisfied,
        meta,
      );
    }
    const grant = (
      await this.store.query(
        `SELECT id, organization_id FROM support_access_grants
         WHERE user_id=$1 AND organization_id=$2 AND revoked_at IS NULL AND expires_at>now()
         ORDER BY created_at DESC LIMIT 1`,
        [principal.id, organizationId],
      )
    ).rows[0];
    if (grant) {
      await this.revokeSession(principal.sessionId, "support scope changed");
      return await this.issue(principal.id, null, principal.mfaSatisfied, meta, {
        grantId: grant.id,
        organizationId: grant.organization_id,
      });
    }
    throw new ForbiddenException("You do not have access to this organization.");
  }
  private async mfaState(userId: string) {
    const row = (
      await this.store.query(
        "SELECT mfa_secret, mfa_confirmed_at, mfa_last_step FROM users WHERE id=$1",
        [userId],
      )
    ).rows[0];
    return {
      secret: row?.mfa_secret ?? null,
      confirmed: !!row?.mfa_confirmed_at,
      lastStep: row?.mfa_last_step ?? null,
    };
  }
  async verifyMfa(challengeToken: unknown, code: unknown, meta: SessionMeta = {}) {
    if (typeof challengeToken !== "string" || !challengeToken)
      throw new BadRequestException("A challenge is required.");
    if (typeof code !== "string" || !code.trim())
      throw new BadRequestException("A verification code is required.");
    const submitted = code.trim();
    // The challenge row is locked for the whole claim, so two concurrent submissions serialize:
    // the second sees the challenge already consumed and is refused. Failure rolls back, leaving
    // the challenge usable for a corrected entry.
    const claimed = await this.store.transaction(async (q) => {
      const row = (
        await q(
          `SELECT c.id, c.user_id, c.membership_id, c.consumed_at, u.mfa_secret, u.mfa_last_step, u.status
           FROM mfa_challenges c JOIN users u ON u.id=c.user_id
           WHERE c.token_hash=$1 AND c.expires_at>now()
           FOR UPDATE OF c`,
          [tokenHash(challengeToken)],
        )
      ).rows[0];
      if (!row || row.consumed_at)
        throw new UnauthorizedException("That verification request has expired.");
      if (row.status !== "active") throw new ForbiddenException("This account is not active.");
      const step = verifyTotp(row.mfa_secret, submitted, row.mfa_last_step);
      if (step !== null) {
        // Claim the time step conditionally. A concurrent submission of the same code cannot
        // advance the counter twice, so only one of them can succeed.
        const advanced = (
          await q(
            "UPDATE users SET mfa_last_step=$2, updated_at=now() WHERE id=$1 AND (mfa_last_step IS NULL OR mfa_last_step<$2) RETURNING id",
            [row.user_id, step],
          )
        ).rows[0];
        if (!advanced) throw new UnauthorizedException("That code has already been used.");
      } else {
        // Claim the recovery code conditionally for the same reason.
        const used = (
          await q(
            "UPDATE mfa_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id",
            [row.user_id, recoveryCodeHash(normalizeRecoveryCode(submitted))],
          )
        ).rows[0];
        if (!used) throw new UnauthorizedException("That code is not valid.");
      }
      await q("UPDATE mfa_challenges SET consumed_at=now() WHERE id=$1", [row.id]);
      return row;
    });
    const memberships = await this.memberships(claimed.user_id);
    const scope = claimed.membership_id
      ? (memberships.find((m) => m.membershipId === claimed.membership_id) ?? null)
      : memberships.length === 1
        ? memberships[0]!
        : null;
    return {
      mfa_required: false as const,
      ...(await this.issue(claimed.user_id, scope, true, meta)),
    };
  }
  async beginMfaEnrollment(principal: Principal) {
    const state = await this.mfaState(principal.id);
    if (state.confirmed)
      throw new ConflictException("Multi-factor authentication is already enabled.");
    const secret = newTotpSecret();
    await this.store.query("UPDATE users SET mfa_secret=$2, updated_at=now() WHERE id=$1", [
      principal.id,
      secret,
    ]);
    return {
      secret,
      otpauth_url: otpauthUrl(secret, principal.email),
      current_code_hint: totpCode(secret),
    };
  }
  async confirmMfaEnrollment(principal: Principal, code: unknown) {
    if (typeof code !== "string") throw new BadRequestException("A verification code is required.");
    const state = await this.mfaState(principal.id);
    if (state.confirmed) throw new ConflictException("Multi-factor authentication is enabled.");
    if (!state.secret) throw new BadRequestException("Start enrolment before confirming it.");
    const accepted = verifyTotp(state.secret, code, null);
    if (accepted === null)
      throw new BadRequestException("That code does not match the enrolment secret.");
    const codes = newRecoveryCodes();
    await this.store.transaction(async (q) => {
      // Enrolment deliberately leaves mfa_last_step unset: the counter advances on the first
      // authentication, so a user is not locked out for 30 seconds after enrolling.
      await q(
        "UPDATE users SET mfa_confirmed_at=now(), mfa_last_step=NULL, updated_at=now() WHERE id=$1",
        [principal.id],
      );
      await q("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [principal.id]);
      for (const value of codes)
        await q("INSERT INTO mfa_recovery_codes(id,user_id,code_hash) VALUES($1,$2,$3)", [
          randomUUID(),
          principal.id,
          recoveryCodeHash(value),
        ]);
      // Only the session that proved possession of the secret keeps working. Every other session
      // must sign in again, so enabling MFA cannot leave an unverified session behind.
      await q(
        "UPDATE sessions SET revoked_at=now(), revoke_reason='MFA enrolled' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",
        [principal.id, principal.sessionId],
      );
      await q("UPDATE sessions SET mfa_satisfied=true WHERE id=$1", [principal.sessionId]);
    });
    return { enabled: true, recovery_codes: codes };
  }
  async changePassword(principal: Principal, current: unknown, next: unknown) {
    assertPassword(next);
    const row = (
      await this.store.query("SELECT password_hash FROM users WHERE id=$1", [principal.id])
    ).rows[0];
    if (!(await verifyPassword(String(current ?? ""), row?.password_hash ?? null)))
      throw new UnauthorizedException("Your current password is incorrect.");
    await this.store.transaction(async (q) => {
      await q("UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1", [
        principal.id,
        await hashPassword(next as string),
      ]);
      // A password change invalidates every other session.
      await q(
        "UPDATE sessions SET revoked_at=now(), revoke_reason='password changed' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",
        [principal.id, principal.sessionId],
      );
    });
    return { ok: true };
  }
  async createInvitation(
    principal: Principal,
    input: {
      email: unknown;
      role: unknown;
      siteId?: unknown;
      propertyId?: unknown;
      relationship?: unknown;
      organizationId?: unknown;
    },
  ) {
    const role = input.role;
    if (role !== "hoa_admin" && role !== "guard" && role !== "resident")
      throw new BadRequestException("Invalid invitation role.");
    const email = assertEmail(input.email);
    // A platform-scoped session onboards a customer and may only create that customer's first
    // administrator. It cannot invite guards or residents into a household.
    const platformScoped = !principal.membershipId;
    if (platformScoped && role !== "hoa_admin")
      throw new ForbiddenException(
        "Platform invitations are limited to the first HOA administrator.",
      );
    let organizationId: string;
    if (platformScoped) {
      organizationId = assertUuid(input.organizationId, "organization");
      const organization = (
        await this.store.query("SELECT id FROM organizations WHERE id=$1", [organizationId])
      ).rows[0];
      if (!organization) throw new NotFoundException("Organization not found.");
    } else {
      if (!principal.organizationId)
        throw new ForbiddenException("Select an organization before inviting members.");
      organizationId = principal.organizationId;
    }
    const siteId = role === "guard" ? assertUuid(input.siteId, "site") : null;
    const propertyId = role === "resident" ? assertUuid(input.propertyId, "property") : null;
    const relationship =
      role === "resident" && input.relationship !== undefined
        ? assertRelationship(input.relationship)
        : null;
    if (siteId) await this.assertInOrganization("sites", siteId, organizationId);
    if (propertyId) await this.assertInOrganization("properties", propertyId, organizationId);
    const token = newToken();
    const id = randomUUID();
    await this.store.transaction(async (q) => {
      if (propertyId) {
        const property = (
          await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
            propertyId,
            organizationId,
          ])
        ).rows[0];
        if (!property) throw new NotFoundException("That record is not in this organization.");
        const cutoffDue = (
          await q(
            `SELECT 1 FROM scheduled_move_outs
             WHERE organization_id=$1 AND property_id=$2 AND status='scheduled'
               AND effective_at<=clock_timestamp() LIMIT 1`,
            [organizationId, propertyId],
          )
        ).rows.length;
        if (cutoffDue) throw new ConflictException("This household's scheduled move-out is due.");
      }
      const residentRelationship = propertyId
        ? (relationship ??
          ((
            await q(
              `SELECT 1 FROM property_memberships pm
               JOIN property_occupancies o ON o.id=pm.occupancy_id
               WHERE pm.organization_id=$1 AND pm.property_id=$2 AND pm.ended_at IS NULL
                 AND o.ended_at IS NULL LIMIT 1`,
              [organizationId, propertyId],
            )
          ).rows.length
            ? "family_member"
            : "owner"))
        : null;
      await q(
        `INSERT INTO invitations(id,organization_id,email,role,token_hash,invited_by,site_id,property_id,resident_relationship,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, now()+interval '${INVITATION_DAYS} days')`,
        [
          id,
          organizationId,
          email,
          role,
          tokenHash(token),
          principal.id,
          siteId,
          propertyId,
          residentRelationship,
        ],
      );
      await this.audit(q, {
        organizationId,
        actorId: principal.id,
        action: "invitation.created",
        entityId: id,
        detail: {
          role,
          email,
          site_id: siteId,
          property_id: propertyId,
          relationship: residentRelationship,
        },
        supportGrantId: principal.supportGrantId,
      });
    });
    return {
      invitation_id: id,
      organization_id: organizationId,
      role,
      email,
      token,
      expires_in_days: INVITATION_DAYS,
      delivery: "operator_delivered",
    };
  }
  private async assertInOrganization(
    table: "sites" | "properties",
    id: string,
    organizationId: string,
  ) {
    const found = (
      await this.store.query(`SELECT id FROM ${table} WHERE id=$1 AND organization_id=$2`, [
        id,
        organizationId,
      ])
    ).rows[0];
    if (!found) throw new NotFoundException("That record is not in this organization.");
  }
  async listInvitations(principal: Principal) {
    if (!principal.organizationId) return [];
    return (
      await this.store.query(
        `SELECT id, email, role, site_id, property_id, resident_relationship,
                created_at, expires_at, accepted_at, revoked_at
         FROM invitations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [principal.organizationId],
      )
    ).rows;
  }
  async revokeInvitation(principal: Principal, id: string) {
    const row = (
      await this.store.query(
        "UPDATE invitations SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
        [id, principal.organizationId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("That invitation cannot be revoked.");
    await this.store.transaction((q) =>
      this.audit(q, {
        organizationId: principal.organizationId!,
        actorId: principal.id,
        action: "invitation.revoked",
        entityId: id,
        detail: {},
        supportGrantId: principal.supportGrantId,
      }),
    );
    return { ok: true };
  }
  async acceptInvitation(
    input: { token: unknown; name: unknown; password: unknown },
    actor?: Principal,
  ) {
    if (typeof input.token !== "string" || !input.token)
      throw new BadRequestException("An invitation token is required.");
    const invitationTokenHash = tokenHash(input.token);
    const invitation = (
      await this.store.query(
        `SELECT id, organization_id, email, role, site_id, property_id,resident_relationship FROM invitations
         WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()`,
        [invitationTokenHash],
      )
    ).rows[0];
    if (!invitation) throw new UnauthorizedException("That invitation is no longer valid.");
    const existing = (
      await this.store.query("SELECT id, status, name FROM users WHERE email=$1", [
        invitation.email,
      ])
    ).rows[0];
    let userId: string;
    let name: string;
    let passwordHash: string | null = null;
    if (existing && existing.status === "active") {
      // An invitation token on its own must never issue a session as somebody else. An account
      // that already exists has to authenticate first, whether or not it currently holds access,
      // so a forwarded or leaked token cannot be used to take over an identity.
      if (!actor || actor.id !== existing.id)
        throw new ForbiddenException(
          "An account already exists for this email. Sign in to accept the invitation.",
        );
      userId = existing.id;
      name = actor.name;
    } else {
      name = assertText(input.name, "name");
      passwordHash = await hashPassword(assertPassword(input.password));
      userId = existing?.id ?? randomUUID();
    }
    const membershipId = randomUUID();
    let acceptedMembershipId: string | null = null;
    await this.store.transaction(async (q) => {
      if (invitation.role === "resident" && invitation.property_id) {
        const property = (
          await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
            invitation.property_id,
            invitation.organization_id,
          ])
        ).rows[0];
        if (!property) throw new NotFoundException("Household not found.");
      }
      const validInvitation = (
        await q(
          `SELECT id FROM invitations
           WHERE id=$1 AND token_hash=$2 AND accepted_at IS NULL AND revoked_at IS NULL
             AND expires_at>now()
           FOR UPDATE`,
          [invitation.id, invitationTokenHash],
        )
      ).rows[0];
      if (!validInvitation) throw new UnauthorizedException("That invitation is no longer valid.");

      if (existing) {
        if (passwordHash)
          await q(
            "UPDATE users SET name=$2, password_hash=$3, status='active', failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1",
            [userId, name, passwordHash],
          );
      } else {
        await q(
          "INSERT INTO users(id,email,name,password_hash,status) VALUES($1,$2,$3,$4,'active')",
          [userId, invitation.email, name, passwordHash],
        );
      }
      const membership = (
        await q(
          `INSERT INTO organization_memberships(id,organization_id,user_id,role,status)
           VALUES($1,$2,$3,$4,'active')
           ON CONFLICT (organization_id,user_id,role) DO UPDATE SET status='active', revoked_at=NULL
           RETURNING id`,
          [membershipId, invitation.organization_id, userId, invitation.role],
        )
      ).rows[0];
      acceptedMembershipId = membership.id;
      if (invitation.role === "resident" && invitation.property_id) {
        const cutoffDue = (
          await q(
            `SELECT 1 FROM scheduled_move_outs
             WHERE organization_id=$1 AND property_id=$2 AND status='scheduled'
               AND effective_at<=clock_timestamp() LIMIT 1`,
            [invitation.organization_id, invitation.property_id],
          )
        ).rows.length;
        if (cutoffDue) throw new ConflictException("This household's scheduled move-out is due.");
        let occupancy = (
          await q(
            "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL FOR UPDATE",
            [invitation.organization_id, invitation.property_id],
          )
        ).rows[0];
        if (!occupancy) {
          occupancy = { id: randomUUID() };
          await q(
            "INSERT INTO property_occupancies(id,organization_id,property_id,started_at,resident_name_at_start,created_by) VALUES($1,$2,$3,now(),$4,$5)",
            [occupancy.id, invitation.organization_id, invitation.property_id, name, userId],
          );
          await q("UPDATE properties SET resident_name=$1 WHERE id=$2 AND organization_id=$3", [
            name,
            invitation.property_id,
            invitation.organization_id,
          ]);
        }
        // Each occupancy gets its own resident-membership period. Returning residents can be
        // re-invited without overwriting the prior period.
        const hasPrimary = (
          await q(
            `SELECT 1 FROM property_memberships
             WHERE organization_id=$1 AND occupancy_id=$2 AND ended_at IS NULL
               AND is_primary_contact LIMIT 1`,
            [invitation.organization_id, occupancy.id],
          )
        ).rows.length;
        const propertyMembership = (
          await q(
            `INSERT INTO property_memberships(id,organization_id,property_id,membership_id,occupancy_id,relationship,is_primary_contact)
             VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
            [
              randomUUID(),
              invitation.organization_id,
              invitation.property_id,
              membership.id,
              occupancy.id,
              invitation.resident_relationship ?? "owner",
              !hasPrimary,
            ],
          )
        ).rows[0];
        if (!propertyMembership) {
          const alreadyAssigned = (
            await q(
              `SELECT id FROM property_memberships
               WHERE organization_id=$1 AND property_id=$2 AND occupancy_id=$3
                 AND membership_id=$4 AND ended_at IS NULL LIMIT 1`,
              [invitation.organization_id, invitation.property_id, occupancy.id, membership.id],
            )
          ).rows[0];
          if (!alreadyAssigned)
            throw new ConflictException(
              "This resident already belongs to another household period.",
            );
        }
      }
      if (invitation.role === "guard" && invitation.site_id)
        await q(
          `INSERT INTO site_assignments(id,organization_id,site_id,membership_id)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (membership_id,site_id) DO UPDATE SET revoked_at=NULL`,
          [randomUUID(), invitation.organization_id, invitation.site_id, membership.id],
        );
      const acceptedInvitation = (
        await q(
          `UPDATE invitations SET accepted_at=now()
           WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()
           RETURNING id`,
          [invitation.id],
        )
      ).rows[0];
      if (!acceptedInvitation)
        throw new UnauthorizedException("That invitation is no longer valid.");
      await this.audit(q, {
        organizationId: invitation.organization_id,
        actorId: userId,
        action: "invitation.accepted",
        entityId: invitation.id,
        detail: { role: invitation.role },
      });
    });
    const memberships = await this.memberships(userId);
    const scope = memberships.find((m) => m.membershipId === acceptedMembershipId) ?? null;
    // An existing account keeps the verification state of the session that accepted the
    // invitation; a newly created account has no MFA yet.
    return {
      mfa_required: false as const,
      ...(await this.issue(userId, scope, actor?.mfaSatisfied ?? false, {})),
    };
  }
  async revokeMembership(principal: Principal, membershipId: string, reason: unknown) {
    const row = (
      await this.store.query(
        "SELECT id, user_id, role FROM organization_memberships WHERE id=$1 AND organization_id=$2",
        [membershipId, principal.organizationId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Membership not found.");
    if (row.id === principal.membershipId)
      throw new BadRequestException("You cannot revoke your own membership.");
    await this.store.transaction(async (q) => {
      const propertyMemberships = (
        await q(
          `SELECT property_id FROM property_memberships
           WHERE organization_id=$1 AND membership_id=$2 AND ended_at IS NULL
           ORDER BY property_id`,
          [principal.organizationId, row.id],
        )
      ).rows;
      const propertyIds = propertyMemberships.map((membership: any) => membership.property_id);
      if (propertyIds.length)
        await q(
          `SELECT id FROM properties
           WHERE organization_id=$1 AND id=ANY($2::uuid[])
           ORDER BY id FOR UPDATE`,
          [principal.organizationId, propertyIds],
        );
      const currentMembership = (
        await q(
          `SELECT id FROM organization_memberships
           WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE`,
          [row.id, principal.organizationId],
        )
      ).rows[0];
      if (!currentMembership) throw new NotFoundException("Active membership not found.");
      const primaryOccupancies = (
        await q(
          `SELECT occupancy_id FROM property_memberships
           WHERE organization_id=$1 AND membership_id=$2
             AND ended_at IS NULL AND is_primary_contact`,
          [principal.organizationId, row.id],
        )
      ).rows;
      await q(
        "UPDATE organization_memberships SET status='revoked', revoked_at=now() WHERE id=$1",
        [row.id],
      );
      // Revocation ends the household and station assignments too, so the scope is genuinely gone
      // rather than merely unreachable while the membership is revoked.
      await q(
        "UPDATE property_memberships SET ended_at=now(),is_primary_contact=false WHERE membership_id=$1 AND ended_at IS NULL",
        [row.id],
      );
      for (const occupancy of primaryOccupancies) {
        const next = (
          await q(
            `SELECT id FROM property_memberships
             WHERE organization_id=$1 AND occupancy_id=$2 AND ended_at IS NULL
             ORDER BY started_at,id LIMIT 1 FOR UPDATE`,
            [principal.organizationId, occupancy.occupancy_id],
          )
        ).rows[0];
        if (next)
          await q("UPDATE property_memberships SET is_primary_contact=true WHERE id=$1", [next.id]);
      }
      await q(
        "UPDATE site_assignments SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL",
        [row.id],
      );
      if (row.role === "resident") {
        const canceledVehicleChanges = (
          await q(
            `UPDATE vehicle_change_requests
             SET status='cancelled',decision_note='Resident membership revoked.',
                 decided_by=$1,resolved_at=now()
             WHERE organization_id=$2 AND requested_by=$3 AND status='pending'
             RETURNING id,vehicle_id,occupancy_id`,
            [principal.id, principal.organizationId, row.user_id],
          )
        ).rows;
        for (const request of canceledVehicleChanges)
          await q(
            "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.change_cancelled',$4,$5,$6)",
            [
              randomUUID(),
              principal.organizationId,
              principal.id,
              request.id,
              JSON.stringify({
                vehicle_id: request.vehicle_id,
                occupancy_id: request.occupancy_id,
                reason: "membership_revoked",
              }),
              principal.supportGrantId ?? null,
            ],
          );
      }
      // Revocation must remove access immediately, including from live sessions.
      await q(
        "UPDATE sessions SET revoked_at=now(), revoke_reason='membership revoked' WHERE membership_id=$1 AND revoked_at IS NULL",
        [row.id],
      );
      await this.audit(q, {
        organizationId: principal.organizationId!,
        actorId: principal.id,
        action: "membership.revoked",
        entityId: row.id,
        detail: { role: row.role, reason: String(reason ?? "").slice(0, 500) },
        supportGrantId: principal.supportGrantId,
      });
    });
    return { ok: true };
  }
  async endPropertyMember(principal: Principal, propertyId: string, propertyMemberId: string) {
    if (!principal.organizationId) throw new ForbiddenException("Select an organization first.");
    return this.store.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          propertyId,
          principal.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Household not found.");
      const member = (
        await q(
          `SELECT pm.id,pm.occupancy_id,pm.is_primary_contact,m.user_id,u.email
           FROM property_memberships pm
           JOIN organization_memberships m ON m.id=pm.membership_id
           JOIN users u ON u.id=m.user_id
           JOIN property_occupancies o ON o.id=pm.occupancy_id
           WHERE pm.id=$1 AND pm.organization_id=$2 AND pm.property_id=$3
             AND pm.ended_at IS NULL AND o.ended_at IS NULL AND m.status='active'
             AND m.role='resident'
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_move_outs s
               WHERE s.organization_id=pm.organization_id AND s.occupancy_id=pm.occupancy_id
                 AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
             )
           FOR UPDATE OF pm`,
          [propertyMemberId, principal.organizationId, propertyId],
        )
      ).rows[0];
      if (!member) throw new NotFoundException("Active household member not found.");
      await q(
        "UPDATE property_memberships SET ended_at=now(),is_primary_contact=false WHERE id=$1",
        [member.id],
      );
      const revoked = (
        await q(
          `UPDATE invitations SET revoked_at=now()
           WHERE organization_id=$1 AND property_id=$2 AND email=$3 AND role='resident'
             AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
          [principal.organizationId, propertyId, member.email],
        )
      ).rows;
      for (const invitation of revoked)
        await this.audit(q, {
          organizationId: principal.organizationId!,
          actorId: principal.id,
          action: "invitation.revoked",
          entityId: invitation.id,
          detail: { reason: "household_member_ended", property_id: propertyId },
          supportGrantId: principal.supportGrantId,
        });
      const canceledVehicleChanges = (
        await q(
          `UPDATE vehicle_change_requests
           SET status='cancelled',decision_note='Household member access ended.',
               decided_by=$1,resolved_at=now()
           WHERE organization_id=$2 AND occupancy_id=$3 AND requested_by=$4
             AND status='pending'
           RETURNING id,vehicle_id`,
          [principal.id, principal.organizationId, member.occupancy_id, member.user_id],
        )
      ).rows;
      for (const request of canceledVehicleChanges)
        await this.audit(q, {
          organizationId: principal.organizationId!,
          actorId: principal.id,
          action: "vehicle.change_cancelled",
          entityId: request.id,
          detail: {
            vehicle_id: request.vehicle_id,
            occupancy_id: member.occupancy_id,
            reason: "household_member_ended",
          },
          supportGrantId: principal.supportGrantId,
        });
      let nextPrimary: string | null = null;
      if (member.is_primary_contact) {
        const next = (
          await q(
            `SELECT id FROM property_memberships
             WHERE organization_id=$1 AND occupancy_id=$2 AND ended_at IS NULL
             ORDER BY started_at,id LIMIT 1 FOR UPDATE`,
            [principal.organizationId, member.occupancy_id],
          )
        ).rows[0];
        if (next) {
          await q("UPDATE property_memberships SET is_primary_contact=true WHERE id=$1", [next.id]);
          nextPrimary = next.id;
        }
      }
      await this.audit(q, {
        organizationId: principal.organizationId!,
        actorId: principal.id,
        action: "property.member_ended",
        entityId: member.id,
        detail: {
          property_id: propertyId,
          occupancy_id: member.occupancy_id,
          user_id: member.user_id,
          next_primary_id: nextPrimary,
        },
        supportGrantId: principal.supportGrantId,
      });
      return {
        ok: true,
        primary_member_id: nextPrimary,
        canceled_vehicle_change_count: canceledVehicleChanges.length,
      };
    });
  }
  async setPrimaryContact(principal: Principal, propertyId: string, propertyMemberId: string) {
    if (!principal.organizationId) throw new ForbiddenException("Select an organization first.");
    return this.store.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          propertyId,
          principal.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Household not found.");
      const member = (
        await q(
          `SELECT pm.id,pm.occupancy_id,pm.is_primary_contact
           FROM property_memberships pm
           JOIN property_occupancies o ON o.id=pm.occupancy_id
           WHERE pm.id=$1 AND pm.organization_id=$2 AND pm.property_id=$3
             AND pm.ended_at IS NULL AND o.ended_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_move_outs s
               WHERE s.organization_id=pm.organization_id AND s.occupancy_id=pm.occupancy_id
                 AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
             )
             AND pm.membership_id IN (
               SELECT id FROM organization_memberships
               WHERE organization_id=$2 AND status='active' AND role='resident'
             ) FOR UPDATE OF pm`,
          [propertyMemberId, principal.organizationId, propertyId],
        )
      ).rows[0];
      if (!member) throw new NotFoundException("Active household member not found.");
      if (member.is_primary_contact) return { ok: true };
      await q(
        `UPDATE property_memberships SET is_primary_contact=false
         WHERE organization_id=$1 AND occupancy_id=$2 AND ended_at IS NULL
           AND is_primary_contact`,
        [principal.organizationId, member.occupancy_id],
      );
      await q("UPDATE property_memberships SET is_primary_contact=true WHERE id=$1", [member.id]);
      await this.audit(q, {
        organizationId: principal.organizationId!,
        actorId: principal.id,
        action: "property.primary_contact_changed",
        entityId: member.id,
        detail: { property_id: propertyId, occupancy_id: member.occupancy_id },
        supportGrantId: principal.supportGrantId,
      });
      return { ok: true };
    });
  }
  async listMemberships(principal: Principal) {
    return (
      await this.store.query(
        `SELECT m.id, m.role, m.status, m.created_at, u.name, u.email
         FROM organization_memberships m JOIN users u ON u.id=m.user_id
         WHERE m.organization_id=$1 ORDER BY u.name`,
        [principal.organizationId],
      )
    ).rows;
  }
  async grantSupportAccess(
    principal: Principal,
    organizationId: string,
    reason: unknown,
    minutes: unknown,
  ) {
    const text = assertText(reason, "reason", 500);
    const requested = minutes === undefined ? SUPPORT_MINUTES : Number(minutes);
    if (!Number.isFinite(requested) || requested < 1 || requested > MAXIMUM_SUPPORT_MINUTES)
      throw new BadRequestException(
        `Support access must be between 1 and ${MAXIMUM_SUPPORT_MINUTES} minutes.`,
      );
    const organization = (
      await this.store.query("SELECT id FROM organizations WHERE id=$1", [organizationId])
    ).rows[0];
    if (!organization) throw new NotFoundException("Organization not found.");
    const id = randomUUID();
    await this.store.transaction(async (q) => {
      await q(
        `INSERT INTO support_access_grants(id,organization_id,user_id,reason,granted_by,expires_at)
         VALUES($1,$2,$3,$4,$5, now()+($6 || ' minutes')::interval)`,
        [id, organizationId, principal.id, text, principal.id, String(requested)],
      );
      await this.audit(q, {
        organizationId,
        actorId: principal.id,
        action: "support.access_granted",
        entityId: id,
        detail: { reason: text, minutes: requested },
        supportGrantId: id,
      });
    });
    return { support_grant_id: id, expires_in_minutes: requested };
  }
  async revokeSupportAccess(principal: Principal, grantId: string) {
    const row = (
      await this.store.query(
        "UPDATE support_access_grants SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING organization_id",
        [grantId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Support grant not found.");
    await this.store.transaction(async (q) => {
      await q(
        "UPDATE sessions SET revoked_at=now(), revoke_reason='support access revoked' WHERE support_grant_id=$1 AND revoked_at IS NULL",
        [grantId],
      );
      await this.audit(q, {
        organizationId: row.organization_id,
        actorId: principal.id,
        action: "support.access_revoked",
        entityId: grantId,
        detail: {},
        supportGrantId: grantId,
      });
    });
    return { ok: true };
  }
  async organizations() {
    return (
      await this.store.query(
        `SELECT o.id, o.name, o.config_version,
                (SELECT count(*)::int FROM organization_memberships m WHERE m.organization_id=o.id AND m.status='active') AS members,
                (SELECT count(*)::int FROM properties p WHERE p.organization_id=o.id) AS properties
         FROM organizations o ORDER BY o.name`,
      )
    ).rows;
  }
}
export function assertUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value))
    throw new BadRequestException("Invalid " + label + " id.");
  return value;
}
