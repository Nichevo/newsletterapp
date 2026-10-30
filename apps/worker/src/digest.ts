import type { Digest, DigestOptions, DigestSection, DigestStory } from '@newsletterapp/shared';
import { parseList } from './db';
import type { Env } from './env';
import { newId, now } from './ids';
import { scoreRecentItems } from './scoring';
import { loadSettings } from './settings';

// The daily digest, Techmeme style: the strongest items since the last digest,
// each with its summary and "More:" links to issues on the same topics. Built
// from the summaries and scores already on hand, so it costs no AI calls.

const MAX_MORE = 4;
const MIN_WINDOW = 6 * 3_600_000; // never build from less than six hours of mail

interface DigestRow {
  id: string;
  subject: string;
  source_name: string | null;
  summary: string | null;
  preheader: string | null;
  snippet: string | null;
  why_it_matters: string | null;
  score: number | null;
  received_at: number;
  read_at: number | null;
  tags: string | null;
  category: string | null;
  thin_content: number;
  sponsored: number;
}

/** "2026-10-30" for a moment in the given time zone. */
export function dayKey(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** The local hour (0-23) for a moment in the given time zone. */
export function localHour(at: number, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at));
  return Number(h) || 0;
}

const STOP = new Set(
  'the a an and or of to in on for with at by from is are was be as it its this that these those your you we our new how what why when more best top vs into about after before over under out up'.split(' '),
);

/** Topic tags from the AI, falling back to distinctive subject words. */
export function topicsOf(row: { tags: string | null; subject: string }): string[] {
  const tags = parseList(row.tags).map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (tags.length > 0) return tags;
  return row.subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 5 && !STOP.has(w))
    .slice(0, 6);
}

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((t) => set.has(t));
}

function storyFrom(row: DigestRow, more: DigestRow[]): DigestStory {
  return {
    itemId: row.id,
    subject: row.subject,
    sourceName: row.source_name,
    summary: row.summary ?? row.preheader ?? row.snippet,
    whyItMatters: row.why_it_matters,
    score: row.score,
    receivedAt: row.received_at,
    readAt: row.read_at,
    more: more.map((m) => ({ itemId: m.id, subject: m.subject, sourceName: m.source_name })),
  };
}

/** Builds the digest for [fromAt, toAt) and stores it under `day`. Returns null when there was nothing to say. */
export async function buildDigest(env: Env, day: string, fromAt: number, toAt: number, options: DigestOptions): Promise<Digest | null> {
  await scoreRecentItems(env);
  const where = ['items.received_at >= ?', 'items.received_at < ?', "items.status IN ('inbox', 'archived')"];
  if (!options.includeRead) where.push('items.read_at IS NULL');
  if (!options.includeSponsored) where.push('items.sponsored = 0');
  const rows = await env.DB.prepare(
    `SELECT items.id, items.subject, sources.name AS source_name, items.summary, items.preheader, items.snippet,
       items.why_it_matters, items.score, items.received_at, items.read_at, items.tags, items.thin_content, items.sponsored,
       COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]')) AS category
     FROM items LEFT JOIN sources ON sources.id = items.source_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(items.score, 0) DESC, items.received_at DESC LIMIT 200`,
  )
    .bind(fromAt, toAt)
    .all<DigestRow>();
  const skip = new Set(options.skipCategories.map((c) => c.toLowerCase()));
  const all = rows.results.filter((r) => !skip.has((r.category ?? 'Other').toLowerCase()));
  if (all.length === 0) return null;

  // Lead stories: best scores first; an issue that shares topics with a lead
  // already chosen becomes one of its "More:" links instead of its own story.
  const topics = new Map(all.map((r) => [r.id, topicsOf(r)]));
  const leads: { row: DigestRow; more: DigestRow[] }[] = [];
  const used = new Set<string>();
  for (const row of all) {
    if (used.has(row.id)) continue;
    const lead = leads.find((l) => overlap(topics.get(l.row.id) ?? [], topics.get(row.id) ?? []).length > 0);
    if (lead) {
      if (lead.more.length < MAX_MORE) {
        lead.more.push(row);
        used.add(row.id);
      }
      continue;
    }
    if (leads.length >= options.stories) continue;
    leads.push({ row, more: [] });
    used.add(row.id);
  }

  // Group by category (or newsletter), biggest section first, keeping score order inside each.
  const byCategory = new Map<string, DigestStory[]>();
  for (const l of leads) {
    const key = options.groupBy === 'source' ? (l.row.source_name ?? 'Unknown sender') : (l.row.category ?? 'Other');
    const list = byCategory.get(key) ?? [];
    list.push(storyFrom(l.row, l.more));
    byCategory.set(key, list);
  }
  const sections: DigestSection[] = [...byCategory.entries()]
    .map(([title, stories]) => ({ title, stories }))
    .sort((a, b) => b.stories.length - a.stories.length || (b.stories[0]?.score ?? 0) - (a.stories[0]?.score ?? 0));

  const digest: Digest = { id: newId(), day, createdAt: now(), fromAt, toAt, itemCount: all.length, sections, readAt: null };
  await env.DB.prepare(
    `INSERT INTO digests (id, day, created_at, from_at, to_at, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(day) DO UPDATE SET id = ?1, created_at = ?3, from_at = ?4, to_at = ?5, body = ?6, read_at = NULL`,
  )
    .bind(digest.id, day, digest.createdAt, fromAt, toAt, JSON.stringify(digest))
    .run();
  return digest;
}

/** Builds today's digest if it is time and it hasn't been built yet. Called hourly by the cron and on demand. */
export async function buildDigestIfDue(env: Env, force = false): Promise<Digest | null> {
  const settings = await loadSettings(env);
  const at = now();
  const day = dayKey(at, settings.timezone);
  const existing = await env.DB.prepare('SELECT day FROM digests WHERE day = ?').bind(day).first<{ day: string }>();
  if (!force && (existing || localHour(at, settings.timezone) !== settings.digestHour)) return null;
  const opts = settings.digest;
  let fromAt: number;
  if (opts.windowHours > 0) {
    fromAt = at - opts.windowHours * 3_600_000;
  } else {
    const last = await env.DB.prepare('SELECT MAX(to_at) AS to_at FROM digests WHERE day != ?').bind(day).first<{ to_at: number | null }>();
    fromAt = last?.to_at ?? at - 24 * 3_600_000;
  }
  if (!force && at - fromAt < MIN_WINDOW) return null;
  return buildDigest(env, day, Math.min(fromAt, at - MIN_WINDOW), at, opts);
}
