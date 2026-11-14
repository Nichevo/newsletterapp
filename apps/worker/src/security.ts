import type { Hono } from 'hono';
import {
  ALERTS_LOCAL_PART,
  DEFAULT_SECURITY_SETTINGS,
  HIBP_DOMAIN,
  NO_SECURITY,
  bareBreach,
  breachChanges,
  breachFromHibp,
  breachLevel,
  cleanBreachInfo,
  hitLabel,
  leakedPhrase,
  parseHibpAlert,
  watchFor,
  type BreachHit,
  type BreachInfo,
  type BreachLevel,
  type BreachOrigin,
  type HitVia,
  type SecurityBreach,
  type SecurityBreachPage,
  type SecurityEvent,
  type SecurityMail,
  type SecurityMailPage,
  type SecuritySettings,
  type SecuritySettingsView,
  type SecuritySummary,
  type SecurityView,
  type WatchEntry,
  type WatchStatus,
} from '@newsletterapp/shared';
import type PostalMime from 'postal-mime';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { htmlToText } from './html';
import { newId, normalizeEmail, now } from './ids';
import { fromIsGenuine, signInEmails } from './saveinbox';

// Security alerts: Have I Been Pwned (HIBP) emails you when one of your addresses
// turns up in a breach it has just loaded (Notify me for an address, Domain search
// for a whole domain). Those emails go to alerts@ on the mail domain, or are
// forwarded there from Gmail/Outlook; each becomes a breach here with the
// addresses it hit, a to-do list and a history. Nothing goes to the inbox: a
// summary (read with the inbox counts) drives the shield button and its banner.
//
// The Worker also reads HIBP's public breach API, which needs no key and carries
// no addresses: hourly, the newest breach (to flag sites you get mail from) and
// the details of a few breaches already listed (to note changes). Your addresses
// are never sent anywhere, never logged, and breach mail never reaches the AI.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;
type Parsed = Awaited<ReturnType<PostalMime['parse']>>;

const DAY = 86_400_000;
const SETTINGS_KEY = 'security_settings';
const SUMMARY_KEY = 'security_summary';
const STATE_KEY = 'security_state';
const API = 'https://haveibeenpwned.com/api/v3';
/** HIBP asks every caller to name itself; nothing personal in it. */
const UA = 'newsletterapp-breach-alerts (self-hosted reader)';
const MAIL_KEEP = 100;
const BODY_MAX = 20_000;
/** Breaches whose HIBP details are re-read per hourly run (each one fetch). */
const REFRESH_PER_RUN = 3;

interface BreachRow {
  name: string;
  info: string;
  origin: BreachOrigin;
  level: BreachLevel;
  state: 'open' | 'handled';
  first_seen_at: number;
  updated_at: number;
  handled_at: number | null;
  viewed_at: number | null;
  todo_done: string | null;
  site_sources: string | null;
  info_checked_at: number | null;
}

interface HitRow {
  breach_name: string;
  address: string;
  person: string | null;
  via: HitVia;
  count: number | null;
  seen_at: number;
}

interface MailRow {
  id: string;
  received_at: number;
  from_email: string;
  subject: string;
  body?: string;
  genuine: number;
  from_hibp: number;
  breaches: string | null;
}

interface SecurityState {
  latest: string | null;
  latestTitle: string | null;
  checkedAt: number | null;
  error: string | null;
}

const NO_STATE: SecurityState = { latest: null, latestTitle: null, checkedAt: null, error: null };

const json = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const isAlertsAddress = (localPart: string) => localPart === ALERTS_LOCAL_PART;
export const isHibpSender = (email: string) => {
  const d = email.split('@')[1]?.toLowerCase() ?? '';
  return d === HIBP_DOMAIN || d.endsWith(`.${HIBP_DOMAIN}`);
};
const alertsAddress = (env: Env) => `${ALERTS_LOCAL_PART}@${env.MAIL_DOMAIN}`.toLowerCase();

// ---------- Settings ----------

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const ADDRESS_RE = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,}$/;

export function normalizeWatch(input: unknown, before: WatchEntry[]): WatchEntry[] {
  if (!Array.isArray(input)) return before;
  const out: WatchEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Partial<WatchEntry>;
    let target = typeof w.target === 'string' ? w.target.trim().toLowerCase() : '';
    if (target.startsWith('@')) target = target.slice(1);
    if (!(ADDRESS_RE.test(target) || DOMAIN_RE.test(target)) || seen.has(target)) continue;
    seen.add(target);
    out.push({
      id: typeof w.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(w.id) ? w.id : newId(),
      target,
      person: typeof w.person === 'string' ? w.person.trim().slice(0, 40) : '',
      setupDone: w.setupDone === true,
    });
  }
  return out;
}

