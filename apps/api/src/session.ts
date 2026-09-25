import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { canAct, type Permission, type Principal, type Role } from "@smartgate/permissions";
import { DEMO_EDGE_TOKEN, IDS } from "@smartgate/contracts";
import type { Identity } from "./identity.js";

/**
 * The role a principal acts as. A support grant lets a platform session read one customer
 * organization; it never changes the stored role, so the audit trail still records the operator.
 */
export function effectiveRole(principal: Principal): Role {
  return principal.supportGrantId ? "hoa_admin" : principal.role;
}
export function bearer(req: FastifyRequest) {
  return req.headers.authorization?.replace(/^Bearer /, "") || "";
}
export function sessionMeta(req: FastifyRequest) {
  return {
    userAgent: req.headers["user-agent"],
    ip: req.ip,
  };
}
export interface DeviceIdentity {
  id: string;
  organizationId: string;
  siteId: string;
  laneIds: string[];
  demo?: boolean;
}
export interface DeviceAuthenticator {
  authenticateController(credential: string): Promise<DeviceIdentity>;
}
export class Sessions {
  constructor(private readonly identity: Identity) {}
  async require(req: FastifyRequest, permission?: Permission): Promise<Principal> {
    const principal = await this.identity.resolve(bearer(req));
    if (permission && !canAct(principal, permission)) throw new ForbiddenException();
    return principal;
  }
  /** Tenant endpoints need a selected organization, not only an authenticated user. */
  async requireOrganization(req: FastifyRequest, permission?: Permission): Promise<Principal> {
    const principal = await this.require(req, permission);
    if (!principal.organizationId)
      throw new ForbiddenException("Select an organization before using this endpoint.");
    return principal;
  }
  async optional(req: FastifyRequest): Promise<Principal | undefined> {
    if (!bearer(req)) return undefined;
    try {
      return await this.identity.resolve(bearer(req));
    } catch {
      return undefined;
    }
  }
  /**
   * Device authentication is a shared marker in demonstration and an operator-supplied token
   * otherwise. Enrolled, single-use controller credentials replace this in the device step.
   */
  async edge(
    req: FastifyRequest,
    demo: boolean,
    authenticator: DeviceAuthenticator,
  ): Promise<DeviceIdentity> {
    const credential = bearer(req);
    if (demo && credential === DEMO_EDGE_TOKEN) {
      return {
        id: IDS.edge,
        organizationId: IDS.organization,
        siteId: IDS.site,
        laneIds: [IDS.lane],
        demo: true,
      };
    }
    if (!credential) throw new UnauthorizedException();
    return authenticator.authenticateController(credential);
  }
}
