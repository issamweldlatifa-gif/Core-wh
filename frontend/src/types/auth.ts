export interface AuthUser {
  id: string;
  name: string;
  employeeCode: string;
  email: string | null;
  status: string;
  lastLoginAt: string | null;
}

export interface AuthMe {
  user: AuthUser;
  roles: string[];
  permissions: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  path?: string;
  timestamp?: string;
}
