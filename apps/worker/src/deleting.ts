// Deleting an item from the reader. It disappears at once (status 'dropped', so
// every list, search and count already leaves it out) and can be undone for a
// while; about ten minutes later the hourly tidy-up removes its stored copy and
// files, its tags, highlights and story link. The row itself stays, with only
// its headline, so Reading statistics don't change and a feed post that was
// deleted is still known as seen and never comes back.

import type { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { refreshStory } from './stories';

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

/** How long Undo keeps working before the tidy-up may remove the item's copy for good. */
export const UNDO_MS = 10 * 60_000;

export function registerDeleting(app: App) {
  app.post('/api/items/:id/delete', async (c) => {
    const r = await c.env.DB.prepare(
      "UPDATE items SET status = 'dropped', deleted_at = ? WHERE id = ? AND status IN ('inbox', 'archived', 'screening')",
    )
      .bind(now(), c.req.param('id'))
      .run();
    if (!r.meta.changes) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  /** Undo: back where it was (archived if it had been archived). */
  app.post('/api/items/:id/undelete', async (c) => {
    const r = await c.env.DB.prepare(
      `UPDATE items SET status = CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE 'inbox' END, deleted_at = NULL
       WHERE id = ? AND status = 'dropped' AND deleted_at > 0`,
    )
      .bind(c.req.param('id'))
      .run();
    if (!r.meta.changes) return c.json({ error: 'It has already been removed for good' }, 409);
    return c.json({ ok: true });
  });
}

/** Removes what deleted items left behind once Undo time has passed. Runs hourly. */
export async function tidyDeleted(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    'SELECT id, html_key, text_key, raw_key, file_key, story_id FROM items INDEXED BY items_deleted WHERE deleted_at > 0 AND deleted_at < ? LIMIT 25',
  )
    .bind(now() - UNDO_MS)
    .all<{ id: string; html_key: string | null; text_key: string | null; raw_key: string | null; file_key: string | null; story_id: string | null }>();
  const t = now();
  for (const row of rows.results) {
    // Everything stored under the item (its copy, file, pictures), plus the original email.
    const keys = new Set<string>([row.html_key, row.text_key, row.raw_key, row.file_key].filter((k): k is string => Boolean(k)));
    let cursor: string | undefined;
    do {
      const page = await env.RAW.list({ prefix: `items/${row.id}/`, cursor });
      for (const o of page.objects) keys.add(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (keys.size) await env.RAW.delete([...keys]);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM item_tags WHERE item_id = ?').bind(row.id),
      env.DB.prepare('DELETE FROM item_reads WHERE item_id = ?').bind(row.id),
      env.DB.prepare('UPDATE highlights SET deleted_at = ? WHERE item_id = ? AND deleted_at IS NULL').bind(t, row.id),
      env.DB.prepare('DELETE FROM fetch_jobs WHERE item_id = ?').bind(row.id),
      // Key sentences, and its cites of studies and links (their counts go down with it).
      env.DB.prepare('DELETE FROM key_sentences WHERE item_id = ?').bind(row.id),
      env.DB.prepare('DELETE FROM ks_fts WHERE rowid BETWEEN (SELECT rowid * 1024 FROM items WHERE id = ?1) AND (SELECT rowid * 1024 + 1023 FROM items WHERE id = ?1)').bind(row.id),
      env.DB.prepare('UPDATE studies SET cites = MAX(cites - 1, 0) WHERE id IN (SELECT study_id FROM study_cites WHERE item_id = ?)').bind(row.id),
      env.DB.prepare('UPDATE study_cites SET differs_from = NULL WHERE differs_from IN (SELECT id FROM study_cites WHERE item_id = ?)').bind(row.id),
      env.DB.prepare('DELETE FROM study_cites WHERE item_id = ?').bind(row.id),
      env.DB.prepare('UPDATE links SET cites = MAX(cites - 1, 0) WHERE id IN (SELECT link_id FROM link_cites WHERE item_id = ?)').bind(row.id),
      env.DB.prepare('DELETE FROM link_cites WHERE item_id = ?').bind(row.id),
      env.DB.prepare(
        `UPDATE items SET html_key = NULL, text_key = NULL, raw_key = NULL, file_key = NULL, has_html = 0, snippet = NULL, preheader = NULL,
           summary = NULL, key_points = NULL, why_it_matters = NULL, tags = NULL, background = NULL, coverage = NULL,
           lead_image = NULL, lead_image_title = NULL, lead_image_alt = NULL, neighbours = NULL,
           story_id = NULL, news_id = NULL, story_split = 1, story_note = NULL, story_note_status = NULL,
           highlight_count = 0, note_count = 0, ks_status = NULL, refs_status = NULL, deleted_at = 0
         WHERE id = ?`,
      ).bind(row.id),
    ]);
    // The story it was part of loses an item (and goes away if only one is left).
    if (row.story_id) await refreshStory(env, row.story_id);
  }
  return rows.results.length;
}
