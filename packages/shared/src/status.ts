// System status: service status pages (Apple, Google, Cloudflare, Microsoft 365...)
// read into incidents, each with its updates, instead of one inbox item per post.
// The readers here are pure (text in, incidents out); the Worker stores them.

import { articleText, decodeEntities, stripTags } from './web';

/** How each status page publishes. */
export type StatusKind =
  /** Atlassian Statuspage history feed (GitHub, Cloudflare, Claude, Dropbox, Reddit...): one item per incident, updates inside. */
  | 'statuspage'
  /** Google Workspace / Google Cloud Atom feed: one entry per incident, rewritten as it changes. */
  | 'google'
  /** Microsoft 365 public status RSS: a new item for every update, only current ones listed. */
  | 'm365'
  /** Azure status RSS: only incidents happening now. */
  | 'azure'
  /** AWS all-services RSS: a new item for every update, months of history. */
  | 'aws'
  /** Apple's system status data (JSON, not a feed). */
  | 'apple';

export const STATUS_KINDS: StatusKind[] = ['statuspage', 'google', 'm365', 'azure', 'aws', 'apple'];

export type StatusLevel = 'minor' | 'major';
/** A service's state on the status page: fine, a problem, a bigger outage, or not read yet / failing. */
export type ServiceState = 'ok' | StatusLevel | 'unchecked' | 'error';

export interface StatusSettings {
  /** The inbox banner while something is broken. */
  banner: boolean;
  /** Problems younger than this many minutes don't light the button or show the banner yet (0 = straight away). */
  minMinutes: number;
  /** Fixed incidents are kept this many days. */
  keepDays: number;
}

export const DEFAULT_STATUS_SETTINGS: StatusSettings = { banner: true, minMinutes: 0, keepDays: 30 };
export const STATUS_MIN_MINUTES = [0, 15, 30, 60];
export const STATUS_KEEP_DAYS = [7, 30, 90];

/** Kept up to date by the Worker after each check; read with the inbox counts. */
export interface StatusSummary {
  /** 'off' when no service is followed. */
  level: 'ok' | StatusLevel | 'off';
  /** Open problems that count (followed service, matching its words, older than minMinutes). */
  open: number;
  /** The newest of them, for the banner. */
  top: { service: string; title: string; since: number } | null;
  /** Whether the banner is switched on. */
  banner: boolean;
}

export const NO_STATUS: StatusSummary = { level: 'off', open: 0, top: null, banner: false };

export interface StatusService {
  id: string;
  name: string;
  kind: StatusKind;
  feedUrl: string;
  pageUrl: string | null;
  enabled: boolean;
  /** Only incidents naming one of these (title or affected parts) count; empty = all. */
  only: string[];
  /** Added by hand (can be removed), not one of the built-in list. */
  custom: boolean;
  checkedAt: number | null;
  error: string | null;
  state: ServiceState;
  openCount: number;
  lastFixedAt: number | null;
}

export interface StatusIncident {
  id: string;
  serviceId: string;
  serviceName: string;
  title: string;
  state: 'open' | 'resolved';
  level: StatusLevel;
  components: string[];
  url: string | null;
  startedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** The newest update's text. */
  latest: string | null;
  /** E.g. "Friday, November 13, 2026, at 1:30 AM UTC" when the page promises one. */
  nextUpdate: string | null;
  updates: number;
  /** Shown (counts) under the service's words and the wait; hidden ones are listed apart. */
  counts: boolean;
  /** Updates came in since the incident was last opened. */
  unseen: boolean;
}

export interface StatusUpdate {
  at: number;
  label: string | null;
  text: string;
}

export interface StatusView {
  summary: StatusSummary;
  services: StatusService[];
  open: StatusIncident[];
  /** Fixed in the last 7 days. */
  fixed: StatusIncident[];
  /** Open but not counted (outside a service's words, or too new). */
  quiet: StatusIncident[];
}

export interface StatusIncidentPage {
  incident: StatusIncident;
  service: StatusService;
  updates: StatusUpdate[];
  /** When it was opened before this visit; updates after it are new. */
  seenBefore: number | null;
}

