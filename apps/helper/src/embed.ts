import type { EmbedResult, HelperConfig, LikelyState } from '@newsletterapp/shared';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppClient } from './app';
import { dataDir, type LocalConfig } from './config';
import { log } from './log';

// Embeddings for related reading and Likely interesting. Each item's subject,
// summary and topics go through a small local embedding model in Ollama; the
// vectors stay in a file on this PC. For every new item the helper finds the
// closest older items and sends only those links to the app, and it scores
// recent items against the ones marked Interesting, sending only the flags that
// change. So the app stores a few ids per item and does no vector maths.

/** How many nearest older items to send per item, and the least similarity worth sending. */
const NEIGHBOURS = 15;
const MIN_SIMILARITY = 0.55;
/** Likely interesting: recent items only, the top share of them, and only once there are enough stars. */
const RECENT_MS = 30 * 86_400_000;
const LIKELY_SHARE = 0.15;
const LIKELY_FLOOR = 0.55;
const MIN_STARS = 5;
/** Probably not for you: close to what you marked Not interested, by at least this much more than to your stars. */
const MIN_NOT_INTERESTED = 5;
const UNLIKELY_FLOOR = 0.6;
const UNLIKELY_MARGIN = 0.03;
/** Items per embedding call, and per claim. */
const BATCH = 16;
const CLAIM = 64;

interface Entry {
  at: number;
  v: Float32Array;
}

const metaPath = () => join(dataDir(), 'embeddings.json');
const dataPath = () => join(dataDir(), 'embeddings.jsonl');

