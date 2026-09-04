/**
 * The authenticated principal attached to the request by the JWT strategy.
 * `permissions` are resolved from the database on every request so that
 * permission revocation is effective immediately (back-end, not front-end).
 */
export interface AuthenticatedUser {
  id: string;
  employeeCode: string;
  name: string;
  email?: string | null;
  roles: string[];
  permissions: string[];
  sessionId: string;
  /** Application surface this session was opened for (DB server truth). */
  application: 'ADMIN_WEB' | 'WORKER_NATIVE';
  /** Applications this user's server-derived roles may open. */
  allowedApplications: Array<'ADMIN_WEB' | 'WORKER_NATIVE'>;
}
