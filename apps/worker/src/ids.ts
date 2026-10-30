export function newId(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}

/** Lowercases and strips display names: "Jeff <a@b.com>" -> "a@b.com". */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = /<([^>]+)>/.exec(raw);
  const addr = (angle?.[1] ?? raw).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

export function localPartOf(email: string): string {
  return email.split('@')[0] ?? '';
}

export function domainOf(email: string): string {
  return email.split('@')[1] ?? '';
}

/** "money-matters" style slug for new sign-up addresses. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