export function normalizeSecuritySettings(input: Partial<SecuritySettings>, base: SecuritySettings = DEFAULT_SECURITY_SETTINGS): SecuritySettings {
  return {
    banner: typeof input.banner === 'boolean' ? input.banner : base.banner,
    siteWatch: typeof input.siteWatch === 'boolean' ? input.siteWatch : base.siteWatch,
    bannerLow: typeof input.bannerLow === 'boolean' ? input.bannerLow : base.bannerLow,
    watch: 'watch' in input ? normalizeWatch(input.watch, base.watch) : base.watch,
  };
}

export async function loadSecuritySettings(env: Env): Promise<SecuritySettings> {
  return normalizeSecuritySettings((await readJson<Partial<SecuritySettings>>(env, SETTINGS_KEY)) ?? {});
}

export function parseSecuritySummary(raw: string | null | undefined): SecuritySummary {
  return { ...NO_SECURITY, ...json<Partial<SecuritySummary>>(raw, {}) };
}

// ---------- HIBP's public breach API ----------

async function hibp(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Have I Been Pwned answered ${res.status}`);
  }
  const text = (await res.text()).slice(0, 200_000);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Have I Been Pwned didn’t send data');
  }
}

async function fetchBreach(name: string): Promise<BreachInfo | null> {
  return breachFromHibp(await hibp(`/breach/${encodeURIComponent(name)}`));
}

// ---------- Writing breaches ----------

const levelOf = (info: BreachInfo): Exclude<BreachLevel, 'watch'> => (info.dataClasses.length || info.spamList ? breachLevel(info.dataClasses, info.spamList) : 'medium');

function eventStmt(env: Env, name: string, at: number, kind: SecurityEvent['kind'], text: string, mailId: string | null = null) {
  return env.DB.prepare('INSERT INTO security_events (breach_name, at, kind, text, mail_id) VALUES (?, ?, ?, ?, ?)').bind(name, at, kind, text.slice(0, 500), mailId);
}

/** New details from HIBP for a breach already listed: stored, with what changed noted. */
async function applyInfo(env: Env, row: BreachRow, info: BreachInfo, t: number): Promise<void> {
  const before = json<BreachInfo>(row.info, bareBreach(row.name));
  const changes = before.dataClasses.length || before.pwnCount !== null ? breachChanges(before, info) : [];
  const level = row.origin === 'site' ? 'watch' : levelOf(info);
  const stmts = [
    env.DB.prepare('UPDATE security_breaches SET info = ?, level = ?, info_checked_at = ?, updated_at = ? WHERE name = ?').bind(
      JSON.stringify(info),
      level,
      t,
      changes.length ? t : row.updated_at,
      row.name,
    ),
  ];
  if (changes.length) stmts.push(eventStmt(env, row.name, t, 'changed', `Updated by Have I Been Pwned: ${changes.join('; ')}`));
  await env.DB.batch(stmts);
}

interface HitInput {
  address: string;
  person: string | null;
  via: HitVia;
  count: number | null;
}

/**
 * Adds (or updates) one breach for an alert or a past entry. A breach that was
 * handled opens again when an address it didn't have before turns up in it.
 */
async function recordBreach(
  env: Env,
  info: BreachInfo,
  infoFresh: boolean,
  origin: 'alert' | 'past',
  hits: HitInput[],
  t: number,
  opts: { handled?: boolean; mailId?: string | null } = {},
): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM security_breaches WHERE name = ?').bind(info.name).first<BreachRow>();
  const known = row
    ? new Set((await env.DB.prepare('SELECT address FROM security_hits WHERE breach_name = ?').bind(info.name).all<{ address: string }>()).results.map((h) => h.address))
    : new Set<string>();
  const fresh = hits.filter((h) => !known.has(h.address));
  const stmts: D1PreparedStatement[] = [];
  const who = (list: HitInput[]) => list.map((h) => hitLabel(h)).join(', ') || 'an address';

  if (!row) {
    const handled = origin === 'past' && opts.handled !== false;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO security_breaches (name, info, origin, level, state, first_seen_at, updated_at, handled_at, viewed_at, todo_done, site_sources, info_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).bind(info.name, JSON.stringify(info), origin, levelOf(info), handled ? 'handled' : 'open', t, t, handled ? t : null, handled ? t : null, infoFresh ? t : null),
    );
    stmts.push(eventStmt(env, info.name, t, origin, origin === 'past' ? `Added from your past breaches: ${who(hits)}` : `Alert for ${who(hits)}`, opts.mailId ?? null));
  } else {
    const before = json<BreachInfo>(row.info, bareBreach(row.name));
    // Keep the fuller description: a past entry's catalogue copy beats a bare placeholder.
    const better = infoFresh || (!before.dataClasses.length && info.dataClasses.length) ? info : before;
    // An alert outranks a "site you use" flag or a past entry; past never downgrades an alert.
    const newOrigin: BreachOrigin = origin === 'alert' ? 'alert' : row.origin === 'site' ? 'past' : row.origin;
    const reopen = row.state === 'handled' && fresh.length > 0 && !(origin === 'past' && opts.handled !== false);
    const openNow = origin === 'past' && opts.handled === false && row.state === 'handled';
    const state = reopen || openNow ? 'open' : row.state === 'open' && origin === 'past' && opts.handled !== false && row.origin === 'site' ? 'handled' : row.state;
    stmts.push(
      env.DB.prepare(
        'UPDATE security_breaches SET info = ?, origin = ?, level = ?, state = ?, handled_at = ?, updated_at = ?, info_checked_at = COALESCE(?, info_checked_at) WHERE name = ?',
      ).bind(
        JSON.stringify(better),
        newOrigin,
        levelOf(better),
        state,
        state === 'handled' ? (row.handled_at ?? t) : null,
        fresh.length || origin === 'alert' ? t : row.updated_at,
        infoFresh ? t : null,
        row.name,
      ),
    );
    if (origin === 'alert') stmts.push(eventStmt(env, row.name, t, 'alert', `Alert for ${who(hits)}`, opts.mailId ?? null));
    else if (fresh.length) stmts.push(eventStmt(env, row.name, t, 'past', `Added from your past breaches: ${who(fresh)}`));
    if (reopen) stmts.push(eventStmt(env, row.name, t, 'reopened', 'Opened again: an address it didn’t have before'));
  }
  for (const h of hits) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO security_hits (breach_name, address, person, via, count, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(breach_name, address) DO UPDATE SET person = COALESCE(excluded.person, person), count = COALESCE(excluded.count, count)`,
      ).bind(info.name, h.address, h.person, h.via, h.count, t),
    );
  }
  await env.DB.batch(stmts);
}

