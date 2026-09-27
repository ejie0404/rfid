export type Role =
  "platform_admin" | "platform_support" | "hoa_admin" | "guard" | "resident" | "unaffiliated";
export type MembershipRole = "hoa_admin" | "guard" | "resident";
export type Permission =
  | "organization.read"
  | "organization.manage"
  | "platform.fleet.read"
  | "membership.manage"
  | "invitation.manage"
  | "enrollment.write"
  | "credential.manage"
  | "credential.report_lost"
  | "vehicle.change.request"
  | "vehicle.retire.request"
  | "vehicle.read"
  | "access.read"
  | "audit.read"
  | "device.read"
  | "device.manage"
  | "site.read"
  | "site.manage"
  | "support.access";

/**
 * Permission templates. A role is granted a template here and never receives permissions from
 * a request body. Platform roles deliberately exclude household permissions: customer data is
 * reachable only through an explicit, audited, time-limited support grant.
 *
 * `platform.fleet.read` is the cross-customer listing, so it is granted only to platform roles.
 * A customer administrator holds `organization.read` for its own village and can never enumerate
 * other customers.
 *
 * `unaffiliated` is an account that exists but currently holds no organization membership. It can
 * sign in so it can accept an invitation and reclaim its identity, but the empty template grants it
 * nothing and such a session has no organization scope at all.
 */
const templates: Record<Role, readonly Permission[]> = {
  platform_admin: [
    "organization.read",
    "organization.manage",
    "platform.fleet.read",
    "membership.manage",
    "invitation.manage",
    "device.read",
    "device.manage",
    "site.read",
    "site.manage",
    "audit.read",
    "support.access",
  ],
  platform_support: [
    "organization.read",
    "platform.fleet.read",
    "device.read",
    "site.read",
    "audit.read",
    "support.access",
  ],
  hoa_admin: [
    "organization.read",
    "membership.manage",
    "invitation.manage",
    "enrollment.write",
    "credential.manage",
    "vehicle.read",
    "access.read",
    "audit.read",
    "device.read",
    "device.manage",
    "site.read",
    "site.manage",
  ],
  guard: ["vehicle.read", "access.read", "device.read", "site.read"],
  resident: [
    "vehicle.read",
    "access.read",
    "credential.report_lost",
    "vehicle.change.request",
    "vehicle.retire.request",
  ],
  unaffiliated: [],
};
export function can(role: Role, permission: Permission): boolean {
  return templates[role]?.includes(permission) ?? false;
}
export function permissionsFor(role: Role): readonly Permission[] {
  return templates[role] ?? [];
}
/**
 * What an audited support grant may add on top of the platform role's own permissions. It is
 * deliberately read-only: a support session diagnoses a customer site, it never changes one, and
 * it never gains the HOA administrator's write permissions.
 */
export const SUPPORT_ELEVATION: readonly Permission[] = [
  "organization.read",
  "vehicle.read",
  "access.read",
  "audit.read",
  "device.read",
  "site.read",
];
export function canAct(principal: Principal, permission: Permission): boolean {
  if (can(principal.role, permission)) return true;
  return !!principal.supportGrantId && SUPPORT_ELEVATION.includes(permission);
}
export function isPlatformRole(role: Role): boolean {
  return role === "platform_admin" || role === "platform_support";
}
/**
 * Roles that can change another person's access or reach more than one household. When the
 * privileged-account MFA policy is on, these roles must enroll an authenticator before acting.
 */
export function isPrivilegedRole(role: Role): boolean {
  return isPlatformRole(role) || role === "hoa_admin";
}
export function isMembershipRole(role: Role): role is MembershipRole {
  return role === "hoa_admin" || role === "guard" || role === "resident";
}
export type HouseholdRelationship = "owner" | "tenant" | "family_member" | "occupant";
export interface Principal {
  id: string;
  name: string;
  email: string;
  role: Role;
  sessionId: string;
  /** Null for a platform-level session that is not acting inside a customer organization. */
  organizationId: string | null;
  membershipId: string | null;
  /** Properties this resident may read. Empty for non-resident roles. */
  properties: string[];
  /** Sites a guard is assigned to. Empty for non-guard roles. */
  sites: string[];
  /**
   * Whether this session completed multi-factor verification. A session belonging to an account
   * with MFA enabled is refused unless this is true, and it is carried across a scope change.
   */
  mfaSatisfied: boolean;
  /** Set only while acting under an explicit, audited support grant. */
  supportGrantId?: string;
}
export interface MembershipSummary {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  role: MembershipRole;
  status: string;
}
