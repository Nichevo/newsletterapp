import type { AuthResult } from '@newsletterapp/shared';
import type { AddressRow, SenderRow } from './db';
import type { Env } from './env';
import { newId, now } from './ids';

export interface AuthResults {
  spf: AuthResult;
  dkim: AuthResult;
  dmarc: AuthResult;
  /** Overall verdict used for screening decisions. */
  overall: AuthResult;
}

/**
 * Reads SPF / DKIM / DMARC verdicts from Authentication-Results headers.
 * Any header we cannot find is reported as "unknown", never as a pass.
 */
export function parseAuthResults(headers: Iterable<[string, string]>): AuthResults {
  const result: AuthResults = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', overall: 'unknown' };
  for (const [key, value] of headers) {
    if (key.toLowerCase() !== 'authentication-results') continue;
    const v = value.toLowerCase();
    for (const method of ['spf', 'dkim', 'dmarc'] as const) {
      const m = new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`).exec(v);
      if (!m) continue;
      const verdict = m[1];
      // The first header is the one closest to us (added last), so keep the first verdict seen.
      if (result[method] !== 'unknown') continue;
      result[method] = verdict === 'pass' ? 'pass' : verdict === 'none' || verdict === 'neutral' ? 'unknown' : 'fail';
    }
  }
  if (result.dmarc === 'fail' || (result.spf === 'fail' && result.dkim !== 'pass')) {
    result.overall = 'fail';
  } else if (result.dmarc === 'pass' || result.dkim === 'pass' || result.spf === 'pass') {
    result.overall = 'pass';
  }
  return result;
}

export type ScreeningDecision =
  | { action: 'drop'; reason: 'blocked_address' | 'blocked_sender' | 'unregistered_and_failed_auth' }
  | { action: 'inbox'; sender: SenderRow; address: AddressRow; autoApproved: boolean }
  | { action: 'screening'; sender: SenderRow; address: AddressRow };

/**
 * Finds or creates the address and sender rows for an incoming email and
 * decides whether it goes to the inbox, waits on the New senders screen,
 * or is dropped. Everything that needs the database happens here so the
 * email handler stays small.
 */
export async function screen(
  env: Env,
  localPart: string,
  fromEmail: string,
  fromName: string | null,
  auth: AuthResults,
): Promise<ScreeningDecision> {
  const t = now();
  const db = env.DB;

  let address = await db
    .prepare('SELECT * FROM addresses WHERE local_part = ?')
    .bind(localPart)
    .first<AddressRow>();

  if (address?.status === 'blocked') {
    await db
      .prepare('UPDATE addresses SET blocked_count = blocked_count + 1 WHERE id = ?')
      .bind(address.id)
      .run();
    return { action: 'drop', reason: 'blocked_address' };
  }

  if (!address) {
    // Mail to an address nobody created in the app. Dictionary spam lands
    // here too, so anything failing authentication is dropped outright.
    if (auth.overall === 'fail') {
      return { action: 'drop', reason: 'unregistered_and_failed_auth' };
    }
    address = {
      id: newId(),
      local_part: localPart,
      label: null,
      status: 'active',
      created_in_app: 0,
      created_at: t,
      blocked_at: null,
      blocked_count: 0,
    };
    await db
      .prepare(
        'INSERT INTO addresses (id, local_part, label, status, created_in_app, created_at) VALUES (?, ?, NULL, ?, 0, ?)',
      )
      .bind(address.id, address.local_part, address.status, t)
      .run();
  }

  let sender = await db
    .prepare('SELECT * FROM senders WHERE email = ? AND address_id = ?')
    .bind(fromEmail, address.id)
    .first<SenderRow>();

  if (sender) {
    await db
      .prepare('UPDATE senders SET last_seen_at = ?, auth_result = ?, name = COALESCE(name, ?) WHERE id = ?')
      .bind(t, auth.overall, fromName, sender.id)
      .run();
    sender = { ...sender, last_seen_at: t, auth_result: auth.overall, name: sender.name ?? fromName };
    if (sender.status === 'blocked') {
      await db.prepare('UPDATE senders SET blocked_count = blocked_count + 1 WHERE id = ?').bind(sender.id).run();
      return { action: 'drop', reason: 'blocked_sender' };
    }
    if (sender.status === 'approved') return { action: 'inbox', sender, address, autoApproved: false };
    return { action: 'screening', sender, address };
  }

  // First time this sender writes to this address.
  const autoAllowDays = Number(env.AUTO_ALLOW_DAYS || '14');
  const addressIsFresh = address.created_in_app === 1 && t - address.created_at < autoAllowDays * 86_400_000;
  const approvedCount = await db
    .prepare("SELECT COUNT(*) AS n FROM senders WHERE address_id = ? AND status = 'approved'")
    .bind(address.id)
    .first<{ n: number }>();
  const autoApprove = addressIsFresh && (approvedCount?.n ?? 0) === 0 && auth.overall !== 'fail';

  sender = {
    id: newId(),
    email: fromEmail,
    address_id: address.id,
    name: fromName,
    status: autoApprove ? 'approved' : 'pending',
    first_seen_at: t,
    last_seen_at: t,
    decided_at: autoApprove ? t : null,
    auth_result: auth.overall,
    blocked_count: 0,
  };
  await db
    .prepare(
      `INSERT INTO senders (id, email, address_id, name, status, first_seen_at, last_seen_at, decided_at, auth_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sender.id,
      sender.email,
      sender.address_id,
      sender.name,
      sender.status,
      sender.first_seen_at,
      sender.last_seen_at,
      sender.decided_at,
      sender.auth_result,
    )
    .run();

  return autoApprove
    ? { action: 'inbox', sender, address, autoApproved: true }
    : { action: 'screening', sender, address };
}
