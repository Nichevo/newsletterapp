import type { DigestStory } from '@newsletterapp/shared';
import { parseList } from './db';
import type { Env } from './env';
import { scoreRecentItems } from './scoring';

// Lead stories, Techmeme style: the strongest items in a period, each with its
// summary and "More:" links to issues on the same topics. Built from the
// summaries and scores already on hand, so it costs no AI calls. This was the
// daily digest; it is now "Top of the week" in the weekly review.

const MAX_MORE = 4;

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

/** The top `count` lead stories among items that arrived in [fromAt, toAt), read or not. */
export async function leadStories(env: Env, fromAt: number, toAt: number, count: number, skipCategories: string[]): Promise<DigestStory[]> {
  await scoreRecentItems(env);
  // AI notes (answers to your own highlights) and sponsored-heavy issues stay out.
  const rows = await env.DB.prepare(
    `SELECT items.id, items.subject, sources.name AS source_name, items.summary, items.preheader, items.snippet,
       items.why_it_matters, items.score, items.received_at, items.read_at, items.tags, items.thin_content, items.sponsored,
       COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]')) AS category
     FROM items LEFT JOIN sources ON sources.id = items.source_id
     WHERE items.received_at >= ? AND items.received_at < ? AND items.status IN ('inbox', 'archived') AND items.kind != 'ai' AND items.sponsored = 0
     ORDER BY COALESCE(items.score, 0) DESC, items.received_at DESC LIMIT 200`,
  )
    .bind(fromAt, toAt)
    .all<DigestRow>();
  const skip = new Set(skipCategories.map((c) => c.toLowerCase()));
  const all = rows.results.filter((r) => !skip.has((r.category ?? 'Other').toLowerCase()));

  // Best scores first; an issue that shares topics with a lead already chosen
  // becomes one of its "More:" links instead of its own story.
  const topics = new Map(all.map((r) => [r.id, topicsOf(r)]));
  const leads: { row: DigestRow; more: DigestRow[] }[] = [];
  for (const row of all) {
    const lead = leads.find((l) => overlap(topics.get(l.row.id) ?? [], topics.get(row.id) ?? []).length > 0);
    if (lead) {
      if (lead.more.length < MAX_MORE) lead.more.push(row);
      continue;
    }
    if (leads.length >= count) continue;
    leads.push({ row, more: [] });
  }
  return leads.map((l) => storyFrom(l.row, l.more));
}
