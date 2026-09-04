/**
 * Order #3 — Application access domain (A1).
 *
 * Pure, server-side authorization kernel that implements the strict
 * Admin / Worker isolation rules:
 *
 *    ADMIN  identity + WORKER_NATIVE  → DENIED
 *    WORKER identity + ADMIN_WEB      → DENIED
 *    ADMIN  identity + ADMIN_WEB      → ALLOWED
 *    WORKER identity + WORKER_NATIVE  → ALLOWED
 *
 * Everything here is pure and data-driven from SERVER-derived inputs (roles,
 * permissions and station bindings come from the database on every request —
 * the client never supplies them). There is deliberately no path where a
 * client-supplied role can reach the decision: the API only accepts the
 * authoritative inputs.
 *
 * The single entry point `evaluateAccess()` mirrors the Order #3 §5 chain:
 *   account active → application allowed by roles → required permission granted
 *   → station allowed → device authorized → ACCEPT.
 */

export type ApplicationKind = 'ADMIN_WEB' | 'WORKER_NATIVE';

export const APPLICATIONS: ApplicationKind[] = ['ADMIN_WEB', 'WORKER_NATIVE'];

export type RoleClass = 'ADMIN' | 'OPERATIONAL' | 'VIEWER' | 'UNKNOWN';

/**
 * Seeded system roles (backend/prisma/seed.ts) classify via the role NAME for
 * legacy rows whose DB `applicationClass` is still UNKNOWN (pre-migration
 * safety). New roles carry their class in the DB — the server prefers the
 * column; the name map below is only a fallback so an un-migrated database
 * never accidentally widens access.
 */
const ADMIN_CLASS_ROLES = new Set(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER']);
const OPERATIONAL_CLASS_ROLES = new Set(['INBOUND_WORKER', 'PICKER', 'PACKER']);
const VIEWER_CLASS_ROLES = new Set(['VIEWER']);

export function classifyRole(role: string): RoleClass {
  if (ADMIN_CLASS_ROLES.has(role)) return 'ADMIN';
  if (OPERATIONAL_CLASS_ROLES.has(role)) return 'OPERATIONAL';
  if (VIEWER_CLASS_ROLES.has(role)) return 'VIEWER';
  return 'UNKNOWN';
}

/**
 * Resolve the effective application class of a role row. Server truth is the
 * DB `applicationClass` column (data-driven, future-proof for new roles).
 * A row still carrying UNKNOWN falls back to the legacy seed-name map so a
 * not-yet-migrated database keeps its current behaviour — never wider.
 */
export function roleClassOf(row: { name: string; applicationClass?: string }): RoleClass {
  const c = row.applicationClass as RoleClass | undefined;
  if (c && c !== 'UNKNOWN') return c;
  return classifyRole(row.name);
}

/** The application surfaces a single role class may open. */
export function classAllowsApplications(roleClass: RoleClass): ApplicationKind[] {
  switch (roleClass) {
    case 'ADMIN':
    case 'VIEWER':
      return ['ADMIN_WEB'];
    case 'OPERATIONAL':
      return ['WORKER_NATIVE'];
    case 'UNKNOWN':
    default:
      return [];
  }
}

/** The set of applications a set of role classes may open (explicit union). */
export function applicationsAllowedByRoleClasses(classes: RoleClass[]): Set<ApplicationKind> {
  const allowed = new Set<ApplicationKind>();
  for (const cls of classes) {
    for (const app of classAllowsApplications(cls)) allowed.add(app);
  }
  return allowed;
}

export type AccessReason =
  | 'OK'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'NO_ROLES'
  | 'APPLICATION_NOT_ALLOWED_BY_ROLES'
  | 'PERMISSION_DENIED'
  | 'STATION_NOT_AUTHORIZED'
  | 'DEVICE_NOT_AUTHORIZED';

export interface AccessDecision {
  allowed: boolean;
  application: ApplicationKind;
  reason: AccessReason;
}

export interface EvaluateAccessInput {
  /** Requested application (from the client's `application` field at login). */
  application: ApplicationKind;
  /** Server-derived role names (from the DB, never from the client). */
  roles: string[];
  /**
   * Server-derived role CLASSES read from the DB `applicationClass` column
   * (data-driven). When supplied they drive the surface decision; otherwise
   * `roles` are classified by the legacy seed-name fallback.
   */
  roleClasses?: RoleClass[];
  /** Server-derived account state (from the DB). */
  accountActive: boolean;
  /** Permission required by the operation (e.g. 'receiving.execute'). */
  requiredPermission?: string;
  /** Server-derived granted permissions (from the DB). */
  grantedPermissions?: string[];
  /** Optional server-derived station binding for worker operations. */
  stationId?: string;
  allowedStations?: string[];
  /** Optional device authorization result (device binding phase B1). */
  deviceAuthorized?: boolean;
}

/** The set of applications a role set is allowed to open a session for. */
export function applicationsAllowedByRoles(roles: string[]): Set<ApplicationKind> {
  return applicationsAllowedByRoleClasses(roles.map((r) => classifyRole(r)));
}

/**
 * Full server-side evaluation. Order of checks is fixed and short-circuits to
 * the most specific deny reason.
 */
export function evaluateAccess(input: EvaluateAccessInput): AccessDecision {
  const { application } = input;

  if (!input.accountActive) {
    return { allowed: false, application, reason: 'ACCOUNT_NOT_ACTIVE' };
  }
  if (input.roles.length === 0) {
    return { allowed: false, application, reason: 'NO_ROLES' };
  }
  const allowed =
    input.roleClasses && input.roleClasses.length > 0
      ? applicationsAllowedByRoleClasses(input.roleClasses)
      : applicationsAllowedByRoles(input.roles);
  if (!allowed.has(application)) {
    return { allowed: false, application, reason: 'APPLICATION_NOT_ALLOWED_BY_ROLES' };
  }
  if (input.requiredPermission) {
    const granted = new Set(input.grantedPermissions ?? []);
    if (!granted.has(input.requiredPermission)) {
      return { allowed: false, application, reason: 'PERMISSION_DENIED' };
    }
  }
  if (input.stationId && input.allowedStations && !input.allowedStations.includes(input.stationId)) {
    return { allowed: false, application, reason: 'STATION_NOT_AUTHORIZED' };
  }
  if (input.deviceAuthorized === false) {
    return { allowed: false, application, reason: 'DEVICE_NOT_AUTHORIZED' };
  }
  return { allowed: true, application, reason: 'OK' };
}
