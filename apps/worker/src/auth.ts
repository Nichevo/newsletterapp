import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Accepts the team name (`acme`), the team domain
 * (`acme.cloudflareaccess.com`) or a full URL, and returns the issuer URL
 * Access signs its tokens with.
 */
export function accessIssuer(teamDomain: string): string {
  const name = teamDomain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.cloudflareaccess\.com$/i, '');
  return `https://${name}.cloudflareaccess.com`;
}

function jwksFor(issuer: string) {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
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

/** Who is calling: a person signed in through Access, or the PC helper using its service token. */
export type Identity = { kind: 'user'; email: string } | { kind: 'helper'; clientId: string };

/** Client IDs look like "abc123.access"; compare them without the suffix. */
const clientIdKey = (id: string) => id.trim().toLowerCase().replace(/\.access$/, '');

/**
 * Resolves the caller from the Cloudflare Access JWT.
 * Fails closed: with no Access configuration every request is refused,
 * except in local development with DEV_BYPASS_AUTH set.
 */
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  if (env.DEV_BYPASS_AUTH === '1') {
    if (request.headers.get('X-Dev-Helper') === '1') return { kind: 'helper', clientId: 'dev' };
    return { kind: 'user', email: env.DEV_EMAIL || 'dev@localhost' };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AuthError(
      'Cloudflare Access is not configured yet (ACCESS_TEAM_DOMAIN / ACCESS_AUD).',
      503,
    );
  }
  const token = tokenFrom(request);
  if (!token) throw new AuthError('Missing Access token', 401);

  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  let email: string | undefined;
  let commonName: string | undefined;
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: env.ACCESS_AUD.trim(),
    });
    email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
    // Service-token logins carry the token's client ID instead of an email.
    commonName = typeof payload.common_name === 'string' ? payload.common_name : undefined;
  } catch {
    throw new AuthError('Invalid Access token', 401);
  }
  if (!email && commonName) {
    const expected = env.HELPER_CLIENT_ID?.trim();
    if (expected && clientIdKey(commonName) === clientIdKey(expected)) return { kind: 'helper', clientId: commonName };
    throw new AuthError('This service token is not the PC helper', 403);
  }
  if (!email) throw new AuthError('Access token has no email', 401);

  const allowed = env.ALLOWED_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(email)) {
    throw new AuthError('This account is not allowed', 403);
  }
  return { kind: 'user', email };
}
