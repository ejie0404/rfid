import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { validateProtocol, type AccessEvent } from "@smartgate/contracts";
import { canAct } from "@smartgate/permissions";
import { Identity, assertUuid } from "./identity.js";
import { Sessions, bearer, effectiveRole, sessionMeta } from "./session.js";
import { Store } from "./store.js";

function stringField(value: unknown, label: string, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new BadRequestException("Invalid " + label);
  return value.trim();
}

@Controller()
export class HealthController {
  constructor(
    @Inject(Store) private readonly store: Store,
    @Inject(Identity) private readonly identity: Identity,
  ) {}
  @Get("health") async health() {
    return {
      status: "ok",
      protocol: 1,
      demo: this.store.isDemo,
      operator_configured: await this.identity.hasOperator(),
    };
  }
  @Get("setup/status") async setupStatus() {
    return {
      demo: this.store.isDemo,
      operator_configured: await this.identity.hasOperator(),
      setup_token_required: !this.store.isDemo,
    };
  }
  /**
   * The operator-controlled first account. It requires the one-time token from the environment
   * and is refused once a platform administrator exists, so it cannot be replayed later.
   */
  @Post("setup/operator") async setupOperator(@Body() body: any) {
    const expected = process.env.SMARTGATE_SETUP_TOKEN || "";
    if (this.store.isDemo)
      throw new ForbiddenException("Demonstration mode provisions its own accounts.");
    if (!expected || body?.token !== expected)
      throw new UnauthorizedException("A valid one-time setup token is required.");
    return this.identity.createOperator({
      email: body?.email,
      name: body?.name,
      password: body?.password,
    });
  }
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(Identity) private readonly identity: Identity,
    @Inject(Sessions) private readonly sessions: Sessions,
  ) {}
  @Post("login") login(@Req() req: FastifyRequest, @Body() body: any) {
    return this.identity.login(body?.email, body?.password, sessionMeta(req));
  }
  @Post("mfa/verify") verifyMfa(@Req() req: FastifyRequest, @Body() body: any) {
    return this.identity.verifyMfa(body?.challenge, body?.code, sessionMeta(req));
  }
  @Get("session") async session(@Req() req: FastifyRequest) {
    const principal = await this.sessions.require(req);
    return { principal, memberships: await this.identity.memberships(principal.id) };
  }
  @Post("logout") async logout(@Req() req: FastifyRequest) {
    return this.identity.logout(bearer(req));
  }
  @Post("scope") scope(@Req() req: FastifyRequest, @Body() body: any) {
    return this.sessions
      .require(req)
      .then((principal) =>
        this.identity.scopeSession(
          principal,
          assertUuid(body?.organization_id, "organization"),
          sessionMeta(req),
        ),
      );
  }
  @Post("password") async changePassword(@Req() req: FastifyRequest, @Body() body: any) {
    const principal = await this.sessions.require(req);
    return this.identity.changePassword(principal, body?.current_password, body?.new_password);
  }
  @Post("mfa/enroll") async enrollMfa(@Req() req: FastifyRequest) {
    return this.identity.beginMfaEnrollment(await this.sessions.require(req));
  }
  @Post("mfa/confirm") async confirmMfa(@Req() req: FastifyRequest, @Body() body: any) {
    return this.identity.confirmMfaEnrollment(await this.sessions.require(req), body?.code);
  }
  @Get("sessions") async listSessions(@Req() req: FastifyRequest) {
    const principal = await this.sessions.require(req);
    return this.identity.sessionsForUser(principal.id);
  }
  @Post("sessions/:id/revoke") async revokeSession(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const principal = await this.sessions.require(req);
    const owned = (await this.identity.sessionsForUser(principal.id)).some(
      (row) => row.id === assertUuid(id, "session"),
    );
    if (!owned) throw new ForbiddenException("That session does not belong to you.");
    await this.identity.revokeSession(id, "revoked by account holder");
    return { ok: true };
  }
  @Post("invitations/accept") async acceptInvitation(
    @Req() req: FastifyRequest,
    @Body() body: any,
  ) {
    return this.identity.acceptInvitation(
      { token: body?.token, name: body?.name, password: body?.password },
      await this.sessions.optional(req),
    );
  }
}