// ---------- Mail to the alerts address ----------

/** Who an address belongs to: its watch entry, or "Me" for a newsletter address on the mail domain. */
function personFor(address: string, watch: WatchEntry[], mailDomain: string): string | null {
  const w = watchFor(address, watch);
  if (w?.person) return w.person;
  if (address.endsWith(`@${mailDomain}`) || address === `@${mailDomain}`) return 'Me';
  return null;
}

/** Works out which of your addresses an alert is about. */
function hitsFromAlert(
  env: Env,
  text: string,
  headerAddresses: string[],
  addresses: string[],
  count: number | null,
  watch: WatchEntry[],
): HitInput[] {
  const mailDomain = env.MAIL_DOMAIN.toLowerCase();
  const own = alertsAddress(env);
  const mine = (a: string) => a !== own && (!!watchFor(a, watch) || a.endsWith(`@${mailDomain}`));
  const found = [...new Set([...addresses, ...headerAddresses].filter(mine))];
  if (found.length) {
    return found.slice(0, 30).map((a): HitInput => {
      // Found through a whole-domain watch (or a newsletter address): a domain alert; else Notify me.
      const viaDomain = a.endsWith(`@${mailDomain}`) || !watchFor(a, watch)?.target.includes('@');
      return { address: a, person: personFor(a, watch, mailDomain), via: viaDomain ? 'domain' : 'alert', count: null };
    });
  }
  // A domain alert that only gives a count: one hit for the whole domain.
  const lower = text.toLowerCase();
  const domains = [...new Set([mailDomain, ...watch.filter((w) => !w.target.includes('@')).map((w) => w.target)])].filter((d) =>
    new RegExp(`(^|[^a-z0-9.-])${d.replace(/[.]/g, '\\.')}($|[^a-z0-9-])`).test(lower),
  );
  if (domains.length) return domains.map((d): HitInput => ({ address: `@${d}`, person: personFor(`@${d}`, watch, mailDomain), via: 'domain', count }));
  return [{ address: '', person: null, via: 'alert', count: null }];
}

/** The breaches an alert names, with HIBP's details where it can get them. */
async function breachesFromAlert(env: Env, text: string): Promise<{ info: BreachInfo; fresh: boolean }[]> {
  const parsed = parseHibpAlert(text);
  let names = parsed.names;
  if (!names.length && parsed.title) {
    // No link: HIBP alerts come out as it loads a breach, so it's most likely the newest one.
    const state = { ...NO_STATE, ...(await readJson<SecurityState>(env, STATE_KEY)) };
    const title = parsed.title.toLowerCase();
    names = [state.latest && state.latestTitle?.toLowerCase() === title ? state.latest : parsed.title.replace(/[^A-Za-z0-9]/g, '')].filter(Boolean) as string[];
  }
  const out: { info: BreachInfo; fresh: boolean }[] = [];
  for (const name of names.slice(0, 3)) {
    try {
      const info = await fetchBreach(name);
      if (info) out.push({ info, fresh: true });
      else if (!parsed.names.length) out.push({ info: bareBreach(name, parsed.title ?? name), fresh: false });
    } catch {
      out.push({ info: bareBreach(name, parsed.title ?? undefined), fresh: false });
    }
  }
  return out;
}

