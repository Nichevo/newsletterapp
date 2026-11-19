import type { CatchUpJobItem, CatchUpResult, HelperConfig, ModelRef } from '@newsletterapp/shared';
import type { AppClient } from './app';
import type { Embeddings } from './embed';
import { log } from './log';
import { findProvider, type Provider } from './providers';
import { powerMeter } from './system';

// Morning catch-up: the app sends the items to skim; the PC groups them into
// themes and names them. Grouping happens here, not in the model: items of the
// same story start together, then groups are joined while they stay close in
// meaning (average closeness of their embeddings, or shared tags when an item
// has no embedding). Groups of 3 or more become themes; the rest fall back to
// the owner's categories. One model call then names each theme, writes a line
// on it and a short overview of the whole pile. Without a model the themes are
// named after their most common tags.

/** Least average closeness for two groups to join (nomic-embed-text cosine). */
const JOIN_AT = 0.6;
/** Least items for a theme; smaller groups go under their category. */
const MIN_THEME = 3;
const MAX_THEMES = 12;
/** Items per group shown to the model. */
const SHOWN = 8;

const SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    themes: {
      type: 'array',
      items: { type: 'object', properties: { group: { type: 'number' }, name: { type: 'string' }, gist: { type: 'string' } }, required: ['group', 'name', 'gist'] },
    },
  },
  required: ['overview', 'themes'],
};

