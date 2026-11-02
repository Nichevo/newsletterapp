import type { RelatedItem } from '@newsletterapp/shared';
import type { Env } from './env';
import { parseList } from './db';

/**
 * "You've read about this before": older items you read that share a specific topic with this one.
 *
 * Topics are the AI tags (or distinctive subject words when there are none). Matching is whole-word
 * through the search index, topics that turn up on a large share of all items are ignored, and the
 * rest count more the rarer they are, so "Nvidia" links two items and "technology" does not.
 */

const LIMIT = 5;
/** Embedding neighbours at least this close count as the same subject. */
const SIMILAR = 0.7;
/** A topic on more than this share of all items is too broad to link anything. */
const BROAD_SHARE = 0.15;

const STOP = new Set(
  (
    'the a an and or of to in on for with at by from is are was be as it its this that these those your you we our new how what why when ' +
    'more best top vs into about after before over under out up weekly daily monthly edition issue roundup digest newsletter update updates ' +
    'today week month year news briefing recap special latest morning evening sunday monday tuesday wednesday thursday friday saturday ' +
    'january february march april may june july august september october november december part episode volume there their them here ' +
    'which while where would could should every other still just really things thing first last ahead inside guide'
  ).split(' '),
);

/** Lower-case word tokens with a trailing plural "s" taken off, so "rates" meets "rate". */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** True when the words of `topic` appear next to each other in `words`. */
function hasPhrase(words: string[], topic: string[]): boolean {
  if (topic.length === 0) return false;
  outer: for (let i = 0; i + topic.length <= words.length; i++) {
    for (let j = 0; j < topic.length; j++) if (words[i + j] !== topic[j]) continue outer;
    return true;
  }
  return false;
}

/** Subject words used as topics when an item has no AI tags: long, not filler, and not the source's usual subject template. */
function subjectWords(subject: string, usual: Set<string>): string[] {
  const raw = [...new Set(subject.toLowerCase().split(/[^\p{L}\p{N}]+/u))];
  return raw.filter((w) => {
    const stem = tokens(w)[0] ?? '';
    return w.length >= 5 && !STOP.has(w) && !STOP.has(stem) && !/^\d+$/.test(w) && !usual.has(stem);
  }).slice(0, 6);
}

const quote = (t: string) => `"${t.replace(/"/g, '')}"`;

export async function relatedItems(env: Env, id: string): Promise<RelatedItem[] | null> {
  const row = await env.DB.prepare('SELECT id, source_id, subject, tags, received_at, neighbours FROM items WHERE id = ?')
    .bind(id)
    .first<{ id: string; source_id: string | null; subject: string; tags: string | null; received_at: number; neighbours: string | null }>();
  if (!row) return null;
  const [byMeaning, byTopic] = await Promise.all([similarItems(env, row.neighbours), topicItems(env, row)]);
  // Closest in meaning first, then topic matches the embeddings didn't already find.
  const seen = new Set(byMeaning.map((r) => r.id));
  const topicsFor = new Map(byTopic.map((r) => [r.id, r.shared]));
  return [
    ...byMeaning.map((r) => ({ ...r, shared: topicsFor.get(r.id) ?? [] })),
    ...byTopic.filter((r) => !seen.has(r.id)),
  ].slice(0, LIMIT);
}

type RelatedRow = { id: string; subject: string; tags: string | null; received_at: number; read_at: number; saved_at: number | null; source_name: string | null };

