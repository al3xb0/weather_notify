import { Role } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
  email: string;
}

export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}
