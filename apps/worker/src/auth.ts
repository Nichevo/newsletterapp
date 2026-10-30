import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = request.headers.get('Cookie') ?? '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match?.[1] ?? null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: 401 | 403 | 503,
  ) {
    super(message);
  }
}

/**
 * Resolves the signed-in user's email from the Cloudflare Access JWT.
 * Fails closed: with no Access configuration every request is refused,
 * except in local development with DEV_BYPASS_AUTH set.
 */
export async function authenticate(request: Request, env: Env): Promise<string> {
  if (env.DEV_BYPASS_AUTH === '1') {
    return env.DEV_EMAIL || 'dev@localhost';
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AuthError(
      'Cloudflare Access is not configured yet (ACCESS_TEAM_DOMAIN / ACCESS_AUD).',
      503,
    );
  }
  const token = tokenFrom(request);
  if (!token) throw new AuthError('Missing Access token', 401);

  let email: string | undefined;
  try {
    const { payload } = await jwtVerify(token, jwksFor(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`,
      audience: env.ACCESS_AUD,
    });
    email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
  } catch {
    throw new AuthError('Invalid Access token', 401);
  }
  if (!email) throw new AuthError('Access token has no email', 401);

  const allowed = env.ALLOWED_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(email)) {
    throw new AuthError('This account is not allowed', 403);
  }
  return email;
}