/** The PC helper's nearest older items that you read. */
async function similarItems(env: Env, neighbours: string | null): Promise<RelatedItem[]> {
  let list: [string, number][] = [];
  try {
    list = (JSON.parse(neighbours ?? '[]') as [string, number][]).filter((n) => Array.isArray(n) && n[1] >= SIMILAR).slice(0, 20);
  } catch {
    return [];
  }
  if (list.length === 0) return [];
  const sims = new Map(list);
  const rows = await env.DB.prepare(
    `SELECT items.id, items.subject, items.tags, items.received_at, items.read_at, items.saved_at, sources.name AS source_name
     FROM items LEFT JOIN sources ON sources.id = items.source_id
     WHERE items.id IN (${list.map(() => '?').join(', ')}) AND items.read_at IS NOT NULL AND items.status IN ('inbox', 'archived')`,
  )
    .bind(...list.map((n) => n[0]))
    .all<RelatedRow>();
  return rows.results
    .map((r) => ({
      id: r.id,
      subject: r.subject,
      sourceName: r.source_name,
      receivedAt: r.received_at,
      readAt: r.read_at,
      savedAt: r.saved_at,
      shared: [],
      similarity: sims.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, LIMIT);
}

/** Older items you read that share a specific topic (whole words, rarer topics weigh more). */
async function topicItems(
  env: Env,
  row: { id: string; source_id: string | null; subject: string; tags: string | null; received_at: number },
): Promise<RelatedItem[]> {
  const id = row.id;

  let topics = [...new Set(parseList(row.tags).map((t) => t.trim()).filter(Boolean))].slice(0, 5);
  if (topics.length === 0) {
    // Words this source puts in most of its subjects ("Weekly", "Briefing", its own name) say nothing about the story.
    const usual = new Set<string>();
    if (row.source_id) {
      const recent = await env.DB.prepare('SELECT subject FROM items WHERE source_id = ? AND id != ? ORDER BY received_at DESC LIMIT 20')
        .bind(row.source_id, id)
        .all<{ subject: string }>();
      const counts = new Map<string, number>();
      for (const r of recent.results) for (const w of new Set(tokens(r.subject))) counts.set(w, (counts.get(w) ?? 0) + 1);
      for (const [w, n] of counts) if (recent.results.length >= 3 && n / recent.results.length >= 0.3) usual.add(w);
    }
    topics = subjectWords(row.subject, usual);
  }
  topics = topics.filter((t) => tokens(t).some((w) => !STOP.has(w)));
  if (topics.length === 0) return [];

  // How many items mention each topic, counted only up to the "too broad" line so a common word stays cheap.
  const total = (await env.DB.prepare('SELECT MAX(rowid) AS n FROM items').first<{ n: number | null }>())?.n ?? 0;
  if (total < 2) return [];
  const broadAt = Math.max(20, Math.ceil(total * BROAD_SHARE));
  const counts = await env.DB.batch(
    topics.map((t) =>
      env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT rowid FROM items_fts WHERE items_fts MATCH ? LIMIT ?)').bind(
        `{subject tags} : ${quote(t)}`,
        broadAt + 1,
      ),
    ),
  );
  const weighted = topics
    .map((t, i) => ({ topic: t, words: tokens(t), df: (counts[i]?.results[0] as { n: number } | undefined)?.n ?? 0 }))
    // df counts this item too; a topic only this item has links nothing.
    .filter((t) => t.df > 1 && t.df <= broadAt && t.words.length > 0)
    .map((t) => ({ ...t, weight: Math.log(total / t.df) }));
  if (weighted.length === 0) return [];

  const rows = await env.DB.prepare(
    `SELECT items.id, items.subject, items.tags, items.received_at, items.read_at, items.saved_at, sources.name AS source_name
     FROM items_fts JOIN items ON items.rowid = items_fts.rowid LEFT JOIN sources ON sources.id = items.source_id
     WHERE items_fts MATCH ? AND items.id != ? AND items.received_at < ? AND items.read_at IS NOT NULL
       AND items.status IN ('inbox', 'archived')
     ORDER BY items_fts.rank LIMIT 60`,
  )
    .bind(`{subject tags} : (${weighted.map((t) => quote(t.topic)).join(' OR ')})`, id, row.received_at)
    .all<RelatedRow>();

  // A topic on under a tenth of all items links on its own; commoner ones need a second shared topic.
  const needed = Math.min(Math.log(10), Math.log(total / 3));
  return rows.results
    .map((r) => {
      const words = tokens(`${r.subject} ${parseList(r.tags).join(' | ')}`);
      const shared = weighted.filter((t) => hasPhrase(words, t.words));
      const score = shared.reduce((s, t) => s + t.weight, 0);
      return {
        item: {
          id: r.id,
          subject: r.subject,
          sourceName: r.source_name,
          receivedAt: r.received_at,
          readAt: r.read_at,
          savedAt: r.saved_at,
          shared: shared.sort((a, b) => b.weight - a.weight).map((t) => t.topic),
        } satisfies RelatedItem,
        score,
      };
    })
    .filter((r) => r.item.shared.length > 0 && r.score >= needed)
    .sort((a, b) => b.score - a.score || b.item.receivedAt - a.item.receivedAt)
    .slice(0, LIMIT)
    .map((r) => r.item);
}