async function applyAlertMail(env: Env, mailId: string, text: string, headerAddresses: string[], t: number): Promise<string[]> {
  const settings = await loadSecuritySettings(env);
  const parsed = parseHibpAlert(text);
  const breaches = await breachesFromAlert(env, text);
  if (!breaches.length) return [];
  const hits = hitsFromAlert(env, text, headerAddresses, parsed.addresses, parsed.count, settings.watch);
  for (const b of breaches) await recordBreach(env, b.info, b.fresh, 'alert', hits, t, { mailId });
  const names = breaches.map((b) => b.info.name);
  await env.DB.prepare('UPDATE security_mail SET breaches = ? WHERE id = ?').bind(JSON.stringify(names), mailId).run();
  await refreshSecuritySummary(env);
  return names;
}

/**
 * Mail to alerts@ (anything), or mail from HIBP to any address. All of it is
 * kept for the Security page (sign-in codes and forwarding confirmations
 * included); only genuine HIBP alerts become breaches.
 */
export async function handleSecurityEmail(env: Env, headers: Headers, parsed: Parsed | null, fromEmail: string): Promise<void> {
  const t = now();
  const id = newId();
  const html = parsed?.html ?? null;
  const text = (parsed?.text ?? (html ? htmlToText(html) : '')).slice(0, BODY_MAX);
  // Links (breach pages) can be only in the HTML; keep their addresses for reading.
  const hrefs = html ? [...html.matchAll(/href="(https?:\/\/[^"]{1,300})"/gi)].map((m) => m[1]!).join('\n') : '';
  const subject = (parsed?.subject ?? headers.get('subject') ?? '').trim().slice(0, 300) || '(no subject)';
  const fromHibp = isHibpSender(fromEmail);
  const signIn = signInEmails(env).includes(fromEmail);
  const genuine = fromIsGenuine(headers, fromEmail);
  // A Notify me alert forwarded by hand from your own mailbox counts too.
  const forwardedByYou = signIn && genuine && /haveibeenpwned\.com/i.test(text + hrefs);
  await env.DB.prepare(
    'INSERT INTO security_mail (id, received_at, from_email, subject, body, genuine, from_hibp, breaches) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
  )
    .bind(id, t, fromEmail, subject, text, genuine || forwardedByYou ? 1 : 0, fromHibp || forwardedByYou ? 1 : 0)
    .run();
  if ((fromHibp && genuine) || forwardedByYou) {
    const headerAddresses = [
      ...(parsed?.to ?? []).map((a) => normalizeEmail(a.address)),
      ...(parsed?.cc ?? []).map((a) => normalizeEmail(a.address)),
      ...(headers.get('x-forwarded-for') ?? '').split(/[\s,]+/).map((a) => normalizeEmail(a)),
    ].filter((a): a is string => !!a);
    try {
      await applyAlertMail(env, id, `${subject}\n${text}\n${hrefs}`, headerAddresses, t);
    } catch (err) {
      console.error('breach alert could not be read', err instanceof Error ? err.message : 'unknown error');
    }
  }
  // Only the newest mail is kept.
  await env.DB.prepare(
    `DELETE FROM security_mail WHERE id IN (SELECT id FROM security_mail INDEXED BY security_mail_received ORDER BY received_at DESC LIMIT -1 OFFSET ${MAIL_KEEP})`,
  ).run();
  console.log('security mail received');
}

// ---------- Summary ----------

const RANK: Record<BreachLevel, number> = { high: 3, medium: 2, watch: 1, low: 0 };

