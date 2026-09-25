export type Role = "hoa_admin" | "guard" | "resident";
export type Permission = "enrollment.write" | "credential.manage" | "access.read" | "vehicle.read";
const permissions: Record<Role, readonly Permission[]> = {
  hoa_admin: ["enrollment.write", "credential.manage", "access.read", "vehicle.read"],
  guard: ["access.read", "vehicle.read"],
  resident: ["vehicle.read", "access.read"],
};
export function can(role: Role, permission: Permission): boolean {
  return permissions[role]?.includes(permission) ?? false;
}
export interface Principal {
  id: string;
  organizationId: string;
  role: Role;
  propertyId?: string;
  name: string;
}
