import type { Hono } from 'hono';
import {
  DEFAULT_STATUS_SETTINGS,
  FETCH_HEADERS,
  HOME_KINDS,
  HOME_RADIUS_KM,
  parseChorus,
  parseOneNz,
  parseVector,
  type ChorusIncident,
  type HomeArea,
  type OneNzOutageGroup,
  type VectorInput,
  NO_STATUS,
  STATUS_KEEP_DAYS,
  STATUS_KINDS,
  STATUS_MIN_MINUTES,
  hashText,
  matchesWords,
  parseStatus,
  similarImpact,
  type ParsedIncident,
  type ParsedStatus,
  type ServiceState,
  type StatusIncident,
  type StatusIncidentPage,
  type StatusKind,
  type StatusService,
  type StatusSettings,
  type StatusSettingsView,
  type StatusSummary,
  type StatusUpdate,
  type StatusView,
} from '@newsletterapp/shared';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';

// System status: service status pages (Apple, Google, Cloudflare, Microsoft 365...)
// checked by the Worker itself and kept as incidents, each with its updates, so an
// outage is one thing that changes rather than a pile of posts. Nothing goes to
// the inbox; a small summary (read with the inbox counts) drives the Status button
// and the banner.
//
// Checks: hourly while a service is fine, every 15 minutes while it has an open
// incident, a few services per cron run so the free plan's per-run limits hold.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const MIN = 60_000;
const DAY = 86_400_000;
const SETTINGS_KEY = 'status_settings';
const SUMMARY_KEY = 'status_summary';
/** Fetches a cron run may spend on status pages (the free plan allows 50 per run, feeds use some). */
const FETCH_BUDGET = 14;
/** Fetches one check of each kind costs. */
const FETCH_COST: Partial<Record<StatusKind, number>> = { onenz: 4, vector: 5, chorus: 2 };
/** An open incident nobody has updated for this long is taken as over. */
const STALE_OPEN = 14 * DAY;
const MAX_BYTES = 3_000_000;

interface ServiceRow {
  id: string;
  name: string;
  kind: StatusKind;
  feed_url: string;
  page_url: string | null;
  enabled: number;
  only_words: string | null;
  custom: number;
  sort: number;
  checked_at: number | null;
  next_check_at: number | null;
  error: string | null;
}

interface IncidentRow {
  id: string;
  service_id: string;
  ext_key: string;
  grp: string | null;
  title: string;
  state: 'open' | 'resolved';
  level: 'minor' | 'major';
  components: string | null;
  url: string | null;
  next_update: string | null;
  latest: string | null;
  started_at: number;
  updated_at: number;
  resolved_at: number | null;
  fp: string | null;
  updates: number;
  viewed_at: number | null;
}

const words = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
};

// ---------- Settings ----------

function normalizeHome(input: unknown, base: HomeArea | null): HomeArea | null {
  if (input === null) return null;
  if (!input || typeof input !== 'object') return base;
  const h = input as Partial<HomeArea>;
  const lat = Number(h.lat);
  const lng = Number(h.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return base;
  return {
    label: typeof h.label === 'string' ? h.label.trim().slice(0, 60) : '',
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    radiusKm: HOME_RADIUS_KM.includes(h.radiusKm as number) ? (h.radiusKm as number) : (base?.radiusKm ?? 5),
  };
}

export function normalizeStatusSettings(input: Partial<StatusSettings>, base: StatusSettings = DEFAULT_STATUS_SETTINGS): StatusSettings {
  return {
    banner: typeof input.banner === 'boolean' ? input.banner : base.banner,
    minMinutes: STATUS_MIN_MINUTES.includes(input.minMinutes as number) ? (input.minMinutes as number) : base.minMinutes,
    keepDays: STATUS_KEEP_DAYS.includes(input.keepDays as number) ? (input.keepDays as number) : base.keepDays,
    home: 'home' in input ? normalizeHome(input.home, base.home) : (base.home ?? null),
  };
}

export async function loadStatusSettings(env: Env): Promise<StatusSettings> {
  return normalizeStatusSettings((await readJson<Partial<StatusSettings>>(env, SETTINGS_KEY)) ?? {});
}

/** The summary the inbox reads with its counts. */
export function parseSummary(raw: string | null | undefined): StatusSummary {
  if (!raw) return NO_STATUS;
  try {
    return { ...NO_STATUS, ...(JSON.parse(raw) as Partial<StatusSummary>) };
  } catch {
    return NO_STATUS;
  }
}

// ---------- Checking ----------

async function fetchStatus(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`The status page answered ${res.status}`);
  }
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    throw new Error('The status feed is too big');
  }
  return (await res.text()).slice(0, MAX_BYTES);
}