function normalise(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

const toB64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const fromB64 = (s: string) => {
  const buf = Buffer.from(s, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};

export class Embeddings {
  readonly model: string | null;
  store = '';
  private items = new Map<string, Entry>();
  private lines = 0;
  private failedAt = 0;
  private ready = false;
  private lastKey = '';
  private dirty = true;

  constructor(
    private cfg: LocalConfig,
    private app: AppClient,
  ) {
    this.model = cfg.embedModel;
    if (this.model) this.load();
  }

  get count() {
    return this.items.size;
  }

  /** Reads the store, starting a new one when there is none or it was made with another model. */
  private load() {
    try {
      const meta = existsSync(metaPath()) ? (JSON.parse(readFileSync(metaPath(), 'utf8')) as { store?: string; model?: string }) : null;
      if (meta?.store && meta.model === this.model && existsSync(dataPath())) {
        this.store = meta.store;
        for (const line of readFileSync(dataPath(), 'utf8').split('\n')) {
          if (!line) continue;
          this.lines += 1;
          try {
            const r = JSON.parse(line) as { id: string; at: number; v: string };
            this.items.set(r.id, { at: r.at, v: fromB64(r.v) });
          } catch {
            // A half-written last line after a crash; the item is embedded again later.
          }
        }
        log(`embeddings: ${this.items.size} items in the store (${this.model})`);
        return;
      }
    } catch (err) {
      log('embeddings: store unreadable, starting a new one:', err);
    }
    this.store = `${randomUUID()}:${this.model}`;
    this.items.clear();
    rmSync(dataPath(), { force: true });
    writeFileSync(metaPath(), JSON.stringify({ store: this.store, model: this.model }));
    log(`embeddings: new store for ${this.model}; the app will queue every item`);
  }

  private add(id: string, at: number, v: Float32Array) {
    this.items.set(id, { at, v });
    appendFileSync(dataPath(), JSON.stringify({ id, at, v: toB64(v) }) + '\n');
    this.lines += 1;
  }

  /** Rewrites the file without the older copies of items that were embedded again. */
  private compact() {
    if (this.lines < 1000 || this.lines < this.items.size * 1.5) return;
    const tmp = `${dataPath()}.tmp`;
    writeFileSync(tmp, [...this.items].map(([id, e]) => JSON.stringify({ id, at: e.at, v: toB64(e.v) })).join('\n') + '\n');
    renameSync(tmp, dataPath());
    this.lines = this.items.size;
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
    const res = await fetch(`${this.cfg.ollamaUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${path} ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  /** Makes sure the embedding model is in Ollama, downloading it (a few hundred MB) the first time. */
  private async ensureModel(): Promise<boolean> {
    if (this.ready) return true;
    if (Date.now() - this.failedAt < 3_600_000) return false;
    try {
      const res = await fetch(`${this.cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      const tags = (await res.json()) as { models?: { name: string }[] };
      const have = (tags.models ?? []).some((m) => m.name === this.model || m.name === `${this.model}:latest`);
      if (!have) {
        log(`embeddings: downloading ${this.model} into Ollama (one time)`);
        await this.post('/api/pull', { model: this.model, stream: false }, 10 * 60_000);
      }
      this.ready = true;
      return true;
    } catch (err) {
      this.failedAt = Date.now();
      log(`embeddings: ${this.model} not available, trying again in an hour:`, err);
      return false;
    }
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    // nomic-embed-text expects a task prefix.
    const input = /nomic/i.test(this.model ?? '') ? texts.map((t) => `search_document: ${t}`) : texts;
    const r = await this.post<{ embeddings?: number[][] }>('/api/embed', { model: this.model, input, truncate: true });
    if (!Array.isArray(r.embeddings) || r.embeddings.length !== texts.length) throw new Error('embedding reply had the wrong shape');
    return r.embeddings.map(normalise);
  }

  /** The closest older items, most similar first. */
  private neighbours(id: string, at: number, v: Float32Array): [string, number][] {
    const best: [string, number][] = [];
    for (const [other, e] of this.items) {
      if (other === id || e.at >= at) continue;
      const sim = dot(v, e.v);
      if (sim < MIN_SIMILARITY) continue;
      if (best.length < NEIGHBOURS) {
        best.push([other, sim]);
        if (best.length === NEIGHBOURS) best.sort((a, b) => b[1] - a[1]);
      } else if (sim > best[NEIGHBOURS - 1]![1]) {
        best[NEIGHBOURS - 1] = [other, sim];
        best.sort((a, b) => b[1] - a[1]);
      }
    }
    return best.sort((a, b) => b[1] - a[1]).map(([i, s]) => [i, Math.round(s * 1000) / 1000]);
  }

  /** Embeds waiting items (a backlog a few hundred per round), then rescores Likely interesting if anything changed. */
  async run(config: HelperConfig, between: () => Promise<void>): Promise<void> {
    if (!this.model || config.paused) return;
    if (config.embedWaiting) {
      if (!(await this.ensureModel())) return;
      for (let round = 0; round < 8; round++) {
        const { jobs } = await this.app.embedClaim(CLAIM);
        if (jobs.length === 0) break;
        const started = performance.now();
        for (let i = 0; i < jobs.length; i += BATCH) {
          await between();
          const batch = jobs.slice(i, i + BATCH);
          const vectors = await this.embed(batch.map((j) => j.text));
          const results: EmbedResult[] = batch.map((j, k) => {
            const v = vectors[k]!;
            this.add(j.itemId, j.receivedAt, v);
            return { itemId: j.itemId, neighbours: this.neighbours(j.itemId, j.receivedAt, v) };
          });
          await this.app.embedResult(results);
        }
        this.dirty = true;
        log(`embeddings: ${jobs.length} items in ${((performance.now() - started) / 1000).toFixed(1)}s (${this.items.size} stored)`);
        if (jobs.length < CLAIM) break;
      }
      this.compact();
    }
    const key = config.interestingKey ?? '';
    if (this.dirty || key !== this.lastKey) {
      await this.rescore();
      this.lastKey = key;
      this.dirty = false;
    }
  }

  /**
   * For feed suggestions: how close a site's latest posts are to the items
   * marked Interesting (the average of each post's three closest stars, over
   * the better half of the posts), and the reader's items closest to them.
   * Null fit when there's no model or fewer than three stars.
   */
  async closeness(texts: string[], interesting: string[]): Promise<{ fit: number | null; near: string[] }> {
    if (!this.model || texts.length === 0 || this.items.size === 0 || !(await this.ensureModel())) return { fit: null, near: [] };
    const vectors = await this.embed(texts);
    const stars = interesting.map((id) => this.items.get(id)?.v).filter((v): v is Float32Array => Boolean(v));
    let fit: number | null = null;
    if (stars.length >= 3) {
      const per = vectors
        .map((v) => {
          const top = stars.map((s) => dot(v, s)).sort((a, b) => b - a).slice(0, 3);
          return top.reduce((a, b) => a + b, 0) / top.length;
        })
        .sort((a, b) => b - a);
      const half = per.slice(0, Math.max(1, Math.ceil(per.length / 2)));
      fit = half.reduce((a, b) => a + b, 0) / half.length;
    }
    const best = new Map<string, number>();
    for (const v of vectors) {
      for (const [id, sim] of this.neighbours('', Infinity, v).slice(0, 3)) best.set(id, Math.max(best.get(id) ?? 0, sim));
    }
    const near = [...best].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
    return { fit, near };
  }

  /** The average similarity to the three closest of `marks` (one oddball mark isn't enough). */
  private static closest3(v: Float32Array, marks: Float32Array[]): number {
    const top = marks.map((m) => dot(v, m)).sort((a, b) => b - a).slice(0, 3);
    return top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
  }

  /**
   * Flags recent items close in meaning to the ones marked Not interested, and not
   * closer to the stars: "Probably not for you". Same share of items as Likely
   * interesting, never an item already Likely interesting. Sends only the changes.
   */
  private async rescoreUnlikely(state: LikelyState, stars: Float32Array[], likely: Set<string>) {
    if (!state.notInterested || !state.unlikely) return; // an older app that doesn't know the flag
    const marked = new Set(state.notInterested);
    const nis = state.notInterested.map((id) => this.items.get(id)?.v).filter((v): v is Float32Array => Boolean(v));
    const next = new Set<string>();
    if (nis.length >= MIN_NOT_INTERESTED) {
      const since = Date.now() - RECENT_MS;
      const starred = new Set(state.interesting);
      const scored: [string, number][] = [];
      for (const [id, e] of this.items) {
        if (e.at < since || marked.has(id) || starred.has(id) || likely.has(id)) continue;
        const no = Embeddings.closest3(e.v, nis);
        const yes = stars.length ? Embeddings.closest3(e.v, stars) : 0;
        if (no >= UNLIKELY_FLOOR && no >= yes + UNLIKELY_MARGIN) scored.push([id, no]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const share = typeof state.share === 'number' && state.share > 0 && state.share <= 50 ? state.share / 100 : LIKELY_SHARE;
      // Of the recent items, at most the same share as Likely interesting.
      let recent = 0;
      for (const e of this.items.values()) if (e.at >= since) recent += 1;
      for (const [id] of scored.slice(0, Math.floor(recent * share))) next.add(id);
    }
    const now = new Set(state.unlikely);
    const set = [...next].filter((id) => !now.has(id));
    const unset = [...now].filter((id) => !next.has(id));
    if (set.length || unset.length) {
      await this.app.likelySave(set, unset, -1);
      log(`probably not for you: ${next.size} flagged (+${set.length} -${unset.length}) from ${nis.length} Not interested marks`);
    }
  }

  /** Flags recent items close in meaning to the ones marked Interesting; sends only the changes. */
  private async rescore() {
    const state = await this.app.likelyState();
    const stars = state.interesting.map((id) => this.items.get(id)?.v).filter((v): v is Float32Array => Boolean(v));
    const starred = new Set(state.interesting);
    const next = new Set<string>();
    if (stars.length >= MIN_STARS) {
      const since = Date.now() - RECENT_MS;
      const scored: [string, number][] = [];
      for (const [id, e] of this.items) {
        if (e.at < since || starred.has(id)) continue;
        // The average of the three closest stars: near one oddball star isn't enough.
        const sims = stars.map((s) => dot(e.v, s)).sort((a, b) => b - a);
        const top = sims.slice(0, 3);
        scored.push([id, top.reduce((a, b) => a + b, 0) / top.length]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const share = typeof state.share === 'number' && state.share > 0 && state.share <= 50 ? state.share / 100 : LIKELY_SHARE;
      const cut = Math.max(scored[Math.floor(scored.length * share)]?.[1] ?? 1, LIKELY_FLOOR);
      for (const [id, score] of scored) if (score >= cut) next.add(id);
    }
    const now = new Set(state.likely);
    const set = [...next].filter((id) => !now.has(id));
    const unset = [...now].filter((id) => !next.has(id));
    if (set.length || unset.length) {
      await this.app.likelySave(set, unset);
      log(`likely interesting: ${next.size} flagged (+${set.length} -${unset.length}) from ${stars.length} stars`);
    }
    await this.rescoreUnlikely(state, stars, next);
  }
}