export interface StatusSettingsView {
  settings: StatusSettings;
  services: StatusService[];
}

// ---------- Reading the pages ----------

export interface ParsedUpdate {
  /** Unique within the incident. */
  key: string;
  at: number;
  label: string | null;
  text: string;
}

export interface ParsedIncident {
  /** Stable id on the status page. */
  key: string;
  /**
   * For pages that post every update separately (Microsoft 365, AWS): what an
   * update has in common with earlier ones of the same incident, when its key
   * isn't known yet. AWS: the service and region; Microsoft: the user impact line.
   */
  group?: string;
  title: string;
  url: string | null;
  level: StatusLevel;
  resolved: boolean;
  startedAt: number | null;
  updatedAt: number | null;
  components: string[];
  nextUpdate: string | null;
  updates: ParsedUpdate[];
  /** Planned maintenance; skipped. */
  maintenance?: boolean;
}

export interface ParsedStatus {
  incidents: ParsedIncident[];
  /** The page lists everything happening now, so an open incident missing from it is over. */
  complete: boolean;
}

/** One element's text: CDATA unwrapped, or entities decoded once. */
function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  if (!m) return null;
  const inner = m[1] ?? '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return cdata ? (cdata[1] ?? '') : decodeEntities(inner);
}

function blocksOf(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?<\\/${name}>`, 'gi')) ?? [];
}

function atomHref(block: string): string | null {
  for (const t of block.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /rel\s*=\s*["']([^"']+)/i.exec(t)?.[1] ?? 'alternate';
    const href = /href\s*=\s*["']([^"']+)/i.exec(t)?.[1];
    if (href && rel === 'alternate') return decodeEntities(href);
  }
  return null;
}

function dateOf(raw: string | null): number | null {
  if (!raw) return null;
  // " Z" at the end (Microsoft) isn't understood everywhere.
  const t = Date.parse(raw.trim().replace(/\s+Z$/, ' GMT'));
  return Number.isFinite(t) ? t : null;
}

/** Short, stable fingerprint of a text. */
export function hashText(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

function firstSentence(s: string, n = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  return clip(m?.[1] ?? t, n);
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ZONES: Record<string, number> = { UTC: 0, GMT: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4, CET: 1, CEST: 2, BST: 1, IST: 5.5, JST: 9, AEST: 10, AEDT: 11, NZST: 12, NZDT: 13 };

/** "Nov 11, 20:26 UTC" (no year) as a time, taking the year from a nearby date. */
export function statuspageTime(s: string, near: number): number | null {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s*,?\s*(?:(\d{4})\s*-?\s*)?(\d{1,2}):(\d{2})\s*([A-Z]{2,4})?/.exec(s);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? '').toLowerCase()];
  if (month === undefined) return null;
  const offset = ZONES[m[6] ?? 'UTC'] ?? 0;
  const nearYear = new Date(near).getUTCFullYear();
  const at = (year: number) => Date.UTC(year, month, Number(m[2]), Number(m[4]), Number(m[5])) - offset * 3_600_000;
  if (m[3]) return at(Number(m[3]));
  // The nearby date is the incident's latest update; an update can't be more than a few days after it.
  const t = at(nearYear);
  return t > near + 3 * 86_400_000 ? at(nearYear - 1) : t;
}

const MAINTENANCE_LABELS = /^(scheduled|in progress|verifying|completed)$/i;
const RESOLVED_LABELS = /^(resolved|completed|postmortem)$/i;
const MAJOR_WORDS = /\b(outage|down|unavailable|unable to|cannot|can't|not loading|disruption)\b/i;

/** One Statuspage incident body: "<p><small>date</small><br><strong>Label</strong> - text</p>" per update, newest first. */
export function statuspageUpdates(html: string, near: number): { updates: ParsedUpdate[]; components: string[] } {
  const updates: ParsedUpdate[] = [];
  let components: string[] = [];
  const paras = html.match(/<p\b[\s\S]*?<\/p>/gi) ?? [html];
  for (const p of paras) {
    const small = /<small\b[^>]*>([\s\S]*?)<\/small>/i.exec(p)?.[1];
    const label = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(p)?.[1];
    const plain = articleText(p);
    const affected = /This (?:incident|maintenance|scheduled event) affected:\s*([^\n]+)/i.exec(plain);
    if (affected && !small) {
      components = affected[1]!
        .replace(/\.\s*$/, '')
        .split(/,\s*|\s+and\s+/)
        .map((c) => c.replace(/\s*\([^)]*\)\s*$/, '').trim())
        .filter(Boolean)
        .slice(0, 20);
      continue;
    }
    if (!small) continue;
    const at = statuspageTime(stripTags(small), near);
    if (at === null) continue;
    const labelText = label ? stripTags(label) : null;
    let text = articleText(p.replace(/<small\b[\s\S]*?<\/small>/i, '').replace(/<strong\b[\s\S]*?<\/strong>/i, ''));
    text = text.replace(/^\s*-\s*/, '').trim();
    updates.push({ key: `${at}|${labelText ?? ''}|${hashText(text).slice(0, 8)}`, at, label: labelText, text: clip(text, 4000) });
  }
  return { updates, components };
}

function parseStatuspage(body: string, now: number): ParsedStatus {
  const atom = /<feed[\s>]/i.test(body.slice(0, 3000));
  const incidents: ParsedIncident[] = [];
  for (const block of blocksOf(body, atom ? 'entry' : 'item')) {
    const title = clip(stripTags(tag(block, 'title') ?? ''), 300) || 'Incident';
    const url = atom ? atomHref(block) : (tag(block, 'link')?.trim() ?? null);
    const key = (tag(block, atom ? 'id' : 'guid')?.trim() || url || title).slice(0, 300);
    const html = (atom ? (tag(block, 'content') ?? tag(block, 'summary')) : tag(block, 'description')) ?? '';
    const near = dateOf(tag(block, atom ? 'updated' : 'pubDate')) ?? now;
    const { updates, components } = statuspageUpdates(html, near);
    const labels = updates.map((u) => u.label ?? '');
    const maintenance = /<maintenanceEndDate>/i.test(block) || labels.some((l) => MAINTENANCE_LABELS.test(l));
    const newest = updates.reduce<ParsedUpdate | null>((a, u) => (!a || u.at > a.at ? u : a), null);
    const oldest = updates.reduce<ParsedUpdate | null>((a, u) => (!a || u.at < a.at ? u : a), null);
    const resolved = labels.some((l) => RESOLVED_LABELS.test(l));
    incidents.push({
      key,
      title,
      url,
      level: MAJOR_WORDS.test(title) ? 'major' : 'minor',
      resolved,
      startedAt: oldest?.at ?? near,
      updatedAt: newest?.at ?? near,
      components,
      nextUpdate: null,
      updates: updates.length ? updates : [{ key: 'only', at: near, label: null, text: clip(articleText(html), 4000) || title }],
      maintenance,
    });
  }
  return { incidents, complete: false };
}

function parseGoogle(body: string, now: number): ParsedStatus {
  const incidents: ParsedIncident[] = [];
  for (const block of blocksOf(body, 'entry')) {
    const rawTitle = stripTags(tag(block, 'title') ?? '');
    const html = tag(block, 'content') ?? tag(block, 'summary') ?? '';
    const text = articleText(html).replace(/\*\*/g, '').replace(/^\s*(summary|description)\s*:\s*/i, '');
    const url = atomHref(block);
    const id = (tag(block, 'id') ?? '').trim();
    // The entry id changes its tail as the incident changes; the incident's own address doesn't.
    const key = (url || id.split('.')[0] || rawTitle).slice(0, 300);
    const updatedAt = dateOf(tag(block, 'updated')) ?? now;
    const resolved = /^\s*resolved\b/i.test(rawTitle) || /^\s*resolved\b/i.test(text);
    const cleaned = rawTitle
      .replace(/\*\*/g, '')
      .replace(/^\s*(resolved|update|updated|mitigated)\s*:\s*/i, '')
      .replace(/^\s*(summary|description)\s*:\s*/i, '');
    const products = /Affected (?:products?|services?|locations?)\s*:\s*([^\n]+)/i.exec(text)?.[1];
    const components = products ? products.split(/,\s*/).map((p) => clip(p, 60)).filter(Boolean).slice(0, 20) : [];
    const title = firstSentence(cleaned || text, 160) || 'Incident';
    incidents.push({
      key,
      title,
      url,
      level: MAJOR_WORDS.test(title) ? 'major' : 'minor',
      resolved,
      startedAt: dateOf(tag(block, 'published')) ?? updatedAt,
      updatedAt,
      components,
      nextUpdate: null,
      updates: [{ key: hashText(text), at: updatedAt, label: resolved ? 'Resolved' : 'Update', text: clip(text, 4000) || title }],
    });
  }
  return { incidents, complete: false };
}

const M365_SERVICES = [
  'Exchange Online', 'Outlook', 'Microsoft Teams', 'SharePoint Online', 'OneDrive', 'Copilot', 'Intune', 'Purview',
  'Power BI', 'Planner', 'To Do', 'Windows 365', 'Defender', 'Microsoft Entra', 'Universal Print', 'Microsoft 365 apps',
  'Microsoft 365 admin center',
];

/** Words in the user impact line, for telling updates of the same incident apart from another one. */
export function impactWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/\b(may|might|have|has|had|been|be|being|were|was|are|is|the|a|an|to|of|and|or|some|users|user)\b/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

export function similarImpact(a: string, b: string): boolean {
  const x = impactWords(a);
  const y = impactWords(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.5;
}

function m365Status(raw: string | null): { label: string; level: StatusLevel; resolved: boolean } {
  const s = (raw ?? '').trim();
  if (/restored|operational|resolved|falsepositive|postincident|closed/i.test(s)) return { label: 'Restored', level: 'minor', resolved: true };
  if (/interruption/i.test(s)) return { label: 'Interruption', level: 'major', resolved: false };
  if (/recovery/i.test(s)) return { label: 'Recovering', level: 'minor', resolved: false };
  if (/degradation/i.test(s)) return { label: 'Degraded', level: 'minor', resolved: false };
  return { label: s.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Update', level: 'minor', resolved: false };
}

function section(text: string, name: string): string | null {
  const re = new RegExp(
    `${name}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:User impact|More info|Current status|Previous status|Scope of impact|Root cause|Preliminary root cause|Next update(?: by)?|Start time|End time|Final status)\\s*:|$)`,
    'i',
  );
  const m = re.exec(text);
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : null;
}

function parseM365(body: string, now: number): ParsedStatus {
  // Oldest first, so updates of one incident join the first one.
  const items = blocksOf(body, 'item')
    .map((block) => {
      const html = tag(block, 'description') ?? '';
      const text = articleText(html);
      return {
        guid: (tag(block, 'guid') ?? '').trim(),
        at: dateOf(tag(block, 'pubDate')) ?? now,
        status: m365Status(tag(block, 'status')),
        text,
        impact: section(text, 'User impact') ?? firstSentence(text),
        current: section(text, 'Current status') ?? section(text, 'Final status'),
        next: section(text, 'Next update(?: by)?'),
        link: tag(block, 'link')?.trim() || null,
      };
    })
    .sort((a, b) => a.at - b.at);
  const incidents: ParsedIncident[] = [];
  for (const it of items) {
    const update: ParsedUpdate = { key: it.guid || hashText(it.text), at: it.at, label: it.status.label, text: clip(it.current ?? it.text, 4000) };
    const components = M365_SERVICES.filter((s) => it.text.toLowerCase().includes(s.toLowerCase()));
    const same = incidents.find((i) => !i.resolved && similarImpact(i.group ?? '', it.impact));
    if (same) {
      same.updates.push(update);
      same.updatedAt = it.at;
      same.resolved = it.status.resolved;
      if (!it.status.resolved) same.level = it.status.level;
      same.title = clip(it.impact, 200) || same.title;
      same.group = it.impact;
      same.nextUpdate = it.status.resolved ? null : it.next;
      same.components = [...new Set([...same.components, ...components])];
      continue;
    }
    incidents.push({
      key: update.key,
      group: it.impact,
      title: clip(it.impact, 200) || 'Microsoft 365 problem',
      url: it.link,
      level: it.status.level,
      resolved: it.status.resolved,
      startedAt: it.at,
      updatedAt: it.at,
      components,
      nextUpdate: it.status.resolved ? null : it.next,
      updates: [update],
    });
  }
  return { incidents, complete: true };
}

function parseAzure(body: string, now: number): ParsedStatus {
  const incidents: ParsedIncident[] = [];
  for (const block of blocksOf(body, 'item')) {
    const title = clip(stripTags(tag(block, 'title') ?? ''), 200) || 'Azure problem';
    const text = articleText(tag(block, 'description') ?? '');
    const at = dateOf(tag(block, 'pubDate')) ?? now;
    const key = ((tag(block, 'guid') ?? '').trim() || title).slice(0, 300);
    const resolved = /^\s*(mitigated|resolved)\b/i.test(title);
    incidents.push({
      key,
      title,
      url: tag(block, 'link')?.trim() || null,
      level: MAJOR_WORDS.test(title) ? 'major' : 'minor',
      resolved,
      startedAt: at,
      updatedAt: at,
      components: [],
      nextUpdate: null,
      updates: [{ key: hashText(text || title), at, label: resolved ? 'Mitigated' : 'Update', text: clip(text || title, 4000) }],
    });
  }
  return { incidents, complete: true };
}

const AWS_LABELS: [RegExp, string, StatusLevel][] = [
  [/^service is operating normally/i, 'Resolved', 'minor'],
  [/^service disruption/i, 'Disruption', 'major'],
  [/^increased error rates?/i, 'Errors', 'minor'],
  [/^performance issues?/i, 'Slow', 'minor'],
  [/^service impact/i, 'Impact', 'minor'],
  [/^informational message/i, 'Information', 'minor'],
];

/** "ec2-ap-northeast-1" → service "EC2", region "ap-northeast-1". */
export function awsService(key: string): { service: string; region: string | null } {
  const m = /^(.+?)-((?:[a-z]{2}(?:-gov)?-[a-z]+-\d)|global)$/.exec(key);
  const svc = m ? m[1]! : key;
  const name = svc === 'multipleservices' ? 'Multiple services' : svc.length <= 4 ? svc.toUpperCase() : svc.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => `${d ? ' ' : ''}${c.toUpperCase()}`);
  return { service: name, region: m ? m[2]! : null };
}

function parseAws(body: string, now: number): ParsedStatus {
  const items = blocksOf(body, 'item')
    .map((block) => {
      const guid = (tag(block, 'guid') ?? '').trim();
      const svcKey = /#([^_]+)_/.exec(guid)?.[1] ?? 'aws';
      const rawTitle = stripTags(tag(block, 'title') ?? '');
      const kind = AWS_LABELS.find(([re]) => re.test(rawTitle));
      return {
        guid,
        svcKey,
        at: dateOf(tag(block, 'pubDate')) ?? now,
        label: kind?.[1] ?? 'Update',
        level: kind?.[2] ?? 'minor',
        resolved: /^service is operating normally/i.test(rawTitle) || /\[resolved\]/i.test(rawTitle),
        title: rawTitle.replace(/^[^:]{3,40}:\s*/, '').replace(/\[resolved\]\s*/i, '').trim(),
        text: articleText(tag(block, 'description') ?? ''),
      };
    })
    .sort((a, b) => a.at - b.at);
  const incidents: ParsedIncident[] = [];
  const open = new Map<string, ParsedIncident>();
  for (const it of items) {
    const update: ParsedUpdate = { key: it.guid || hashText(it.text), at: it.at, label: it.label, text: clip(it.text || it.title, 4000) };
    let inc = open.get(it.svcKey);
    if (!inc) {
      const { service, region } = awsService(it.svcKey);
      inc = {
        key: `${it.svcKey}_${it.at}`,
        group: it.svcKey,
        title: clip(`${service}: ${it.title}`, 200),
        url: null,
        level: it.level,
        resolved: false,
        startedAt: it.at,
        updatedAt: it.at,
        components: region ? [service, region] : [service],
        nextUpdate: null,
        updates: [],
      };
      incidents.push(inc);
      open.set(it.svcKey, inc);
    }
    inc.updates.push(update);
    inc.updatedAt = it.at;
    if (it.level === 'major') inc.level = 'major';
    if (it.resolved) {
      inc.resolved = true;
      open.delete(it.svcKey);
    }
  }
  return { incidents, complete: false };
}

interface AppleEvent {
  messageId?: string;
  statusType?: string;
  message?: string;
  eventStatus?: string;
  epochStartDate?: number;
  epochEndDate?: number | null;
  usersAffected?: string;
}

function parseApple(body: string, now: number): ParsedStatus {
  let data: { services?: { serviceName?: string; events?: AppleEvent[] }[] };
  try {
    // Older versions were wrapped as jsonCallback({...}).
    data = JSON.parse(body.trim().replace(/^[\w.$]+\(/, '').replace(/\);?\s*$/, '')) as typeof data;
  } catch {
    throw new Error('Apple’s status data could not be read');
  }
  const byId = new Map<string, ParsedIncident>();
  for (const svc of data.services ?? []) {
    for (const ev of svc.events ?? []) {
      if (/maintenance/i.test(ev.statusType ?? '')) continue;
      const id = ev.messageId ?? `${svc.serviceName}|${ev.epochStartDate}`;
      const start = typeof ev.epochStartDate === 'number' ? ev.epochStartDate : now;
      const end = typeof ev.epochEndDate === 'number' ? ev.epochEndDate : null;
      const resolved = /resolved|completed/i.test(ev.eventStatus ?? '') || (end !== null && end < now);
      const text = clip([ev.message, ev.usersAffected].filter(Boolean).join(' '), 4000);
      let inc = byId.get(id);
      if (!inc) {
        inc = {
          key: id,
          title: '',
          url: null,
          level: /outage/i.test(ev.statusType ?? '') ? 'major' : 'minor',
          resolved,
          startedAt: start,
          updatedAt: end ?? start,
          components: [],
          nextUpdate: null,
          updates: [{ key: hashText(`${text}|${resolved}`), at: end ?? start, label: resolved ? 'Resolved' : (ev.statusType ?? 'Issue'), text }],
        };
        byId.set(id, inc);
      }
      if (svc.serviceName && !inc.components.includes(svc.serviceName)) inc.components.push(svc.serviceName);
      if (/outage/i.test(ev.statusType ?? '')) inc.level = 'major';
    }
  }
  const incidents = [...byId.values()];
  for (const inc of incidents) {
    const names = inc.components;
    inc.title = clip(`${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}: ${inc.level === 'major' ? 'outage' : 'issue'}`, 200);
  }
  return { incidents, complete: true };
}

/** Reads one status page's text into incidents. Throws when the text isn't what that kind of page sends. */
export function parseStatus(kind: StatusKind, body: string, now = Date.now()): ParsedStatus {
  if (kind === 'apple') return parseApple(body, now);
  const start = body.slice(0, 3000);
  if (!/<(rss|feed|channel)[\s>]/i.test(start)) throw new Error('That address didn’t send a feed');
  switch (kind) {
    case 'statuspage':
      return parseStatuspage(body, now);
    case 'google':
      return parseGoogle(body, now);
    case 'm365':
      return parseM365(body, now);
    case 'azure':
      return parseAzure(body, now);
    case 'aws':
      return parseAws(body, now);
  }
}

/** Whether an incident names one of a service's words (whole words, any case). Empty list = every incident. */
export function matchesWords(only: string[], title: string, components: string[]): boolean {
  if (!only.length) return true;
  const hay = `${title} ${components.join(' ')}`;
  return only.some((w) => {
    const t = w.trim();
    if (!t) return false;
    return new RegExp(`(^|[^A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(hay);
  });
}
