import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { validateProtocol, type AccessEvent } from "@smartgate/contracts";
import { canAct } from "@smartgate/permissions";
import { Identity, assertUuid } from "./identity.js";
import { Sessions, bearer, effectiveRole, sessionMeta } from "./session.js";
import { Store } from "./store.js";

/** Account routes stay reachable while a privileged account is limited to MFA enrollment. */
const MFA_SETUP = { allowDuringMfaSetup: true } as const;

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
  @Get("health/live") liveness() {
    return { status: "ok" };
  }
  @Get("health/ready") async readiness() {
    try {
      await this.store.checkReady();
    } catch {
      throw new ServiceUnavailableException("Service not ready");
    }
    return { status: "ready" };
  }
  @Get("health") async health() {
    await this.readiness();
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
    const principal = await this.sessions.require(req, undefined, MFA_SETUP);
    return {
      principal,
      memberships: await this.identity.memberships(principal.id),
      mfa_setup_required: this.identity.mfaSetupRequired(principal),
    };
  }
  @Post("logout") async logout(@Req() req: FastifyRequest) {
    return this.identity.logout(bearer(req));
  }
  @Post("scope") scope(@Req() req: FastifyRequest, @Body() body: any) {
    return this.sessions
      .require(req, undefined, MFA_SETUP)
      .then((principal) =>
        this.identity.scopeSession(
          principal,
          assertUuid(body?.organization_id, "organization"),
          sessionMeta(req),
        ),
      );
  }
  @Post("password") async changePassword(@Req() req: FastifyRequest, @Body() body: any) {
    const principal = await this.sessions.require(req, undefined, MFA_SETUP);
    return this.identity.changePassword(principal, body?.current_password, body?.new_password);
  }
  @Post("mfa/enroll") async enrollMfa(@Req() req: FastifyRequest) {
    return this.identity.beginMfaEnrollment(await this.sessions.require(req, undefined, MFA_SETUP));
  }
  @Post("mfa/confirm") async confirmMfa(@Req() req: FastifyRequest, @Body() body: any) {
    return this.identity.confirmMfaEnrollment(
      await this.sessions.require(req, undefined, MFA_SETUP),
      body?.code,
    );
  }
  @Get("sessions") async listSessions(@Req() req: FastifyRequest) {
    const principal = await this.sessions.require(req, undefined, MFA_SETUP);
    return this.identity.sessionsForUser(principal.id);
  }
  @Post("sessions/:id/revoke") async revokeSession(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const principal = await this.sessions.require(req, undefined, MFA_SETUP);
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
  @Get("households") async households(@Req() req: FastifyRequest, @Query() query: any) {
    const principal = await this.sessions.requireOrganization(req, "vehicle.read");
    return this.store.pageHouseholds(principal, {
      search: typeof query?.search === "string" ? query.search : "",
      cursor: typeof query?.cursor === "string" ? query.cursor : undefined,
      limit: query?.limit === undefined ? undefined : Number(query.limit),
    });
  }
  @Get("properties/:propertyId/members") async householdMembers(
    @Req() req: FastifyRequest,
    @Param("propertyId") propertyId: string,
    @Query() query: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "membership.manage");
    const status = query?.status;
    if (status !== undefined && status !== "active" && status !== "ended")
      throw new BadRequestException("Choose active or ended household members.");
    return this.store.pageHouseholdMembers(principal, assertUuid(propertyId, "property"), {
      status,
      cursor: typeof query?.cursor === "string" ? query.cursor : undefined,
      limit: query?.limit === undefined ? undefined : Number(query.limit),
    });
  }
  @Get("occupancies") async occupancies(@Req() req: FastifyRequest, @Query() query: any) {
    const principal = await this.sessions.requireOrganization(req, "membership.manage");
    const status = query?.status;
    if (status !== undefined && status !== "active" && status !== "ended")
      throw new BadRequestException("Choose active or ended occupancies.");
    return this.store.pageOccupancies(principal, {
      status,
      propertyId: query?.property_id ? assertUuid(query.property_id, "property") : undefined,
      cursor: typeof query?.cursor === "string" ? query.cursor : undefined,
      limit: query?.limit === undefined ? undefined : Number(query.limit),
    });
  }
  @Get("lifecycle-requests") async lifecycleRequests(
    @Req() req: FastifyRequest,
    @Query() query: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "vehicle.read");
    const kind = query?.kind;
    if (
      !["vehicle_changes", "credential_replacements", "vehicle_retirements", "move_outs"].includes(
        kind,
      )
    )
      throw new BadRequestException("Choose a supported lifecycle record type.");
    return this.store.pageLifecycleRequests(principal, {
      kind,
      status: typeof query?.status === "string" ? query.status : undefined,
      propertyId: query?.property_id ? assertUuid(query.property_id, "property") : undefined,
      search: typeof query?.search === "string" ? query.search : "",
      cursor: typeof query?.cursor === "string" ? query.cursor : undefined,
      limit: query?.limit === undefined ? undefined : Number(query.limit),
    });
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
    if (body.status === "lost" && role === "resident")
      return {
        ok: true,
        delivery: "pending_edge_acknowledgement",
        acted_as: role,
        ...(await this.store.reportLostCredential(principal, id)),
      };
    if (!canAct(principal, "credential.manage")) throw new ForbiddenException();
    await this.store.status(principal, id, body.status);
    return { ok: true, delivery: "pending_edge_acknowledgement", acted_as: role };
  }
  @Post("credential-requests") async reportLostCredential(
    @Req() req: FastifyRequest,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.report_lost");
    return this.store.reportLostCredential(
      principal,
      assertUuid(body?.credential_id, "credential"),
    );
  }
  @Post("credential-requests/:id/issue") async issueCredentialReplacement(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.manage");
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
    return this.store.issueCredentialReplacement(principal, assertUuid(id, "request"), {
      format,
      value,
    });
  }
  @Post("credential-requests/:id/reject") async rejectCredentialReplacement(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.manage");
    const note = body?.decision_note ?? "";
    if (typeof note !== "string" || note.trim().length > 240)
      throw new BadRequestException("The decision note must be 240 characters or fewer.");
    return this.store.rejectCredentialReplacement(
      principal,
      assertUuid(id, "request"),
      note.trim(),
    );
  }
  @Post("vehicle-change-requests") async requestVehicleChange(
    @Req() req: FastifyRequest,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "vehicle.change.request");
    return this.store.requestVehicleChange(principal, assertUuid(body?.vehicle_id, "vehicle"), {
      plate: stringField(body?.plate, "plate", 20).toUpperCase(),
      make: stringField(body?.make, "make", 60),
      color: stringField(body?.color, "color", 40),
    });
  }
  @Post("vehicle-change-requests/:id/approve") async approveVehicleChange(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.manage");
    const note = body?.decision_note ?? "";
    if (typeof note !== "string" || note.trim().length > 240)
      throw new BadRequestException("The decision note must be 240 characters or fewer.");
    return this.store.approveVehicleChange(principal, assertUuid(id, "request"), note.trim());
  }
  @Post("vehicle-change-requests/:id/reject") async rejectVehicleChange(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.manage");
    const note = stringField(body?.decision_note, "decision note", 240);
    return this.store.rejectVehicleChange(principal, assertUuid(id, "request"), note);
  }
  @Post("vehicle-retirement-requests") async requestVehicleRetirement(
    @Req() req: FastifyRequest,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "vehicle.retire.request");
    const reason = body?.reason ?? "";
    if (typeof reason !== "string" || reason.trim().length > 240)
      throw new BadRequestException("The reason must be 240 characters or fewer.");
    return this.store.requestVehicleRetirement(
      principal,
      assertUuid(body?.vehicle_id, "vehicle"),
      reason.trim(),
    );
  }
  @Post("vehicle-retirement-requests/:id/cancel") async cancelVehicleRetirement(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.store.cancelVehicleRetirement(
      await this.sessions.requireOrganization(req, "vehicle.retire.request"),
      assertUuid(id, "request"),
    );
  }
  @Post("vehicle-retirement-requests/:id/approve") async approveVehicleRetirement(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.manage");
    const note = body?.decision_note ?? "";
    if (typeof note !== "string" || note.trim().length > 240)
      throw new BadRequestException("The decision note must be 240 characters or fewer.");
    return this.store.approveVehicleRetirement(principal, assertUuid(id, "request"), note.trim());
  }
  @Post("vehicle-retirement-requests/:id/reject") async rejectVehicleRetirement(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "credential.manage");
    return this.store.rejectVehicleRetirement(
      principal,
      assertUuid(id, "request"),
      stringField(body?.decision_note, "decision note", 240),
    );
  }
  @Post("vehicles/:id/retire") async retireVehicle(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const reason = body?.reason ?? "";
    if (typeof reason !== "string" || reason.trim().length > 240)
      throw new BadRequestException("The reason must be 240 characters or fewer.");
    return this.store.retireVehicle(
      await this.sessions.requireOrganization(req, "credential.manage"),
      assertUuid(id, "vehicle"),
      reason.trim(),
    );
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
      relationship: body?.relationship,
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
  @Post("properties/:propertyId/members/:memberId/end") async endPropertyMember(
    @Req() req: FastifyRequest,
    @Param("propertyId") propertyId: string,
    @Param("memberId") memberId: string,
  ) {
    return this.identity.endPropertyMember(
      await this.sessions.requireOrganization(req, "membership.manage"),
      assertUuid(propertyId, "property"),
      assertUuid(memberId, "household member"),
    );
  }
  @Post("properties/:propertyId/members/:memberId/primary") async setPrimaryContact(
    @Req() req: FastifyRequest,
    @Param("propertyId") propertyId: string,
    @Param("memberId") memberId: string,
  ) {
    return this.identity.setPrimaryContact(
      await this.sessions.requireOrganization(req, "membership.manage"),
      assertUuid(propertyId, "property"),
      assertUuid(memberId, "household member"),
    );
  }
  @Post("properties/:id/move-out") async moveOut(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "membership.manage");
    const reason = body?.reason ?? "";
    if (typeof reason !== "string" || reason.trim().length > 240)
      throw new BadRequestException("The reason must be 240 characters or fewer.");
    return this.store.moveOut(principal, assertUuid(id, "property"), reason.trim());
  }
  @Post("properties/:id/move-out-schedule") async scheduleMoveOut(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const principal = await this.sessions.requireOrganization(req, "membership.manage");
    const reason = body?.reason ?? "";
    if (typeof reason !== "string" || reason.trim().length > 240)
      throw new BadRequestException("The reason must be 240 characters or fewer.");
    if (
      typeof body?.effective_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(body.effective_at)
    )
      throw new BadRequestException("Use a date and time with an explicit time zone.");
    return this.store.scheduleMoveOut(
      principal,
      assertUuid(id, "property"),
      new Date(body.effective_at),
      reason.trim(),
    );
  }
  @Post("properties/:id/move-out-schedule/cancel") async cancelScheduledMoveOut(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.store.cancelScheduledMoveOut(
      await this.sessions.requireOrganization(req, "membership.manage"),
      assertUuid(id, "property"),
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
  /** Onboarding starts here: the village must exist before its first administrator is invited. */
  @Post("organizations") async createOrganization(@Req() req: FastifyRequest, @Body() body: any) {
    const principal = await this.sessions.require(req, "organization.manage");
    return this.identity.createOrganization(principal, { name: body?.name });
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