interface Group {
  name: string;
  fromCategory: boolean;
  items: CatchUpJobItem[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

function jsonOf(reply: string): Record<string, unknown> {
  const cleaned = stripThinking(reply).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both;
}

/**
 * Average-link grouping. `sim` is the closeness of two items; groups join, closest
 * pair first, while their average closeness is at least JOIN_AT. Items in the same
 * story start in one group.
 */
export function groupItems(items: CatchUpJobItem[], sim: (a: number, b: number) => number): number[][] {
  const start = new Map<string, number[]>();
  const groups: number[][] = [];
  items.forEach((it, i) => {
    if (it.storyId) {
      const g = start.get(it.storyId);
      if (g) return void g.push(i);
      const ng = [i];
      start.set(it.storyId, ng);
      groups.push(ng);
    } else groups.push([i]);
  });
  const n = groups.length;
  // Sum of item-pair closeness between groups; the average is sum / (size a * size b).
  const sums: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      let s = 0;
      for (const i of groups[a]!) for (const j of groups[b]!) s += sim(i, j);
      sums[a]![b] = sums[b]![a] = s;
    }
  const alive = groups.map(() => true);
  for (;;) {
    let best = -1;
    let ba = -1;
    let bb = -1;
    for (let a = 0; a < n; a++) {
      if (!alive[a]) continue;
      for (let b = a + 1; b < n; b++) {
        if (!alive[b]) continue;
        const avg = sums[a]![b]! / (groups[a]!.length * groups[b]!.length);
        if (avg > best) {
          best = avg;
          ba = a;
          bb = b;
        }
      }
    }
    if (ba < 0 || best < JOIN_AT) break;
    for (let c = 0; c < n; c++) if (alive[c] && c !== ba && c !== bb) sums[ba]![c] = sums[c]![ba] = sums[ba]![c]! + sums[bb]![c]!;
    groups[ba]!.push(...groups[bb]!);
    alive[bb] = false;
  }
  return groups.filter((_, i) => alive[i]);
}

/** Themes from the grouping, with the small groups under their categories. */
export function themesOf(items: CatchUpJobItem[], embeddings: Pick<Embeddings, 'vectorOf'> | null): Group[] {
  const vecs = items.map((it) => embeddings?.vectorOf(it.id));
  const tags = items.map((it) => new Set(it.tags.map((t) => t.toLowerCase())));
  const sim = (a: number, b: number) => {
    const va = vecs[a];
    const vb = vecs[b];
    if (va && vb) return dot(va, vb);
    // No embedding: shared tags (one shared tag in the same category is enough to join).
    const shared = sharedCount(tags[a]!, tags[b]!);
    return Math.min(1, (shared ? 0.45 + 0.15 * Math.min(shared, 3) : 0) + (items[a]!.category && items[a]!.category === items[b]!.category ? 0.1 : 0));
  };
  const grouped = groupItems(items, sim).sort((a, b) => b.length - a.length);
  const themes: Group[] = [];
  const rest: CatchUpJobItem[] = [];
  for (const g of grouped) {
    if (g.length >= MIN_THEME && themes.length < MAX_THEMES) themes.push({ name: commonTag(g.map((i) => items[i]!)), fromCategory: false, items: g.map((i) => items[i]!) });
    else rest.push(...g.map((i) => items[i]!));
  }
  const byCat = new Map<string, CatchUpJobItem[]>();
  for (const it of rest) byCat.set(it.category || 'Other', [...(byCat.get(it.category || 'Other') ?? []), it]);
  for (const [name, list] of [...byCat].sort((a, b) => b[1].length - a[1].length)) themes.push({ name, fromCategory: true, items: list });
  return themes;
}

/** A name for a group without a model: its most common tag or two. */
function commonTag(items: CatchUpJobItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);
  if (!top.length) return items[0]?.category || 'Other';
  const name = top.join(' and ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export async function runCatchUp(config: HelperConfig, app: AppClient, providers: Provider[], embeddings: Embeddings, doing: (what: string) => void): Promise<void> {
  if (!config.catchUpWaiting || config.paused) return;
  const { job } = await app.catchUpClaim();
  if (!job) return;
  doing('grouping the morning catch-up');
  const started = performance.now();
  const meter = powerMeter();
  const model: ModelRef | undefined = config.limited ? undefined : config.models.find((m) => findProvider(providers, m));
  const base = { catchUpId: job.catchUpId, provider: model?.provider ?? 'pc', model: model?.name ?? 'grouping only' };
  try {
    const groups = themesOf(job.items, embeddings.model ? embeddings : null);
    let overview = '';
    const names: { name: string; gist: string }[] = groups.map((g) => ({ name: g.name, gist: '' }));
    if (model) {
      doing('writing the morning catch-up');
      const provider = findProvider(providers, model)!;
      const text = groups
        .map((g, i) =>
          [
            `Group ${i + 1}${g.fromCategory ? ` [category: ${g.name}]` : ''}, ${g.items.length} items:`,
            ...g.items.slice(0, SHOWN).map((it) => `[${it.n}] ${it.text}`),
            g.items.length > SHOWN ? `(and ${g.items.length - SHOWN} more)` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n');
      const v = jsonOf(await provider.complete(model.name, job.prompt, `${job.items.length} items in ${groups.length} groups.\n\n${text}`, { json: true, schema: SCHEMA }));
      overview = str(v.overview);
      for (const t of Array.isArray(v.themes) ? v.themes : []) {
        const i = Number((t as { group?: unknown }).group) - 1;
        const g = groups[i];
        if (!g) continue;
        const name = str((t as { name?: unknown }).name);
        names[i] = { name: g.fromCategory && !name ? g.name : name || g.name, gist: str((t as { gist?: unknown }).gist) };
      }
    }
    const seconds = (performance.now() - started) / 1000;
    const result: CatchUpResult = {
      ...base,
      ok: true,
      seconds,
      watts: meter.stop(),
      overview,
      themes: groups.map((g, i) => ({ name: names[i]!.name, gist: names[i]!.gist, fromCategory: g.fromCategory, itemIds: g.items.map((it) => it.id) })),
    };
    await app.catchUpResult(result);
    log(`catch-up: ${job.items.length} items in ${groups.filter((g) => !g.fromCategory).length} themes + ${groups.filter((g) => g.fromCategory).length} categories, ${seconds.toFixed(0)}s`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`catch-up failed: ${error}`);
    await app.catchUpResult({ ...base, ok: false, seconds: (performance.now() - started) / 1000, watts: meter.stop(), error });
  }
}