async function fetchJson<T>(url: string, init: { headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'User-Agent': FETCH_HEADERS['User-Agent'] ?? 'Mozilla/5.0', Accept: 'application/json, */*;q=0.8', ...init.headers },
    body: init.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  }
  const text = (await res.text()).slice(0, MAX_BYTES);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${new URL(url).hostname} didn’t send data`);
  }
}

async function fetchConfigText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { ...FETCH_HEADERS }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  }
  return (await res.text()).slice(0, 500_000);
}

const ONENZ_GRAPHQL = 'https://api.public.one.nz/vf/public/brightspot-delivery-graphql-rest/delivery/graphql';

/**
 * Home outages: each provider's own outage map reads these, with the access
 * details its page hands every visitor (read fresh each time, so a change on
 * their side doesn't break the check).
 */
async function readHome(kind: StatusKind, home: HomeArea, t: number): Promise<ParsedStatus> {
  if (kind === 'onenz') {
    const config = await fetchJson<{ outages?: { label?: string; cmsId?: string }[] }>('https://one.nz/getconfigvalues/outage-config.json');
    const groups: OneNzOutageGroup[] = [];
    for (const o of (config.outages ?? []).slice(0, 4)) {
      if (!o.cmsId || !/^[\w-]+$/.test(o.cmsId)) continue;
      const query = `{ outage:vodafonenz_networkoutage_NetworkOutageView(id:"${o.cmsId}") { name outageType items { ... on vodafonenz_networkoutage_NetworkOutageItemView { createdDate description etaFix location locations status } } } }`;
      const r = await fetchJson<{ data?: { outage?: { outageType?: string; items?: OneNzOutageGroup['items'] } | null } }>(ONENZ_GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      groups.push({ label: o.label ?? r.data?.outage?.outageType ?? 'Network', items: r.data?.outage?.items ?? [] });
    }
    return parseOneNz(groups, home, t);
  }
  if (kind === 'chorus') {
    const config = await fetchJson<{ OUTAGES?: { HOST?: string; AUTH?: string } }>('https://www.chorus.co.nz/config.json');
    const host = config.OUTAGES?.HOST;
    const auth = config.OUTAGES?.AUTH;
    if (!host || !auth || !/^https:\/\/[\w.-]+\.chorus\.co\.nz\//.test(host)) throw new Error('Chorus changed how its outage map is set up');
    const list = await fetchJson<ChorusIncident[]>(`${host.replace(/\/$/, '')}/incidents?includePolygons=false`, {
      headers: { Authorization: auth, 'Accept-Encoding': 'gzip' },
    });
    return parseChorus(Array.isArray(list) ? list : [], home, t);
  }
  if (kind === 'vector') {
    const js = await fetchConfigText('https://help.vector.co.nz/config.js');
    const val = (name: string) => new RegExp(`(?:^|[\\s{,])${name}\\s*:\\s*["']([^"']+)["']`).exec(js)?.[1] ?? null;
    const base = val('apiBaseUrl');
    const key = val('apikey');
    const centre = val('outageCentreBaseUrl');
    const centreKey = val('outageCentreApikey');
    const ok = (u: string | null) => !!u && /^https:\/\/[\w.-]+\.vector\.co\.nz\//.test(u);
    if (!ok(base) || !key || !ok(centre) || !centreKey) throw new Error('Vector changed how its outage map is set up');
    const join = (b: string, path: string) => `${b.replace(/\/$/, '')}/${path}`;
    const [unplanned, plannedShapes, planned, alert] = await Promise.all([
      fetchJson<VectorInput['unplanned']>(join(base!, 'outagereporter/outages/shapes'), { headers: { apikey: key } }),
      fetchJson<VectorInput['plannedShapes']>(join(centre!, 'v1/outages/planned-outages/shapes'), { headers: { apikey: centreKey } }),
      fetchJson<VectorInput['planned']>(join(centre!, 'v1/outages/planned-outages/future'), { headers: { apikey: centreKey } }),
      fetchJson<VectorInput['alert']>(join(base!, 'outagereporter/lses'), { headers: { apikey: key } }).catch(() => null),
    ]);
    return parseVector({ unplanned, plannedShapes, planned: Array.isArray(planned) ? planned : [], alert }, home, t);
  }
  throw new Error('Not a home outage check');
}

function fingerprint(p: ParsedIncident): string {
  return hashText(
    JSON.stringify([p.title, p.resolved, p.level, p.nextUpdate, p.components, p.updates.map((u) => u.key), p.updates.length]),
  );
}

/** Stores what one status page says: new incidents, new updates, fixed ones. */
async function applyParsed(env: Env, svc: ServiceRow, parsed: ParsedStatus, t: number, keepDays: number): Promise<void> {
  const cutoff = t - keepDays * DAY;
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM status_incidents INDEXED BY status_incidents_recent WHERE service_id = ? AND (updated_at >= ? OR state = 'open')`,
    )
      .bind(svc.id, cutoff)
      .all<IncidentRow>()
  ).results;
  const byKey = new Map(rows.map((r) => [r.ext_key, r]));
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];

  for (const p of parsed.incidents) {
    if (p.maintenance) continue;
    let row = byKey.get(p.key);
    // Pages that post each update apart: join an open incident of the same thing.
    if (!row && p.group) {
      row = rows.find(
        (r) => r.state === 'open' && !seen.has(r.id) && r.grp && (svc.kind === 'aws' ? r.grp === p.group : similarImpact(r.grp, p.group!)),
      );
    }
    if (row) seen.add(row.id);
    if (!row && (p.updatedAt ?? t) < cutoff) continue;
    // An old fixed incident seen for the first time (a page's history) needn't be stored at all.
    if (!row && p.resolved && (p.updatedAt ?? t) < t - 7 * DAY) continue;
    const fp = fingerprint(p);
    if (row && row.fp === fp) continue;

    const newest = p.updates.reduce((a, u) => (u.at > a.at ? u : a), p.updates[0]!);
    const updatedAt = Math.max(p.updatedAt ?? newest.at, newest.at);
    const startedAt = Math.min(p.startedAt ?? updatedAt, row?.started_at ?? Infinity, ...p.updates.map((u) => u.at));
    const state = p.resolved ? 'resolved' : 'open';
    const resolvedAt = p.resolved ? (row?.resolved_at ?? updatedAt) : null;
    const id = row?.id ?? newId();
    if (row) {
      stmts.push(
        env.DB.prepare(
          `UPDATE status_incidents SET grp = ?, title = ?, state = ?, level = ?, components = ?, url = COALESCE(?, url), next_update = ?,
             latest = ?, started_at = ?, updated_at = ?, resolved_at = ?, fp = ? WHERE id = ?`,
        ).bind(p.group ?? row.grp, p.title, state, p.level, JSON.stringify(p.components), p.url, p.nextUpdate, newest.text, startedAt, updatedAt, resolvedAt, fp, id),
      );
    } else {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO status_incidents (id, service_id, ext_key, grp, title, state, level, components, url, next_update, latest, started_at, updated_at, resolved_at, fp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, svc.id, p.key, p.group ?? null, p.title, state, p.level, JSON.stringify(p.components), p.url, p.nextUpdate, newest.text, startedAt, updatedAt, resolvedAt, fp),
      );
    }
    for (const u of p.updates.slice(0, 100)) {
      stmts.push(
        env.DB.prepare('INSERT OR IGNORE INTO status_updates (incident_id, ukey, at, label, body) VALUES (?, ?, ?, ?, ?)').bind(
          id,
          u.key.slice(0, 300),
          u.at,
          u.label,
          u.text,
        ),
      );
    }
    stmts.push(env.DB.prepare('UPDATE status_incidents SET updates = (SELECT COUNT(*) FROM status_updates WHERE incident_id = ?1) WHERE id = ?1').bind(id));
  }

  // Pages that only list what's happening now: an open incident that has gone is over.
  if (parsed.complete) {
    for (const r of rows) {
      if (r.state !== 'open' || seen.has(r.id) || parsed.incidents.some((p) => p.key === r.ext_key)) continue;
      stmts.push(
        env.DB.prepare("UPDATE status_incidents SET state = 'resolved', resolved_at = ?, next_update = NULL, updated_at = ?, latest = ?, updates = updates + 1 WHERE id = ?").bind(
          t,
          t,
          'No longer listed on the status page.',
          r.id,
        ),
        env.DB.prepare('INSERT OR IGNORE INTO status_updates (incident_id, ukey, at, label, body) VALUES (?, ?, ?, ?, ?)').bind(
          r.id,
          `gone|${t}`,
          t,
          'Resolved',
          'No longer listed on the status page.',
        ),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function checkService(env: Env, svc: ServiceRow, settings: StatusSettings): Promise<void> {
  const t = now();
  const keepDays = settings.keepDays;
  try {
    let parsed: ParsedStatus;
    if (HOME_KINDS.includes(svc.kind)) {
      if (!settings.home) throw new Error('Set your home area in Settings > System status');
      parsed = await readHome(svc.kind, settings.home, t);
    } else {
      parsed = parseStatus(svc.kind, await fetchStatus(svc.feed_url), t);
    }
    await applyParsed(env, svc, parsed, t, keepDays);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM status_incidents INDEXED BY status_incidents_open WHERE state = 'open' AND service_id = ?")
      .bind(svc.id)
      .first<{ n: number }>();
    // Every 15 minutes while something is open, else hourly (a little early, to land on the next cron run).
    const next = t + ((open?.n ?? 0) > 0 ? 15 : 60) * MIN - 3 * MIN;
    await env.DB.prepare('UPDATE status_services SET checked_at = ?, next_check_at = ?, error = NULL WHERE id = ?').bind(t, next, svc.id).run();
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'Could not read the status page';
    await env.DB.prepare('UPDATE status_services SET checked_at = ?, next_check_at = ?, error = ? WHERE id = ?')
      .bind(t, t + 57 * MIN, message, svc.id)
      .run();
  }
}

/** Works out the summary the Status button and banner show, and stores it if it changed. */
export async function refreshStatusSummary(env: Env): Promise<StatusSummary> {
  const t = now();
  const [settings, services, open, before] = await Promise.all([
    loadStatusSettings(env),
    env.DB.prepare('SELECT * FROM status_services WHERE enabled = 1').all<ServiceRow>(),
    env.DB.prepare("SELECT * FROM status_incidents INDEXED BY status_incidents_open WHERE state = 'open'").all<IncidentRow>(),
    readJson<StatusSummary>(env, SUMMARY_KEY),
  ]);
  const byId = new Map(services.results.map((s) => [s.id, s]));
  const counting = open.results
    .filter((i) => countsFor(i, byId.get(i.service_id), settings, t))
    .sort((a, b) => b.updated_at - a.updated_at);
  const summary: StatusSummary = {
    level: services.results.length === 0 ? 'off' : counting.some((i) => i.level === 'major') ? 'major' : counting.length ? 'minor' : 'ok',
    open: counting.length,
    top: counting[0] ? { service: byId.get(counting[0].service_id)?.name ?? '', title: counting[0].title, since: counting[0].started_at } : null,
    banner: settings.banner,
  };
  if (JSON.stringify(summary) !== JSON.stringify(before)) await writeJson(env, SUMMARY_KEY, summary);
  return summary;
}

function countsFor(i: IncidentRow, svc: ServiceRow | undefined, settings: StatusSettings, t: number): boolean {
  if (!svc || svc.enabled !== 1 || i.state !== 'open') return false;
  if (t - i.started_at < settings.minMinutes * MIN) return false;
  return matchesWords(words(svc.only_words), i.title, words(i.components));
}

/** Cron: check the services that are due, then refresh the summary. Hourly: tidy old incidents. */
export async function runStatusChecks(env: Env, hourly: boolean): Promise<void> {
  const t = now();
  const settings = await loadStatusSettings(env);
  const due = await env.DB.prepare(
    'SELECT * FROM status_services WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY COALESCE(next_check_at, 0) LIMIT 12',
  )
    .bind(t)
    .all<ServiceRow>();
  let budget = FETCH_BUDGET;
  for (const svc of due.results) {
    const cost = FETCH_COST[svc.kind] ?? 1;
    if (cost > budget) continue;
    budget -= cost;
    await checkService(env, svc, settings);
  }
  if (hourly) {
    const cutoff = t - settings.keepDays * DAY;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE status_incidents SET state = 'resolved', resolved_at = updated_at, next_update = NULL WHERE state = 'open' AND updated_at < ?",
      ).bind(t - STALE_OPEN),
      env.DB.prepare(
        'DELETE FROM status_updates WHERE incident_id IN (SELECT id FROM status_incidents INDEXED BY status_incidents_resolved WHERE resolved_at < ?)',
      ).bind(cutoff),
      env.DB.prepare('DELETE FROM status_incidents WHERE resolved_at < ?').bind(cutoff),
    ]);
  }
  await refreshStatusSummary(env);
}