export async function refreshSecuritySummary(env: Env): Promise<SecuritySummary> {
  const [settings, open, before] = await Promise.all([
    loadSecuritySettings(env),
    env.DB.prepare("SELECT * FROM security_breaches INDEXED BY security_breaches_state WHERE state = 'open' ORDER BY updated_at DESC").all<BreachRow>(),
    readJson<SecuritySummary>(env, SUMMARY_KEY),
  ]);
  const counting = open.results.filter((b) => b.level !== 'watch' || settings.siteWatch);
  const top = [...counting].sort((a, b) => RANK[b.level] - RANK[a.level] || b.updated_at - a.updated_at)[0];
  let who = '';
  if (top) {
    if (top.level === 'watch') who = 'a site you get mail from';
    else {
      const hits = await env.DB.prepare('SELECT * FROM security_hits WHERE breach_name = ? ORDER BY seen_at').bind(top.name).all<HitRow>();
      who = describeWho(hits.results, settings.watch, env.MAIL_DOMAIN.toLowerCase());
    }
  }
  const topInfo = top ? json<BreachInfo>(top.info, bareBreach(top.name)) : null;
  const anything = settings.watch.length > 0 || open.results.length > 0;
  const level: SecuritySummary['level'] = !anything ? 'off' : top ? top.level : 'ok';
  const bannerWorthy = counting.some((b) => b.level === 'high' || b.level === 'medium' || b.level === 'watch' || settings.bannerLow);
  const summary: SecuritySummary = {
    level,
    open: counting.length,
    top: top && topInfo ? { title: topInfo.title, who, leaked: leakedPhrase(topInfo.dataClasses), level: top.level } : null,
    banner: settings.banner && bannerWorthy,
  };
  if (JSON.stringify(summary) !== JSON.stringify(before)) await writeJson(env, SUMMARY_KEY, summary);
  return summary;
}

/** "Your Gmail address", "your address for 2 newsletters", "Sam's address"... for the banner. */
function describeWho(hits: HitRow[], watch: WatchEntry[], mailDomain: string): string {
  if (!hits.length) return 'one of your addresses';
  const h = hits[0]!;
  const person = h.person && !/^me$/i.test(h.person) ? `${h.person}’s` : 'your';
  const more = hits.length > 1 ? ` and ${hits.length - 1} more` : '';
  if (!h.address) return `one of your addresses${more}`;
  if (h.address.startsWith('@')) return `addresses on ${h.address.slice(1)}${more}`;
  const domain = h.address.split('@')[1] ?? '';
  if (domain === mailDomain) return `${person} newsletter address ${h.address}${more}`;
  const provider = /gmail|googlemail/.test(domain) ? 'Gmail' : /hotmail|outlook|live\.|msn/.test(domain) ? 'Hotmail' : /yahoo/.test(domain) ? 'Yahoo' : /icloud|me\.com|mac\.com/.test(domain) ? 'iCloud' : null;
  const w = watchFor(h.address, watch);
  if (provider && (!w || w.target === h.address)) return `${person} ${provider} address${more}`;
  return `${person} address ${h.address}${more}`;
}

// ---------- Hourly checks ----------

/** Sources whose sender or website is on a breached site's domain. */
async function sourcesOn(env: Env, domain: string): Promise<{ id: string; name: string }[]> {
  if (!DOMAIN_RE.test(domain)) return [];
  const rows = await env.DB.prepare(
    `SELECT id, name FROM sources
     WHERE sender_email LIKE ?1 OR sender_email LIKE ?2 OR url LIKE ?3 OR url LIKE ?4 OR feed_url LIKE ?3 OR feed_url LIKE ?4
     ORDER BY name LIMIT 10`,
  )
    .bind(`%@${domain}`, `%.${domain}`, `%://${domain}/%`, `%.${domain}/%`)
    .all<{ id: string; name: string }>();
  // The LIKE patterns use the domain as typed; also catch "https://domain" with no path.
  const bare = await env.DB.prepare('SELECT id, name FROM sources WHERE url = ?1 OR url = ?2 LIMIT 5')
    .bind(`https://${domain}`, `https://www.${domain}`)
    .all<{ id: string; name: string }>();
  const all = new Map<string, { id: string; name: string }>();
  for (const r of [...rows.results, ...bare.results]) all.set(r.id, r);
  return [...all.values()];
}

