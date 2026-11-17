// Your own tags. The AI picks up to three topic tags per item; when it misses one
// you can add it in the reader, and take off one that is wrong. The edit goes into
// items.tags at once (so tag pages, the Topics map, stories and search all see it)
// and is kept in tag_edits, which is laid over the AI's tags whenever it runs again.

import { ITEM_TAGS_MAX, MY_TAGS_TO_AI, cleanTagLabel, mergeTagEdits, tagKey, type MyTagStats, type TagEdit, type TagEditResult } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { parseList } from './db';
import type { AppVariables, Env } from './env';
import { now } from './ids';

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;

/** The tags you added by hand that the AI is told about: most used first, then newest. */
export async function ownTagLabels(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT MAX(label) AS label FROM tag_edits WHERE action = 'add' GROUP BY tag ORDER BY COUNT(*) DESC, MAX(at) DESC LIMIT ${MY_TAGS_TO_AI}`,
  ).all<{ label: string }>();
  return rows.results.map((r) => r.label);
}

/** Added to the summary prompt when the switch is on and you have added tags. */
export function withMyTagRules(prompt: string, labels: string[]): string {
  if (!labels.length) return prompt;
  const list = labels.map((l) => `"${l.replace(/"/g, "'")}"`).join(', ');
  return `${prompt}

Tags the reader added by hand on other items: ${list}. When this text is mainly about one of these, use that exact wording as one of the "topics" instead of a near synonym. Never add one of them just because it is loosely related; most items will use none.`;
}

export async function loadTagEdits(env: Env, itemId: string): Promise<TagEdit[]> {
  const rows = await env.DB.prepare('SELECT tag, label, action FROM tag_edits WHERE item_id = ?').bind(itemId).all<TagEdit>();
  return rows.results;
}

/** The AI's new tags with your edits on top: what the summary step writes to items.tags. */
export async function withMyTags(env: Env, itemId: string, aiTags: string[]): Promise<string[]> {
  const edits = await loadTagEdits(env, itemId);
  return edits.length ? mergeTagEdits(aiTags, edits) : aiTags;
}

/** Which of an item's tags are yours, and which you took off. */
export function tagEditInfo(tags: string[], edits: TagEdit[]): { myTags: string[]; removedTags: string[] } {
  const mine = new Set(edits.filter((e) => e.action === 'add').map((e) => e.tag));
  return {
    myTags: tags.filter((t) => mine.has(tagKey(t))),
    removedTags: edits.filter((e) => e.action === 'remove').map((e) => e.label),
  };
}

export async function tagCountsFor(env: Env, tags: string[]): Promise<Record<string, number>> {
  const keys = [...new Set(tags.map(tagKey).filter(Boolean))].slice(0, ITEM_TAGS_MAX);
  if (!keys.length) return {};
  const rows = await env.DB.prepare(`SELECT tag, n FROM tag_counts WHERE tag IN (${keys.map(() => '?').join(', ')})`)
    .bind(...keys)
    .all<{ tag: string; n: number }>();
  const n = new Map(rows.results.map((r) => [r.tag, r.n]));
  return Object.fromEntries(tags.map((t) => [t, n.get(tagKey(t)) ?? 1]));
}

export function registerMyTags(app: App) {
  /** Settings: how many tags you've added, and which of them the AI has put on items itself lately. */
  app.get('/api/my-tags/stats', async (c) => {
    const since = now() - 30 * DAY;
    const [own, used] = await Promise.all([
      c.env.DB.prepare("SELECT COUNT(DISTINCT tag) AS n FROM tag_edits WHERE action = 'add'").first<{ n: number }>(),
      // item_tags_tag_time finds each of your tags' recent rows; items you tagged yourself don't count.
      c.env.DB.prepare(
        `SELECT it.tag, MAX(it.label) AS label, COUNT(*) AS n FROM item_tags it
         WHERE it.tag IN (SELECT tag FROM tag_edits WHERE action = 'add') AND it.received_at >= ?
           AND NOT EXISTS (SELECT 1 FROM tag_edits e WHERE e.item_id = it.item_id AND e.tag = it.tag)
         GROUP BY it.tag ORDER BY n DESC LIMIT 20`,
      )
        .bind(since)
        .all<{ tag: string; label: string; n: number }>(),
    ]);
    const stats: MyTagStats = { own: own?.n ?? 0, used: used.results };
    return c.json(stats);
  });

  /** { add: "label" } puts a tag on, { remove: "label" } takes one off. Answers with the item's tags as they now are. */
  app.post('/api/items/:id/tags', async (c) => {
    const id = c.req.param('id');
    const input = (await c.req.json().catch(() => null)) as { add?: unknown; remove?: unknown } | null;
    const raw = typeof input?.add === 'string' ? input.add : typeof input?.remove === 'string' ? input.remove : null;
    if (raw === null) return c.json({ error: 'add or remove a tag' }, 400);
    const adding = typeof input?.add === 'string';
    const label = cleanTagLabel(raw);
    const key = tagKey(label);
    if (!key) return c.json({ error: 'Type a tag first' }, 400);

    const row = await c.env.DB.prepare('SELECT tags FROM items WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ tags: string | null }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const current = parseList(row.tags);
    if (adding && current.length >= ITEM_TAGS_MAX && !current.some((t) => tagKey(t) === key)) {
      return c.json({ error: `An item can have up to ${ITEM_TAGS_MAX} tags` }, 400);
    }
    // Taking one off keeps the label it had, so "Put back" shows it as it was.
    const shown = adding ? label : (current.find((t) => tagKey(t) === key) ?? label);
    const edit: TagEdit = { tag: key, label: shown, action: adding ? 'add' : 'remove' };
    const others = (await loadTagEdits(c.env, id)).filter((e) => e.tag !== key);
    const edits = [...others, edit];
    const tags = mergeTagEdits(current, edits);

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tag_edits (item_id, tag, label, action, at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(item_id, tag) DO UPDATE SET label = ?3, action = ?4, at = ?5`,
      ).bind(id, key, shown, edit.action, now()),
      // The item_tags / tag_counts / search triggers follow items.tags.
      c.env.DB.prepare('UPDATE items SET tags = ? WHERE id = ?').bind(tags.length ? JSON.stringify(tags) : null, id),
    ]);
    const result: TagEditResult = { tags, tagCounts: await tagCountsFor(c.env, tags), ...tagEditInfo(tags, edits) };
    return c.json(result);
  });
}