// ---------- Views ----------

function toService(r: ServiceRow, open: IncidentRow[], fixedAt: number | null, settings: StatusSettings, t: number): StatusService {
  const counting = open.filter((i) => i.service_id === r.id && countsFor(i, r, settings, t));
  const state: ServiceState =
    r.enabled !== 1 || r.checked_at === null
      ? 'unchecked'
      : counting.some((i) => i.level === 'major')
        ? 'major'
        : counting.length
          ? 'minor'
          : r.error
            ? 'error'
            : 'ok';
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    feedUrl: r.feed_url,
    pageUrl: r.page_url,
    enabled: r.enabled === 1,
    only: words(r.only_words),
    custom: r.custom === 1,
    checkedAt: r.checked_at,
    error: r.error,
    state,
    openCount: counting.length,
    lastFixedAt: fixedAt,
  };
}

function toIncident(r: IncidentRow, svc: ServiceRow | undefined, settings: StatusSettings, t: number): StatusIncident {
  return {
    id: r.id,
    serviceId: r.service_id,
    serviceName: svc?.name ?? r.service_id,
    title: r.title,
    state: r.state,
    level: r.level,
    components: words(r.components),
    url: r.url,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    latest: r.latest,
    nextUpdate: r.next_update,
    updates: r.updates,
    counts: countsFor(r, svc, settings, t),
    unseen: r.viewed_at === null || r.updated_at > r.viewed_at,
  };
}