async function checkLatest(env: Env, settings: SecuritySettings, state: SecurityState, t: number): Promise<SecurityState> {
  const info = breachFromHibp(await hibp('/latestbreach'));
  if (!info || info.name === state.latest) return { ...state, checkedAt: t, error: null };
  const row = await env.DB.prepare('SELECT * FROM security_breaches WHERE name = ?').bind(info.name).first<BreachRow>();
  if (row) {
    await applyInfo(env, row, info, t);
  } else if (settings.siteWatch && info.domain && !info.spamList && !info.fabricated) {
    const sources = await sourcesOn(env, info.domain);
    if (sources.length) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO security_breaches (name, info, origin, level, state, first_seen_at, updated_at, handled_at, viewed_at, todo_done, site_sources, info_checked_at)
           VALUES (?, ?, 'site', 'watch', 'open', ?, ?, NULL, NULL, NULL, ?, ?)`,
        ).bind(info.name, JSON.stringify(info), t, t, JSON.stringify(sources), t),
        eventStmt(env, info.name, t, 'announced', `Announced. You get mail from ${sources.map((s) => s.name).join(', ')}, so it was flagged as a site you use.`),
      ]);
    }
  }
  return { latest: info.name, latestTitle: info.title, checkedAt: t, error: null };
}

/** Re-reads HIBP's details for a few listed breaches, oldest first, so changes show up. */
async function refreshDetails(env: Env, t: number): Promise<void> {
  const due = await env.DB.prepare(
    'SELECT * FROM security_breaches INDEXED BY security_breaches_info WHERE info_checked_at IS NULL OR info_checked_at < ? ORDER BY COALESCE(info_checked_at, 0) LIMIT ?',
  )
    .bind(t - 7 * DAY, REFRESH_PER_RUN)
    .all<BreachRow>();
  for (const row of due.results) {
    try {
      const info = await fetchBreach(row.name);
      if (info) await applyInfo(env, row, info, t);
      else await env.DB.prepare('UPDATE security_breaches SET info_checked_at = ? WHERE name = ?').bind(t, row.name).run();
    } catch {
      // Try again next week rather than every hour.
      await env.DB.prepare('UPDATE security_breaches SET info_checked_at = ? WHERE name = ?').bind(t - 6 * DAY, row.name).run();
    }
  }
}

/** Hourly cron: the newest breach, a few detail refreshes, then the summary. Idle until something is watched. */
export async function runSecurityChecks(env: Env): Promise<void> {
  const settings = await loadSecuritySettings(env);
  if (!settings.watch.length) return;
  const t = now();
  let state = { ...NO_STATE, ...(await readJson<SecurityState>(env, STATE_KEY)) };
  try {
    state = await checkLatest(env, settings, state, t);
  } catch (err) {
    state = { ...state, checkedAt: t, error: err instanceof Error ? err.message.slice(0, 200) : 'Could not reach Have I Been Pwned' };
  }
  await writeJson(env, STATE_KEY, state);
  await refreshDetails(env, t);
  await refreshSecuritySummary(env);
}

// ---------- Views ----------

async function sourcesForAddresses(env: Env, addresses: string[]): Promise<Map<string, { addressId: string; sources: { id: string; name: string }[] }>> {
  const mailDomain = env.MAIL_DOMAIN.toLowerCase();
  const locals = [...new Set(addresses.filter((a) => a.endsWith(`@${mailDomain}`)).map((a) => a.split('@')[0]!))].slice(0, 90);
  const out = new Map<string, { addressId: string; sources: { id: string; name: string }[] }>();
  if (!locals.length) return out;
  const rows = await env.DB.prepare(
    `SELECT a.local_part AS local, a.id AS address_id, s.id AS source_id, s.name AS source_name
     FROM addresses a LEFT JOIN sources s ON s.address_id = a.id
     WHERE a.local_part IN (${locals.map(() => '?').join(', ')})`,
  )
    .bind(...locals)
    .all<{ local: string; address_id: string; source_id: string | null; source_name: string | null }>();
  for (const r of rows.results) {
    const key = `${r.local}@${mailDomain}`;
    const entry = out.get(key) ?? { addressId: r.address_id, sources: [] };
    if (r.source_id && r.source_name && entry.sources.length < 5) entry.sources.push({ id: r.source_id, name: r.source_name });
    out.set(key, entry);
  }
  return out;
}

async function toBreaches(env: Env, rows: BreachRow[]): Promise<SecurityBreach[]> {
  if (!rows.length) return [];
  const names = rows.map((r) => r.name);
  const hits: HitRow[] = [];
  for (let i = 0; i < names.length; i += 90) {
    const part = names.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT * FROM security_hits WHERE breach_name IN (${part.map(() => '?').join(', ')}) ORDER BY seen_at`)
      .bind(...part)
      .all<HitRow>();
    hits.push(...r.results);
  }
  const aliases = await sourcesForAddresses(env, hits.map((h) => h.address));
  const byBreach = new Map<string, BreachHit[]>();
  for (const h of hits) {
    const alias = aliases.get(h.address);
    const list = byBreach.get(h.breach_name) ?? [];
    list.push({ address: h.address, person: h.person, via: h.via, seenAt: h.seen_at, count: h.count, addressId: alias?.addressId ?? null, sources: alias?.sources ?? [] });
    byBreach.set(h.breach_name, list);
  }
  return rows.map((r) => ({
    name: r.name,
    info: json<BreachInfo>(r.info, bareBreach(r.name)),
    origin: r.origin,
    level: r.level,
    state: r.state,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    handledAt: r.handled_at,
    unseen: r.viewed_at === null || r.updated_at > r.viewed_at,
    hits: byBreach.get(r.name) ?? [],
    todoDone: json<string[]>(r.todo_done, []),
    siteSources: json<{ id: string; name: string }[]>(r.site_sources, []),
  }));
}

const toMail = (m: MailRow): SecurityMail => ({
  id: m.id,
  receivedAt: m.received_at,
  from: m.from_email,
  subject: m.subject,
  genuine: m.genuine === 1,
  fromHibp: m.from_hibp === 1,
  breaches: json<string[]>(m.breaches, []),
});

