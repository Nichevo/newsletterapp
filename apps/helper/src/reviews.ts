import type { FindingKind, HelperConfig, ModelRef, ReviewJob, ReviewResult } from '@newsletterapp/shared';
import type { AppClient } from './app';
import type { LocalConfig } from './config';
import { log } from './log';
import { braveSearch, wikipedia, type Found } from './lookups';
import { findProvider, type Provider } from './providers';
import { powerMeter } from './system';

// Weekly and monthly reviews. The app gathers the facts; the PC:
//  1. writes the opening, a line per story, the stars' common thread and any
//     dates coming up, and suggests questions worth a web search (one call);
//  2. looks each question up: Wikipedia for background terms (free), Brave
//     web search for the rest, up to the number of searches the app allows;
//  3. writes a short finding from each question's results (one small call
//     each), dropping the ones the model says don't add anything.
// "Find more" runs only steps 2 and 3, with a few new questions.

const KINDS: FindingKind[] = ['new', 'link', 'background', 'check', 'next'];

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    opening: { type: 'string' },
    stories: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, line: { type: 'string' } }, required: ['id', 'line'] } },
    thread: { type: 'string' },
    stars_say: { type: 'string' },
    coming: {
      type: 'array',
      items: { type: 'object', properties: { date: { type: 'string' }, what: { type: 'string' }, item: { type: 'number' } }, required: ['date', 'what'] },
    },
    questions: {
      type: 'array',
      items: { type: 'object', properties: { q: { type: 'string' }, kind: { type: 'string' }, about: { type: 'string' } }, required: ['q', 'kind'] },
    },
  },
  required: ['opening', 'stories', 'thread', 'coming', 'questions'],
};

const QUESTIONS_SCHEMA = { type: 'object', properties: { questions: WRITE_SCHEMA.properties.questions }, required: ['questions'] };

const FIND_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    sources: { type: 'array', items: { type: 'number' } },
    useful: { type: 'boolean' },
    bridge: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'sources', 'useful'],
};

interface Question {
  q: string;
  kind: FindingKind;
  about: string;
}

