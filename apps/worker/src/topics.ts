import { INDEX_TYPES, platformOf, TOPICS_DAYS, type IndexType, type ItemKind, type TagCount, type TagList, type SourceType, type TopicsData, type TopicsItem } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { parseList } from './db';
import type { AppVariables, Env } from './env';
import { now } from './ids';

// Statistics > Topics: which sources feed which categories and tags, over 7, 30 or
// 90 days. One request loads the whole period in a packed form (an index scan of
// item_tags plus the period's items); the app filters it, so changing filters costs
// nothing. Kept in the edge cache for 15 minutes so reopening the map is free too.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
const CACHE_SECONDS = 15 * 60;

export function registerTopics(app: App) {
  app.get('/api/topics', async (c) => {
    const days = TOPICS_DAYS.find((d) => d === Number(c.req.query('days'))) ?? 30;
    const key = new Request(`https://topics.cache/v2/${days}`);
    const cache = (caches as unknown as { default: Cache }).default;
    if (c.req.query('fresh') !== '1') {
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const data = await buildTopics(c.env, days);
    const body = JSON.stringify(data);
    c.executionCtx.waitUntil(
      cache
        .put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` } }))
        .catch(() => undefined),
    );
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  });
}

/** The All tags page can count over all time or one of these recent periods. */
const TAG_LIST_DAYS = [0, 7, 30, 90] as const;
const TAG_LIST_CACHE_SECONDS = 10 * 60;

/**
 * Every AI tag with how many items carry it. All time reads the small running
 * tag_counts table; a recent period reads only that period's item_tags index rows.
 * Kept in the edge cache for 10 minutes; the page filters and sorts in the app.
 */
export function registerTagList(app: App) {
  app.get('/api/tags', async (c) => {
    const days = TAG_LIST_DAYS.find((d) => d === Number(c.req.query('days') ?? 0)) ?? 0;
    const key = new Request(`https://tags.cache/v1/${days}`);
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const rows =
      days === 0
        ? await c.env.DB.prepare('SELECT tag, label, n FROM tag_counts WHERE n > 0').all<TagCount>()
        : // Covered by item_tags_time.
          await c.env.DB.prepare('SELECT tag, MAX(label) AS label, COUNT(*) AS n FROM item_tags WHERE received_at >= ? GROUP BY tag')
            .bind(now() - days * DAY)
            .all<TagCount>();
    const data: TagList = { days, tags: rows.results };
    const body = JSON.stringify(data);
    c.executionCtx.waitUntil(
      cache
        .put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${TAG_LIST_CACHE_SECONDS}` } }))
        .catch(() => undefined),
    );
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  });
}

export async function buildTopics(env: Env, days: TopicsData['days']): Promise<TopicsData> {
  const t = now();
  const since = t - days * DAY;
  const [items, tags, sources, indexes] = await Promise.all([
    // Uses items_status_received: only the period's rows are read.
    env.DB.prepare(
      `SELECT id, source_id, kind, category, ai_category, read_at IS NOT NULL AS r, interesting_at IS NOT NULL AS s, saved_at IS NOT NULL AS v, received_at
       FROM items WHERE status IN ('inbox', 'archived') AND received_at >= ? AND kind != 'ai'`,
    )
      .bind(since)
      .all<{ id: string; source_id: string | null; kind: ItemKind; category: string | null; ai_category: string | null; r: number; s: number; v: number; received_at: number }>(),
    // Covered by item_tags_time.
    env.DB.prepare('SELECT item_id, tag, label FROM item_tags WHERE received_at >= ?')
      .bind(since)
      .all<{ item_id: string; tag: string; label: string }>(),
    env.DB.prepare('SELECT id, name, kind, feed_url, category FROM sources').all<{
      id: string;
      name: string;
      kind: ItemKind;
      feed_url: string | null;
      category: string | null;
    }>(),
    // Index names from key sentences: only long articles have a row, read by item id.
    env.DB.prepare(
      `SELECT k.item_id, k.terms FROM items i JOIN key_sentences k ON k.item_id = i.id
       WHERE i.status IN ('inbox', 'archived') AND i.received_at >= ? AND i.kind != 'ai' AND k.terms IS NOT NULL AND k.terms != '[]'`,
    )
      .bind(since)
      .all<{ item_id: string; terms: string }>(),
  ]);

  const tagIndex = new Map<string, number>();
  const tagList: TopicsData['tags'] = [];
  const byItem = new Map<string, number[]>();
  for (const r of tags.results) {
    let i = tagIndex.get(r.tag);
    if (i === undefined) {
      i = tagList.length;
      tagIndex.set(r.tag, i);
      tagList.push({ key: r.tag, label: r.label });
    }
    const list = byItem.get(r.item_id) ?? [];
    list.push(i);
    byItem.set(r.item_id, list);
  }

  // Index names sit with the tags, kept apart by their "idx:<type>:" key.
  for (const r of indexes.results) {
    let list: { term?: unknown; type?: unknown }[] = [];
    try {
      list = JSON.parse(r.terms) as typeof list;
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const mine = byItem.get(r.item_id) ?? [];
    for (const t of list) {
      if (typeof t?.term !== 'string' || !(INDEX_TYPES as readonly unknown[]).includes(t.type)) continue;
      const label = t.term.trim();
      if (!label) continue;
      const key = `idx:${t.type as IndexType}:${label.toLowerCase()}`;
      let i = tagIndex.get(key);
      if (i === undefined) {
        i = tagList.length;
        tagIndex.set(key, i);
        tagList.push({ key, label, index: t.type as IndexType });
      }
      mine.push(i);
    }
    byItem.set(r.item_id, mine);
  }

  const sourceById = new Map(sources.results.map((s) => [s.id, s]));
  const sourceIndex = new Map<string, number>();
  const sourceList: TopicsData['sources'] = [];
  const catIndex = new Map<string, number>();
  const catList: string[] = [];
  const packed: TopicsItem[] = [];
  for (const r of items.results) {
    const src = r.source_id ? sourceById.get(r.source_id) : undefined;
    let si = -1;
    if (src) {
      si = sourceIndex.get(src.id) ?? -1;
      if (si < 0) {
        si = sourceList.length;
        sourceIndex.set(src.id, si);
        const type: SourceType = (src.kind === 'feed' ? platformOf(src.feed_url) : null) ?? src.kind;
        sourceList.push({ id: src.id, name: src.name, type });
      }
    }
    const cat = r.category ?? src?.category ?? parseList(r.ai_category)[0] ?? null;
    let ci = -1;
    if (cat) {
      ci = catIndex.get(cat) ?? -1;
      if (ci < 0) {
        ci = catList.length;
        catIndex.set(cat, ci);
        catList.push(cat);
      }
    }
    packed.push([si, ci, (r.r ? 1 : 0) | (r.s ? 2 : 0) | (r.v ? 4 : 0), r.received_at, [...new Set(byItem.get(r.id) ?? [])]]);
  }
  return { days, generatedAt: t, sources: sourceList, categories: catList, tags: tagList, items: packed };
}