async function securityView(env: Env): Promise<SecurityView> {
  const [settings, open, history, mail, state, summary] = await Promise.all([
    loadSecuritySettings(env),
    env.DB.prepare("SELECT * FROM security_breaches INDEXED BY security_breaches_state WHERE state = 'open' ORDER BY updated_at DESC").all<BreachRow>(),
    env.DB.prepare("SELECT * FROM security_breaches WHERE state = 'handled'").all<BreachRow>(),
    env.DB.prepare(
      'SELECT id, received_at, from_email, subject, genuine, from_hibp, breaches FROM security_mail INDEXED BY security_mail_received ORDER BY received_at DESC LIMIT 20',
    ).all<MailRow>(),
    readJson<SecurityState>(env, STATE_KEY),
    readJson<SecuritySummary>(env, SUMMARY_KEY),
  ]);
  const openList = (await toBreaches(env, open.results)).filter((b) => b.level !== 'watch' || settings.siteWatch);
  // History: newest breach first (when it happened, else when it was added).
  const when = (b: SecurityBreach) => (b.info.breachDate ? Date.parse(b.info.breachDate) : (b.info.addedAt ?? b.firstSeenAt));
  const historyList = (await toBreaches(env, history.results)).sort((a, b) => when(b) - when(a));
  return {
    summary: summary ?? NO_SECURITY,
    open: openList.sort((a, b) => RANK[b.level] - RANK[a.level] || b.updatedAt - a.updatedAt),
    history: historyList,
    mail: mail.results.map(toMail),
    watching: settings.watch.length,
    alertsAddress: alertsAddress(env),
    lastCheckAt: state?.checkedAt ?? null,
    checkError: state?.error ?? null,
  };
}