async function statusView(env: Env): Promise<StatusView> {
  const t = now();
  const [settings, services, open, fixed, summary] = await Promise.all([
    loadStatusSettings(env),
    env.DB.prepare('SELECT * FROM status_services WHERE enabled = 1 ORDER BY sort, name').all<ServiceRow>(),
    env.DB.prepare("SELECT * FROM status_incidents INDEXED BY status_incidents_open WHERE state = 'open' ORDER BY updated_at DESC").all<IncidentRow>(),
    env.DB.prepare('SELECT * FROM status_incidents INDEXED BY status_incidents_resolved WHERE resolved_at >= ? ORDER BY resolved_at DESC LIMIT 60')
      .bind(t - 7 * DAY)
      .all<IncidentRow>(),
    readJson<StatusSummary>(env, SUMMARY_KEY),
  ]);
  const byId = new Map(services.results.map((s) => [s.id, s]));
  const fixedShown = fixed.results.filter((i) => {
    const s = byId.get(i.service_id);
    return s && matchesWords(words(s.only_words), i.title, words(i.components));
  });
  const lastFixed = new Map<string, number>();
  for (const i of fixedShown) if (i.resolved_at && !lastFixed.has(i.service_id)) lastFixed.set(i.service_id, i.resolved_at);
  const openRows = open.results.filter((i) => byId.has(i.service_id));
  const incidents = openRows.map((i) => toIncident(i, byId.get(i.service_id), settings, t));
  return {
    summary: summary ?? NO_STATUS,
    services: services.results.map((s) => toService(s, openRows, lastFixed.get(s.id) ?? null, settings, t)),
    open: incidents.filter((i) => i.counts),
    quiet: incidents.filter((i) => !i.counts),
    fixed: fixedShown.slice(0, 30).map((i) => toIncident(i, byId.get(i.service_id), settings, t)),
  };
}