@Controller()
export class DomainController {
  constructor(
    @Inject(Store) private readonly store: Store,
    @Inject(Identity) private readonly identity: Identity,
    @Inject(Sessions) private readonly sessions: Sessions,
  ) {}
  @Get("snapshot") async snapshot(@Req() req: FastifyRequest) {
    return this.store.snapshot(await this.sessions.requireOrganization(req, "vehicle.read"));
  }
  @Post("enrollments") async enroll(@Req() req: FastifyRequest, @Body() body: any) {
    const principal = await this.sessions.requireOrganization(req, "enrollment.write");
    const format = body?.format ?? "epc";
    if (!["epc", "wiegand26", "wiegand34"].includes(format))
      throw new BadRequestException("Invalid credential format.");
    const value = stringField(body?.value, "credential", 64).toUpperCase();
    if (
      !/^[0-9A-F]+$/.test(value) ||
      (format === "epc" && value.length % 2 !== 0) ||
      (format === "wiegand26" && value.length !== 6) ||
      (format === "wiegand34" && value.length !== 8)
    )
      throw new BadRequestException("Credential must match the selected format.");
    const propertyId = body?.property_id ? assertUuid(body.property_id, "property") : undefined;
    return this.store.enroll(principal, {
      propertyId,
      resident: propertyId ? undefined : stringField(body?.resident, "resident"),
      property: propertyId ? undefined : stringField(body?.property, "property"),
      plate: stringField(body?.plate, "plate", 20).toUpperCase(),
      make: stringField(body?.make, "make", 60),
      color: stringField(body?.color, "color", 40),
      format,
      value,
      // Optional gate policy. Omitting it authorizes the credential at every lane in the village.
      laneIds: Array.isArray(body?.lane_ids)
        ? body.lane_ids.map((lane: unknown) => assertUuid(lane, "lane"))
        : undefined,
    });
  }
  @Post("credentials/:id/status") async status(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req);
    assertUuid(id, "credential");
    if (!["active", "suspended", "lost", "revoked"].includes(body?.status))
      throw new BadRequestException("Invalid status.");
    const role = effectiveRole(principal);
    // Reporting your own tag lost is a separate permission from managing credentials.
    const permission = body.status === "lost" ? "credential.report_lost" : "credential.manage";
    if (!canAct(principal, permission)) throw new ForbiddenException();
    await this.store.status(principal, id, body.status);
    return { ok: true, delivery: "pending_edge_acknowledgement", acted_as: role };
  }
  @Get("invitations") async invitations(@Req() req: FastifyRequest) {
    return this.identity.listInvitations(
      await this.sessions.requireOrganization(req, "invitation.manage"),
    );
  }
  @Post("invitations") async invite(@Req() req: FastifyRequest, @Body() body: any) {
    const principal = await this.sessions.require(req, "invitation.manage");
    return this.identity.createInvitation(principal, {
      email: body?.email,
      role: body?.role,
      siteId: body?.site_id,
      propertyId: body?.property_id,
      organizationId: body?.organization_id,
    });
  }
  @Post("invitations/:id/revoke") async revokeInvitation(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.identity.revokeInvitation(
      await this.sessions.requireOrganization(req, "invitation.manage"),
      assertUuid(id, "invitation"),
    );
  }
  @Get("memberships") async memberships(@Req() req: FastifyRequest) {
    return this.identity.listMemberships(
      await this.sessions.requireOrganization(req, "membership.manage"),
    );
  }
  @Post("sites") async createSite(@Req() req: FastifyRequest, @Body() body: any) {
    const principal = await this.sessions.requireOrganization(req, "site.manage");
    return this.store.createSite(principal, {
      name: stringField(body?.name, "site name", 80),
      code: stringField(body?.code, "site code", 16),
    });
  }
  @Post("sites/:id/lanes") async createLane(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "site.manage");
    const direction = body?.direction;
    if (!["entry", "exit", "bidirectional"].includes(direction))
      throw new BadRequestException("Invalid lane direction.");
    return this.store.createLane(principal, {
      siteId: assertUuid(id, "site"),
      name: stringField(body?.name, "lane name", 80),
      direction,
    });
  }
  @Post("memberships/:id/revoke") async revokeMembership(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.identity.revokeMembership(
      await this.sessions.requireOrganization(req, "membership.manage"),
      assertUuid(id, "membership"),
      body?.reason,
    );
  }
  @Get("controllers") async controllers(@Req() req: FastifyRequest) {
    return this.store.listControllers(await this.sessions.requireOrganization(req, "device.read"));
  }
  @Get("controllers/enrollment-grants") async controllerGrants(@Req() req: FastifyRequest) {
    return this.store.listControllerGrants(
      await this.sessions.requireOrganization(req, "device.manage"),
    );
  }
  @Post("controllers/enrollment-grants") async createControllerGrant(
    @Req() req: FastifyRequest,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "device.manage");
    if (!Array.isArray(body?.lane_ids) || body.lane_ids.length === 0 || body.lane_ids.length > 64)
      throw new BadRequestException("Choose between one and 64 lanes.");
    const laneIds = body.lane_ids.map((laneId: unknown) => assertUuid(laneId, "lane"));
    if (new Set(laneIds).size !== laneIds.length)
      throw new BadRequestException("A lane may only be selected once.");
    const expiresInMinutes = body?.expires_in_minutes ?? 15;
    if (!Number.isInteger(expiresInMinutes))
      throw new BadRequestException("Enrollment expiry must be a whole number of minutes.");
    return this.store.createControllerGrant(principal, {
      name: stringField(body?.name, "controller name", 80),
      siteId: assertUuid(body?.site_id, "site"),
      laneIds,
      expiresInMinutes,
    });
  }
  @Post("controllers/enrollment-grants/:id/revoke") async revokeControllerGrant(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.store.revokeControllerGrant(
      await this.sessions.requireOrganization(req, "device.manage"),
      assertUuid(id, "controller enrollment grant"),
    );
  }
  @Post("controllers/:id/revoke") async revokeController(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.store.revokeController(
      await this.sessions.requireOrganization(req, "device.manage"),
      assertUuid(id, "controller"),
      typeof body?.reason === "string" ? body.reason.slice(0, 240) : "",
    );
  }
  @Post("controllers/:id/rotate-credential") async rotateControllerCredential(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.store.rotateControllerCredential(
      await this.sessions.requireOrganization(req, "device.manage"),
      assertUuid(id, "controller"),
    );
  }
  @Get("audit") async audit(@Req() req: FastifyRequest, @Query("limit") limit?: string) {
    const principal = await this.sessions.requireOrganization(req, "audit.read");
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return (
      await this.store.query(
        "SELECT id, actor_id, action, entity_id, detail, support_grant_id, created_at FROM audit_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2",
        [principal.organizationId, take],
      )
    ).rows;
  }
}