async function settingsView(env: Env): Promise<SecuritySettingsView> {
  const [settings, hits, hibpMail, state] = await Promise.all([
    loadSecuritySettings(env),
    env.DB.prepare('SELECT breach_name, address, via, seen_at FROM security_hits').all<{ breach_name: string; address: string; via: HitVia; seen_at: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM security_mail WHERE from_hibp = 1').first<{ n: number }>(),
    readJson<SecurityState>(env, STATE_KEY),
  ]);
  const watch: WatchStatus[] = settings.watch.map((w) => {
    const mine = hits.results.filter((h) => !!h.address && watchFor(h.address, settings.watch)?.id === w.id);
    const alerts = mine.filter((h) => h.via !== 'past');
    return {
      ...w,
      kind: w.target.includes('@') ? 'address' : 'domain',
      lastAlertAt: alerts.length ? Math.max(...alerts.map((h) => h.seen_at)) : null,
      breaches: new Set(mine.map((h) => h.breach_name)).size,
    };
  });
  return {
    settings,
    watch,
    alertsAddress: alertsAddress(env),
    hibpMailSeen: (hibpMail?.n ?? 0) > 0,
    lastCheckAt: state?.checkedAt ?? null,
    checkError: state?.error ?? null,
  };
}

// ---------- API ----------

export function registerSecurity(app: App) {
  app.get('/api/security', async (c) => c.json(await securityView(c.env)));

  /** HIBP's whole public breach list, passed through untouched (no addresses in it) for Add past breaches. */
  app.get('/api/security/catalogue', async (c) => {
    const res = await fetch(`${API}/breaches`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cf: { cacheTtl: 6 * 3600, cacheEverything: true },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return c.json({ error: `Have I Been Pwned answered ${res.status}` }, 502);
    }
    return new Response(res.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=3600' } });
  });

  app.post('/api/security/check', async (c) => {
    await runSecurityChecks(c.env);
    return c.json(await securityView(c.env));
  });

  app.get('/api/security/breaches/:name', async (c) => {
    const name = c.req.param('name');
    const row = await c.env.DB.prepare('SELECT * FROM security_breaches WHERE name = ?').bind(name).first<BreachRow>();
    if (!row) return c.json({ error: 'That breach isn’t listed' }, 404);
    const [breach] = await toBreaches(c.env, [row]);
    const events = await c.env.DB.prepare('SELECT at, kind, text, mail_id FROM security_events WHERE breach_name = ? ORDER BY at DESC, id DESC LIMIT 100')
      .bind(name)
      .all<{ at: number; kind: SecurityEvent['kind']; text: string; mail_id: string | null }>();
    await c.env.DB.prepare('UPDATE security_breaches SET viewed_at = ? WHERE name = ?').bind(now(), name).run();
    const page: SecurityBreachPage = {
      breach: breach!,
      events: events.results.map((e) => ({ at: e.at, kind: e.kind, text: e.text, mailId: e.mail_id })),
      seenBefore: row.viewed_at,
    };
    return c.json(page);
  });

  /** Handled / open again, and the to-do ticks. */
  app.put('/api/security/breaches/:name', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as { state?: unknown; todoDone?: unknown };
    const row = await c.env.DB.prepare('SELECT * FROM security_breaches WHERE name = ?').bind(name).first<BreachRow>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    if (Array.isArray(body.todoDone)) {
      const done = [...new Set(body.todoDone.filter((k): k is string => typeof k === 'string').map((k) => k.slice(0, 60)))].slice(0, 30);
      stmts.push(c.env.DB.prepare('UPDATE security_breaches SET todo_done = ? WHERE name = ?').bind(JSON.stringify(done), name));
    }
    if ((body.state === 'handled' || body.state === 'open') && body.state !== row.state) {
      stmts.push(
        c.env.DB.prepare('UPDATE security_breaches SET state = ?, handled_at = ?, viewed_at = ? WHERE name = ?').bind(body.state, body.state === 'handled' ? t : null, t, name),
        eventStmt(c.env, name, t, body.state === 'handled' ? 'handled' : 'reopened', body.state === 'handled' ? 'Marked handled' : 'Opened again by you'),
      );
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    await refreshSecuritySummary(c.env);
    const updated = await c.env.DB.prepare('SELECT * FROM security_breaches WHERE name = ?').bind(name).first<BreachRow>();
    const [breach] = await toBreaches(c.env, [updated!]);
    return c.json(breach);
  });

  /** Take a breach off the list (e.g. one added by mistake). */
  app.delete('/api/security/breaches/:name', async (c) => {
    const name = c.req.param('name');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM security_hits WHERE breach_name = ?').bind(name),
      c.env.DB.prepare('DELETE FROM security_events WHERE breach_name = ?').bind(name),
      c.env.DB.prepare('DELETE FROM security_breaches WHERE name = ?').bind(name),
    ]);
    await refreshSecuritySummary(c.env);
    return c.json({ ok: true });
  });

  /** Add past breaches: your address and the breaches HIBP's website listed for it, picked from its public list. */
  app.post('/api/security/past', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown; person?: unknown; handled?: unknown; breaches?: unknown };
    let address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
    if (DOMAIN_RE.test(address)) address = `@${address}`;
    if (!(ADDRESS_RE.test(address) || (address.startsWith('@') && DOMAIN_RE.test(address.slice(1))))) return c.json({ error: 'Pick or type an email address' }, 400);
    const list = (Array.isArray(body.breaches) ? body.breaches : []).map(cleanBreachInfo).filter((b): b is BreachInfo => !!b).slice(0, 150);
    if (!list.length) return c.json({ error: 'Tick at least one breach' }, 400);
    const settings = await loadSecuritySettings(c.env);
    const person =
      typeof body.person === 'string' && body.person.trim() ? body.person.trim().slice(0, 40) : personFor(address, settings.watch, c.env.MAIL_DOMAIN.toLowerCase());
    const t = now();
    for (const info of list) {
      await recordBreach(c.env, info, info.dataClasses.length > 0, 'past', [{ address, person, via: 'past', count: null }], t, { handled: body.handled !== false });
    }
    await refreshSecuritySummary(c.env);
    return c.json({ added: list.length, view: await securityView(c.env) });
  });

  app.get('/api/security/mail/:id', async (c) => {
    const m = await c.env.DB.prepare('SELECT * FROM security_mail WHERE id = ?').bind(c.req.param('id')).first<MailRow>();
    if (!m) return c.json({ error: 'That email has been tidied away' }, 404);
    const page: SecurityMailPage = { ...toMail(m), text: m.body ?? '' };
    return c.json(page);
  });

  /** Read an email as an alert even though it couldn't be confirmed as from HIBP (you vouch for it). */
  app.post('/api/security/mail/:id/use', async (c) => {
    const m = await c.env.DB.prepare('SELECT * FROM security_mail WHERE id = ?').bind(c.req.param('id')).first<MailRow>();
    if (!m) return c.json({ error: 'not found' }, 404);
    const names = await applyAlertMail(c.env, m.id, `${m.subject}\n${m.body ?? ''}`, [], now());
    if (!names.length) return c.json({ error: 'No breach named in that email' }, 400);
    return c.json(await securityView(c.env));
  });

  app.delete('/api/security/mail/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM security_mail WHERE id = ?').bind(c.req.param('id')).run();
    return c.json(await securityView(c.env));
  });

  app.get('/api/security/settings', async (c) => c.json(await settingsView(c.env)));

  app.put('/api/security/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<SecuritySettings>;
    const settings = normalizeSecuritySettings(body, await loadSecuritySettings(c.env));
    await writeJson(c.env, SETTINGS_KEY, settings);
    await refreshSecuritySummary(c.env);
    return c.json(await settingsView(c.env));
  });
}