async function settingsView(env: Env): Promise<StatusSettingsView> {
  const t = now();
  const [settings, services, open] = await Promise.all([
    loadStatusSettings(env),
    env.DB.prepare('SELECT * FROM status_services ORDER BY sort, name').all<ServiceRow>(),
    env.DB.prepare("SELECT * FROM status_incidents INDEXED BY status_incidents_open WHERE state = 'open'").all<IncidentRow>(),
  ]);
  return { settings, services: services.results.map((s) => toService(s, open.results, null, settings, t)) };
}

function cleanWords(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  return [...new Set(list.filter((w): w is string => typeof w === 'string').map((w) => w.trim().slice(0, 60)).filter(Boolean))].slice(0, 40);
}

/** A custom service: a status feed address, or a Statuspage site's front page. */
async function discoverCustom(url: string): Promise<{ kind: StatusKind; feedUrl: string }> {
  const host = new URL(url).hostname;
  const known: [RegExp, StatusKind][] = [
    [/(^|\.)status\.aws\.amazon\.com$/, 'aws'],
    [/azure\.status\.microsoft$/, 'azure'],
    [/status\.cloud\.microsoft$/, 'm365'],
    [/(^|\.)google\.com$/, 'google'],
  ];
  const kind = known.find(([re]) => re.test(host))?.[1] ?? 'statuspage';
  const tries = [url];
  if (kind === 'statuspage' && !/\.(rss|atom|xml)$|\/feed\/?$/i.test(new URL(url).pathname)) {
    const root = new URL(url).origin;
    tries.push(`${root}/history.rss`, `${root}/history.atom`);
  }
  let lastError: unknown = null;
  for (const u of tries) {
    try {
      parseStatus(kind, await fetchStatus(u));
      return { kind, feedUrl: u };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No status feed found there');
}

export function registerStatus(app: App) {
  app.get('/api/status', async (c) => c.json(await statusView(c.env)));

  app.get('/api/status/incidents/:id', async (c) => {
    const t = now();
    const row = await c.env.DB.prepare('SELECT * FROM status_incidents WHERE id = ?').bind(c.req.param('id')).first<IncidentRow>();
    if (!row) return c.json({ error: 'That incident has been tidied away' }, 404);
    const [svc, updates, settings] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM status_services WHERE id = ?').bind(row.service_id).first<ServiceRow>(),
      c.env.DB.prepare('SELECT at, label, body FROM status_updates WHERE incident_id = ? ORDER BY at DESC, id DESC LIMIT 200')
        .bind(row.id)
        .all<{ at: number; label: string | null; body: string }>(),
      loadStatusSettings(c.env),
    ]);
    if (!svc) return c.json({ error: 'not found' }, 404);
    await c.env.DB.prepare('UPDATE status_incidents SET viewed_at = ? WHERE id = ?').bind(t, row.id).run();
    const page: StatusIncidentPage = {
      incident: toIncident(row, svc, settings, t),
      service: toService(svc, row.state === 'open' ? [row] : [], null, settings, t),
      updates: updates.results.map((u): StatusUpdate => ({ at: u.at, label: u.label, text: u.body })),
      seenBefore: row.viewed_at,
    };
    return c.json(page);
  });

  app.get('/api/status/settings', async (c) => c.json(await settingsView(c.env)));

  app.put('/api/status/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<StatusSettings>;
    const before = await loadStatusSettings(c.env);
    const settings = normalizeStatusSettings(body, before);
    await writeJson(c.env, SETTINGS_KEY, settings);
    // A new home area: the home checks run again on the next cron run.
    if (JSON.stringify(settings.home) !== JSON.stringify(before.home)) {
      await c.env.DB.prepare(`UPDATE status_services SET next_check_at = NULL WHERE kind IN (${HOME_KINDS.map(() => '?').join(', ')})`)
        .bind(...HOME_KINDS)
        .run();
    }
    await refreshStatusSummary(c.env);
    return c.json(await settingsView(c.env));
  });

  app.put('/api/status/services/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; only?: unknown; name?: unknown };
    const svc = await c.env.DB.prepare('SELECT * FROM status_services WHERE id = ?').bind(id).first<ServiceRow>();
    if (!svc) return c.json({ error: 'not found' }, 404);
    const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : svc.enabled;
    const only = body.only !== undefined ? JSON.stringify(cleanWords(body.only)) : svc.only_words;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : svc.name;
    // Switched on: check it on the next run.
    const next = enabled === 1 && svc.enabled !== 1 ? null : svc.next_check_at;
    await c.env.DB.prepare('UPDATE status_services SET enabled = ?, only_words = ?, name = ?, next_check_at = ? WHERE id = ?')
      .bind(enabled, only, name, next, id)
      .run();
    await refreshStatusSummary(c.env);
    return c.json(await settingsView(c.env));
  });

  app.post('/api/status/services', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; url?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    let url = typeof body.url === 'string' ? body.url.trim() : '';
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      return c.json({ error: 'That doesn’t look like a web address' }, 400);
    }
    if (!name) return c.json({ error: 'Give it a name' }, 400);
    let found: { kind: StatusKind; feedUrl: string };
    try {
      found = await discoverCustom(url);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'No status feed found there' }, 400);
    }
    const dup = await c.env.DB.prepare('SELECT name FROM status_services WHERE feed_url = ?').bind(found.feedUrl).first<{ name: string }>();
    if (dup) return c.json({ error: `Already followed as ${dup.name}` }, 409);
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO status_services (id, name, kind, feed_url, page_url, enabled, only_words, custom, sort, created_at) VALUES (?, ?, ?, ?, ?, 1, NULL, 1, 500, ?)',
    )
      .bind(id, name, found.kind, found.feedUrl, new URL(found.feedUrl).origin + '/', now())
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM status_services WHERE id = ?').bind(id).first<ServiceRow>();
    if (row) await checkService(c.env, row, await loadStatusSettings(c.env));
    await refreshStatusSummary(c.env);
    return c.json(await settingsView(c.env));
  });

  app.delete('/api/status/services/:id', async (c) => {
    const id = c.req.param('id');
    const svc = await c.env.DB.prepare('SELECT custom FROM status_services WHERE id = ?').bind(id).first<{ custom: number }>();
    if (!svc) return c.json({ error: 'not found' }, 404);
    if (svc.custom !== 1) return c.json({ error: 'Built-in services can be switched off, not removed' }, 400);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM status_updates WHERE incident_id IN (SELECT id FROM status_incidents WHERE service_id = ?)').bind(id),
      c.env.DB.prepare('DELETE FROM status_incidents WHERE service_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM status_services WHERE id = ?').bind(id),
    ]);
    await refreshStatusSummary(c.env);
    return c.json(await settingsView(c.env));
  });

  /** Check now: every followed service, straight away. */
  app.post('/api/status/check', async (c) => {
    const settings = await loadStatusSettings(c.env);
    const services = await c.env.DB.prepare('SELECT * FROM status_services WHERE enabled = 1 ORDER BY sort LIMIT 20').all<ServiceRow>();
    await Promise.all(services.results.map((s) => checkService(c.env, s, settings)));
    await refreshStatusSummary(c.env);
    return c.json(await statusView(c.env));
  });
}

export const isStatusKind = (k: string): k is StatusKind => (STATUS_KINDS as string[]).includes(k);