@Controller("platform")
export class PlatformController {
  constructor(
    @Inject(Identity) private readonly identity: Identity,
    @Inject(Sessions) private readonly sessions: Sessions,
  ) {}
  @Get("organizations") async organizations(@Req() req: FastifyRequest) {
    // The cross-customer listing is a platform capability: this permission is granted only to
    // platform roles, so a customer administrator cannot enumerate other customers.
    await this.sessions.require(req, "platform.fleet.read");
    return this.identity.organizations();
  }
  /** Platform access to a customer is never implicit: it needs a reason and an expiry. */
  @Post("organizations/:id/support-access") async supportAccess(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.require(req, "support.access");
    return this.identity.grantSupportAccess(
      principal,
      assertUuid(id, "organization"),
      body?.reason,
      body?.minutes,
    );
  }
  @Post("support-access/:id/revoke") async revoke(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const principal = await this.sessions.require(req, "support.access");
    return this.identity.revokeSupportAccess(principal, assertUuid(id, "support grant"));
  }
}

@Controller()
export class DeviceController {
  private readonly enrollmentAttempts = new Map<string, { startedAt: number; count: number }>();
  constructor(
    @Inject(Store) private readonly store: Store,
    @Inject(Sessions) private readonly sessions: Sessions,
  ) {}
  @Get("edge/v1/configuration") async configuration(@Req() req: FastifyRequest) {
    const device = await this.sessions.edge(req, this.store.isDemo, this.store);
    return this.store.configuration(device);
  }
  @Post("edge/v1/events") async events(@Req() req: FastifyRequest, @Body() body: any) {
    const device = await this.sessions.edge(req, this.store.isDemo, this.store);
    if (
      !Array.isArray(body?.events) ||
      body.events.length > 100 ||
      !body.events.length ||
      body.events.some((e: unknown) => !validateProtocol("access-event", e))
    )
      throw new BadRequestException("Invalid event batch.");
    return this.store.ingest(body.events as AccessEvent[], device);
  }
  @Post("edge/v1/heartbeat") async heartbeat(@Req() req: FastifyRequest, @Body() body: any) {
    const device = await this.sessions.edge(req, this.store.isDemo, this.store);
    if (!validateProtocol("heartbeat", body)) throw new BadRequestException("Invalid heartbeat.");
    return this.store.heartbeat(body, device);
  }
  @Post("edge/v1/enrollment/claim") async claimEnrollment(
    @Req() req: FastifyRequest,
    @Body() body: any,
  ) {
    this.limitEnrollmentAttempts(req.ip);
    if (!validateProtocol("controller-enrollment", body))
      throw new BadRequestException("Invalid controller enrollment request.");
    const result = await this.store.claimController({
      enrollmentCode: body.enrollment_code,
      installationId: body.installation_id,
      protocolVersion: body.protocol_version,
      softwareVersion: body.software_version,
    });
    if (!validateProtocol("controller-enrollment-response", result))
      throw new Error("Controller enrollment response failed protocol validation.");
    return result;
  }
  private limitEnrollmentAttempts(ip: string) {
    const now = Date.now();
    const current = this.enrollmentAttempts.get(ip);
    if (current && now - current.startedAt < 60_000) {
      if (current.count >= 8) throw new HttpException("Too many enrollment attempts.", 429);
      current.count += 1;
      return;
    }
    if (this.enrollmentAttempts.size >= 2048) {
      for (const [address, attempt] of this.enrollmentAttempts)
        if (now - attempt.startedAt >= 60_000) this.enrollmentAttempts.delete(address);
      if (this.enrollmentAttempts.size >= 2048)
        throw new HttpException("Too many enrollment attempts.", 429);
    }
    this.enrollmentAttempts.set(ip, { startedAt: now, count: 1 });
  }
}

@Controller("demo")
export class DemoController {
  constructor(
    @Inject(Store) private readonly store: Store,
    @Inject(Identity) private readonly identity: Identity,
  ) {}
  /**
   * The demonstration shortcut signs in as a seeded account through the real login path, so the
   * demonstration cannot reach data that the equivalent real account could not.
   */
  @Post("session") async session(@Req() req: FastifyRequest, @Body() body: any) {
    const profile = stringField(body?.profile, "profile", 20);
    const email = this.store.demoAccount(profile);
    return this.identity.login(email, this.store.demoPassword, sessionMeta(req));
  }
}
export const controllers = [
  HealthController,
  AuthController,
  DomainController,
  PlatformController,
  DeviceController,
  DemoController,
];