const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/** The JSON object in a reply (some models wrap it in prose or code fences). */
function jsonOf(reply: string): Record<string, unknown> {
  const cleaned = stripThinking(reply).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function questionsOf(v: unknown, max: number, asked: string[]): Question[] {
  const seen = new Set(asked.map((a) => a.toLowerCase()));
  const out: Question[] = [];
  for (const q of Array.isArray(v) ? v : []) {
    const text = str((q as { q?: unknown })?.q);
    const kind = str((q as { kind?: unknown })?.kind) as FindingKind;
    if (!text || !KINDS.includes(kind) || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ q: text.slice(0, 200), kind, about: str((q as { about?: unknown })?.about).slice(0, 120) });
    if (out.length >= max) break;
  }
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripTags = (s: string) => squash(s.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

class Timer {
  seconds = 0;
  watts: number | undefined;
  async run<T>(f: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const meter = powerMeter();
    try {
      return await f();
    } finally {
      this.seconds += (performance.now() - started) / 1000;
      const w = meter.stop();
      if (w) this.watts = Math.max(this.watts ?? 0, w);
    }
  }
}

/** Looks one question up. Background terms go to Wikipedia (no search used); the rest to Brave. */
async function lookUp(q: Question, cfg: LocalConfig, searchesLeft: number): Promise<{ found: Found[]; searched: boolean; missing?: string }> {
  if (q.kind === 'background') {
    const page = await wikipedia(q.q).catch(() => null);
    if (page) return { found: [page], searched: false };
  }
  if (!cfg.braveApiKey) return { found: [], searched: false, missing: 'no Brave key on this PC' };
  if (searchesLeft <= 0) return { found: [], searched: false, missing: 'no searches left for this review' };
  const query = [q.q, q.kind === 'link' || q.kind === 'next' ? '' : q.about].filter(Boolean).join(' ').slice(0, 200);
  const results = await braveSearch(query, cfg.braveApiKey, 6);
  return {
    searched: true,
    found: results.map((r) => ({ title: stripTags(r.title), url: r.url, text: stripTags([r.description ?? '', ...(r.extra_snippets ?? [])].join(' ')).slice(0, 700) })),
  };
}

export async function runReview(config: HelperConfig, app: AppClient, cfg: LocalConfig, providers: Provider[], doing: (what: string) => void): Promise<void> {
  if (!config.reviewWaiting || config.paused || config.limited) return;
  const model: ModelRef | undefined = config.models.find((m) => findProvider(providers, m));
  if (!model) return;
  const provider = findProvider(providers, model)!;
  const { job } = await app.reviewClaim();
  if (!job) return;
  const timer = new Timer();
  const base = { reviewId: job.reviewId, provider: model.provider, model: model.name };
  const name = `${job.kind === 'week' ? 'weekly' : 'monthly'} review`;
  try {
    const result = await writeReview(job, cfg, provider, model.name, timer, doing, name);
    await app.reviewResult({ ...base, ...result, ok: true, seconds: timer.seconds, watts: timer.watts });
    log(`${name} with ${model.name} in ${timer.seconds.toFixed(0)}s: ${result.findings?.length ?? 0} findings from ${result.searches} searches`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`${name} failed with ${model.name}: ${error}`);
    await app.reviewResult({ ...base, ok: false, seconds: timer.seconds, watts: timer.watts, error, searches: 0 });
  }
}

async function writeReview(
  job: ReviewJob,
  cfg: LocalConfig,
  provider: Provider,
  model: string,
  timer: Timer,
  doing: (what: string) => void,
  name: string,
): Promise<Omit<ReviewResult, 'reviewId' | 'ok' | 'provider' | 'model' | 'seconds' | 'watts'>> {
  const out: Omit<ReviewResult, 'reviewId' | 'ok' | 'provider' | 'model' | 'seconds' | 'watts'> = { searches: 0, findings: [] };
  let questions: Question[];
  if (job.mode === 'write') {
    doing(`writing the ${name}`);
    const reply = await timer.run(() => provider.complete(model, job.writePrompt, job.text, { json: true, schema: WRITE_SCHEMA }));
    const v = jsonOf(reply);
    const storyLines: Record<string, string> = {};
    for (const s of Array.isArray(v.stories) ? v.stories : []) {
      const id = str((s as { id?: unknown })?.id).replace(/^story\s+/i, '');
      const line = str((s as { line?: unknown })?.line);
      if (id && line) storyLines[id] = line;
    }
    out.written = {
      opening: str(v.opening),
      storyLines,
      thread: str(v.thread),
      starsSay: str(v.stars_say),
      coming: (Array.isArray(v.coming) ? v.coming : []).map((c) => ({
        date: str((c as { date?: unknown })?.date),
        what: str((c as { what?: unknown })?.what),
        item: Number((c as { item?: unknown })?.item) || undefined,
      })) as NonNullable<ReviewResult['written']>['coming'],
    };
    questions = questionsOf(v.questions, Math.max(job.searches, 3), job.asked);
  } else {
    doing(`more questions for the ${name}`);
    const reply = await timer.run(() =>
      provider.complete(model, job.questionPrompt, `${job.text}\n\nQuestions asked already:\n${job.asked.map((q) => `- ${q}`).join('\n') || '(none)'}`, {
        json: true,
        schema: QUESTIONS_SCHEMA,
      }),
    );
    questions = questionsOf(jsonOf(reply).questions, job.searches, job.asked);
  }

  // Background terms cost no searches, so they don't count towards the limit.
  const missing = new Set<string>();
  let searchesLeft = job.searches;
  const answerable = (job.further ? questions : []).filter((q) => q.kind === 'background' || searchesLeft > 0).slice(0, job.searches + 3);
  for (const [i, q] of answerable.entries()) {
    doing(`${name}: looking up ${i + 1} of ${answerable.length}`);
    let looked: Awaited<ReturnType<typeof lookUp>>;
    try {
      looked = await lookUp(q, cfg, searchesLeft);
    } catch (err) {
      log(`${name}: lookup failed for "${q.q.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (looked.searched) {
      searchesLeft--;
      out.searches++;
    }
    if (looked.missing) missing.add(looked.missing);
    if (looked.found.length === 0) continue;
    const results = looked.found.map((f, n) => `[${n + 1}] ${f.title} (${f.url})\n${f.text}`).join('\n\n');
    const user = [`Question (${q.kind}): ${q.q}`, q.about ? `About: ${q.about}` : '', '', 'Search results:', results].filter(Boolean).join('\n');
    try {
      const reply = await timer.run(() => provider.complete(model, job.findPrompt, user, { json: true, schema: FIND_SCHEMA }));
      const v = jsonOf(reply);
      const answer = str(v.answer);
      if (!answer || v.useful === false) continue;
      const used = (Array.isArray(v.sources) ? v.sources : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= looked.found.length);
      const sources = (used.length ? used : [1]).map((n) => ({ title: looked.found[n - 1]!.title, url: looked.found[n - 1]!.url }));
      const bridge = Array.isArray(v.bridge) ? v.bridge.map(str).filter(Boolean) : [];
      out.findings!.push({
        kind: q.kind,
        question: q.q,
        answer,
        sources,
        ...(q.kind === 'link' && bridge.length === 3 ? { bridge: bridge as [string, string, string] } : {}),
      });
    } catch (err) {
      log(`${name}: finding failed for "${q.q.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (missing.size) out.note = `Some questions weren't looked up: ${[...missing].join('; ')}.`;
  return out;
}
