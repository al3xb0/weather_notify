export interface JwtPayload {
  sub: string;
  email: string;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
  email: string;
}

export interface AuthUser {
  userId: string;
  email: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}
