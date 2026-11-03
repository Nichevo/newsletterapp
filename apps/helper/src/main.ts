import { HELPER_VERSION, type AskJob, type HelperConfig, type HelperJob, type ModelRef, type TrialResultInput } from '@newsletterapp/shared';
import { statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppClient } from './app';
import { UPDATED_EXIT_CODE } from './constants';
import { configPath, loadConfig, type LocalConfig } from './config';
import { Embeddings } from './embed';
import { askLookups, lookupsText, summaryLookups, toSources, type Lookups } from './lookups';
import { holdReport, holdsSent, runFetchJob, setSkipSites } from './fetch';
import { log } from './log';
import { findProvider, providersFrom, type Provider } from './providers';
import { currentLoad, powerMeter } from './system';
import { itemText, parseOutput } from './text';

// The PC helper: every minute it checks in with the app, answers any
// questions about highlighted text first, does any feed, website or
// full-article fetches the app has queued for the PC, then summarises a few
// waiting items with the first switched-on model (or the one the app names,
// when it splits the work) and posts the results. Between those rounds it
// checks for new highlight questions every few seconds, and between
// summaries too, so an answer doesn't wait behind a long batch. It only ever
// makes outbound requests.

const cfg = loadConfig();
const app = new AppClient(cfg);
const providers = providersFrom(cfg);
const embeddings = new Embeddings(cfg, app);
const once = process.argv.includes('--once');
const configMtime = () => {
  try {
    return statSync(configPath()).mtimeMs;
  } catch {
    return 0;
  }
};
const startedConfig = configMtime();
const supervisorPid = Number(process.env.HELPER_SUPERVISOR_PID) || null;

/**
 * Stops this worker when it would otherwise run on with stale settings: the
 * config file changed (e.g. a Brave key was added by re-running the installer),
 * so the supervisor starts it again with the new one; or the supervisor itself
 * is gone (Windows stops a scheduled task's own process but not its children),
 * so a leftover copy doesn't carry on beside the new one.
 */
function restartIfStale() {
  if (once) return;
  if (supervisorPid) {
    try {
      process.kill(supervisorPid, 0);
    } catch {
      log('supervisor is gone; this leftover copy is stopping');
      process.exit(0);
    }
  }
  if (configMtime() !== startedConfig) {
    log('config changed; restarting to pick it up');
    process.exit(UPDATED_EXIT_CODE);
  }
}

async function heartbeat(): Promise<HelperConfig> {
  const models: { provider: string; name: string; sizeBytes?: number }[] = [];
  const providerErrors: { provider: string; error: string }[] = [];
  for (const p of providers) {
    try {
      for (const m of await p.listModels()) models.push({ provider: p.name, ...m });
    } catch (err) {
      providerErrors.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const report = holdReport();
  const config = await app.heartbeat({
    version: HELPER_VERSION,
    hostname: hostname(),
    models,
    providerErrors,
    load: await currentLoad(),
    webSearch: cfg.braveApiKey ? 'brave' : null,
    embedStore: embeddings.model ? embeddings.store : null,
    embedCount: embeddings.count,
    ...report,
  });
  holdsSent(report.holds);
  setSkipSites(config.skipSites);
  return config;
}

function userMessage(job: Pick<HelperJob, 'sourceName' | 'fromName' | 'subject' | 'html' | 'text'>, c: LocalConfig): string {
  return [
    `Sender: ${job.sourceName ?? job.fromName ?? 'unknown'}`,
    `Subject: ${job.subject}`,
    '',
    itemText(job.html, job.text, c.maxChars),
  ].join('\n');
}

class RunError extends Error {
  constructor(
    message: string,
    public seconds: number,
    public watts: number | undefined,
  ) {
    super(message);
  }
}

/** Runs one item, timing it and measuring the GPU's draw; a failure still reports the time it took. */
async function run(provider: Provider, model: string, prompt: string, user: string) {
  const { reply, seconds, watts } = await runText(provider, model, prompt, user, true);
  try {
    return { output: parseOutput(reply), seconds, watts };
  } catch (err) {
    throw new RunError(err instanceof Error ? err.message : String(err), seconds, watts);
  }
}

/** One model call, timed and metered; `json` asks for the summary JSON, otherwise plain text. */
async function runText(provider: Provider, model: string, prompt: string, user: string, json: boolean) {
  const started = performance.now();
  const meter = powerMeter();
  try {
    const reply = await provider.complete(model, prompt, user, { json });
    return { reply, seconds: (performance.now() - started) / 1000, watts: meter.stop() };
  } catch (err) {
    throw new RunError(err instanceof Error ? err.message : String(err), (performance.now() - started) / 1000, meter.stop());
  }
}

// ---------- Questions about highlighted text ----------

/** The model list from the latest check-in, so asks between rounds know which model to use. */
let currentModels: ModelRef[] = [];
let askPollSeconds = 10;
let lastPeek = 0;

function askMessage(job: AskJob, c: LocalConfig, lookups: Lookups): string {
  const found = lookupsText(lookups.found);
  return [
    `Sender: ${job.sourceName ?? job.fromName ?? 'unknown'}`,
    `Subject: ${job.subject}`,
    '',
    'Article:',
    itemText(job.html, job.text, c.maxChars),
    '',
    `Highlighted passage: "${job.quote}"`,
    ...(job.question ? [`Question: ${job.question}`] : []),
    ...(found
      ? [
          '',
          'Looked up for you (Wikipedia, linked pages and web search; may be incomplete or out of date). Prefer this over your own memory for facts, and link the pages you use as [title](url):',
          found,
        ]
      : []),
  ].join('\n');
}

const NO_LOOKUPS: Lookups = { found: [], searches: 0, missing: [] };
/** Lookups for one question never hold the queue up longer than this; the model answers without them. */
const LOOKUP_LIMIT_MS = 3 * 60_000;
const lookupFailed = (err: unknown): Lookups => ({
  ...NO_LOOKUPS,
  missing: [`lookups (${err instanceof Error ? err.message : String(err)})`],
});
function withinTime<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took over ${Math.round(ms / 60_000)} minutes`)), ms);
    }),
  ]);
}

/** Extra instructions for a summary that comes with web search results. */
const SEARCH_RULES = `

You also get web search results for this issue's headline. Add two more fields to the JSON:
"background": one sentence of context the issue assumes the reader knows, from the search results; empty if nothing useful
"coverage": up to 3 {"title", "url"} from the search results that report the same story elsewhere; [] if none
Only use URLs that appear in the search results.`;

const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/** Answers waiting highlight asks with the first switched-on model. Never throws. */
async function answerAsks(models: ModelRef[] = currentModels): Promise<void> {
  const model = (models.length ? models : currentModels).find((m) => findProvider(providers, m));
  if (!model) return;
  try {
    for (let round = 0; round < 5; round++) {
      const { jobs } = await app.askClaim(2);
      if (jobs.length === 0) return;
      for (const job of jobs) {
        const ref = job.model && findProvider(providers, job.model) ? job.model : model;
        const provider = findProvider(providers, ref)!;
        const base = { askId: job.askId, provider: ref.provider, model: ref.name };
        doing(`question "${job.quote.slice(0, 50)}"`);
        log(`question "${job.quote.slice(0, 50)}": ${job.lookups && job.lookups !== 'none' ? `looking up (${job.lookups}) first` : 'no lookups'}`);
        const lookups =
          job.lookups && job.lookups !== 'none' ? await withinTime(askLookups(job, cfg), LOOKUP_LIMIT_MS, 'lookups').catch(lookupFailed) : NO_LOOKUPS;
        if (lookups.missing.length) log(`couldn't use ${lookups.missing.join('; ')}`);
        const extra = {
          searches: lookups.searches,
          sources: toSources(lookups.found),
          lookupNote: lookups.missing.length ? `Couldn't use ${lookups.missing.join('; ')}` : undefined,
        };
        if (lookups.found.length) log(`looked up ${lookups.found.length} page(s) for "${job.quote.slice(0, 40)}"`);
        try {
          const { reply, seconds, watts } = await runText(provider, ref.name, job.prompt, askMessage(job, cfg, lookups), false);
          const answer = stripThinking(reply);
          await app.askResult({
            ...base,
            ...extra,
            ok: answer.length > 0,
            seconds,
            watts,
            answer,
            error: answer ? undefined : 'The model returned an empty answer',
          });
          log(`answered "${job.quote.slice(0, 50)}" with ${ref.name} in ${seconds.toFixed(1)}s`);
        } catch (err) {
          const { error, seconds, watts } = failure(err);
          log(`ask failed "${job.quote.slice(0, 50)}" with ${ref.name}: ${error}`);
          await app.askResult({ ...base, searches: lookups.searches, ok: false, seconds, watts, error });
        }
      }
    }
  } catch (err) {
    log('highlight asks failed:', err);
  }
}

/** A quick, cheap check for new asks (at most every few seconds), answering any that are waiting. */
async function checkAsks(): Promise<void> {
  if (Date.now() - lastPeek < askPollSeconds * 1000) return;
  lastPeek = Date.now();
  try {
    const { waiting } = await app.askPeek();
    if (waiting > 0) await answerAsks();
  } catch (err) {
    log('ask check failed:', err);
  }
}

const failure = (err: unknown) => ({
  error: err instanceof Error ? err.message : String(err),
  seconds: err instanceof RunError ? err.seconds : 0,
  watts: err instanceof RunError ? err.watts : undefined,
});

const until = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function summariseQueue(config: HelperConfig) {
  if (config.paused) return log('AI is paused in the app; not taking work');
  if (config.limited) return log(`usage limit: ${config.limited.message}; back at ${until(config.limited.until)}`);
  const first = config.models.find((m) => findProvider(providers, m));
  if (!first) return log('No switched-on model is available on this PC');

  const { jobs } = await app.claim(config.batchSize);
  for (const [i, job] of jobs.entries()) {
    // A question asked while this batch runs goes first.
    if (i > 0) await checkAsks();
    // When the app splits the work between models it names one per job; otherwise use the first.
    doing(`summarising "${job.subject.slice(0, 60)}"`);
    const model = job.model && findProvider(providers, job.model) ? job.model : first;
    const provider = findProvider(providers, model)!;
    const base = { itemId: job.itemId, provider: model.provider, model: model.name, promptId: job.promptId, promptVersion: job.promptVersion };
    let res: Awaited<ReturnType<typeof app.result>>;
    const lookups = job.search ? await withinTime(summaryLookups(job, cfg), LOOKUP_LIMIT_MS, 'lookups').catch(() => NO_LOOKUPS) : NO_LOOKUPS;
    const searchText = lookupsText(lookups.found);
    try {
      const { output, seconds, watts } = await run(
        provider,
        model.name,
        searchText ? job.prompt + SEARCH_RULES : job.prompt,
        searchText ? `${userMessage(job, cfg)}\n\nWeb search results for the headline:\n${searchText}` : userMessage(job, cfg),
      );
      // Background and other coverage only come from search results, and only links that were in them.
      if (!searchText) {
        delete output.background;
        delete output.coverage;
      } else if (output.coverage) {
        const urls = new Set(lookups.found.map((f) => f.url));
        output.coverage = output.coverage.filter((c) => c && urls.has(c.url));
      }
      res = await app.result({ ...base, ok: true, seconds, watts, output, searches: lookups.searches });
      log(`summarised "${job.subject.slice(0, 60)}" with ${model.name} in ${seconds.toFixed(1)}s${watts ? ` at ${Math.round(watts)} W` : ''}`);
    } catch (err) {
      const { error, seconds, watts } = failure(err);
      log(`failed "${job.subject.slice(0, 60)}" with ${model.name}: ${error}`);
      res = await app.result({ ...base, ok: false, seconds, watts, error, searches: lookups.searches });
      if (res.paused) log('The app paused AI after repeated failures');
    }
    if (res.paused) break;
    if (res.limited) {
      // Hand the rest of the batch straight back rather than letting it time out.
      const rest = jobs.slice(i + 1).map((j) => j.itemId);
      if (rest.length) await app.release(rest).catch((err: unknown) => log('release failed:', err));
      log(`usage limit reached: ${res.limited.message}; back at ${until(res.limited.until)}`);
      break;
    }
  }
}

/** Feeds and websites Cloudflare can't fetch, website watches and full articles. A few rounds per minute at most. */
async function fetchQueue(config: HelperConfig) {
  if (!config.fetchWaiting) return;
  for (let round = 0; round < 4; round++) {
    const { jobs } = await app.fetchClaim(5);
    if (jobs.length === 0) return;
    for (const job of jobs) {
      // A question waiting shouldn't sit behind a run of slow web pages.
      await checkAsks();
      doing(`fetching ${job.kind} ${job.url.slice(0, 80)}`);
      const result = await runFetchJob(job, cfg);
      const res = await app.fetchResult(result);
      log(`${job.kind} ${job.url.slice(0, 80)}: ${result.ok ? (job.kind === 'article' ? 'article saved' : `${res.added ?? 0} new`) : result.error}`);
    }
  }
}

/** Test mode: every chosen model on every chosen item, results side by side in the app. */
async function runTrial(trialId: string) {
  const trial = await app.trial(trialId);
  log(`test run ${trialId}: ${trial.items.length} items x ${trial.models.length} models`);
  for (const ref of trial.models as ModelRef[]) {
    const provider = findProvider(providers, ref);
    const results: TrialResultInput[] = [];
    for (const item of trial.items) {
      doing(`test run: ${ref.name} on ${item.itemId}`);
      if (!provider) {
        results.push({ itemId: item.itemId, provider: ref.provider, model: ref.name, seconds: 0, error: `${ref.provider} is not set up on this PC` });
        continue;
      }
      try {
        const { output, seconds, watts } = await run(provider, ref.name, item.prompt, userMessage(item, cfg));
        results.push({ itemId: item.itemId, provider: ref.provider, model: ref.name, seconds, watts, output });
      } catch (err) {
        results.push({ itemId: item.itemId, provider: ref.provider, model: ref.name, ...failure(err) });
      }
    }
    await app.trialResults(trialId, results);
  }
  await app.trialDone(trialId);
}

/** Replaces this file with the version the app ships; the supervisor in entry.ts then restarts it. */
async function selfUpdate(version: string) {
  log(`updating helper ${HELPER_VERSION} -> ${version}`);
  const code = await app.download('/helper/newsletter-helper.mjs');
  if (!code.includes('Newsletter app PC helper')) throw new Error('downloaded file does not look like the helper');
  const self = fileURLToPath(import.meta.url);
  writeFileSync(self, code);
  process.exit(UPDATED_EXIT_CODE);
}

/** What the helper is doing right now, for the watchdog's log line. */
let step = 'starting';
let stepSince = Date.now();
const doing = (what: string) => {
  step = what;
  stepSince = Date.now();
};
/** No single step should take this long; past it the worker restarts (the supervisor starts it again). */
const STUCK_MS = 12 * 60_000;
if (!once) {
  setInterval(() => {
    if (Date.now() - stepSince < STUCK_MS) return;
    log(`stuck for ${Math.round((Date.now() - stepSince) / 60_000)} min on: ${step}; restarting`);
    process.exit(1);
  }, 60_000).unref();
}

async function tick(): Promise<number> {
  restartIfStale();
  doing('checking in with the app');
  const config = await heartbeat();
  if (config.latestHelperVersion && config.latestHelperVersion !== HELPER_VERSION && !once) {
    await selfUpdate(config.latestHelperVersion).catch((err: unknown) => log('update failed, carrying on:', err));
  }
  currentModels = config.models;
  askPollSeconds = config.askPollSeconds ?? askPollSeconds;
  // Questions about highlights come first: someone is waiting for those.
  doing('answering questions');
  if (config.asksWaiting && !config.paused) await answerAsks(config.models);
  lastPeek = Date.now();
  doing('test run');
  if (config.trialId) await runTrial(config.trialId);
  // Fetch problems must not hold up the summaries.
  doing('fetching feeds and pages');
  await fetchQueue(config).catch((err: unknown) => log('fetch jobs failed:', err));
  doing('summarising');
  await summariseQueue(config);
  // Embeddings after summaries, since they're made from the summary.
  doing('embedding items');
  await embeddings.run(config, checkAsks).catch((err: unknown) => log('embeddings failed:', err));
  doing('waiting for the next round');
  return config.pollSeconds;
}

async function main() {
  log(`helper ${HELPER_VERSION} starting, app ${cfg.appUrl}, providers: ${providers.map((p) => p.name).join(', ')}`);
  for (;;) {
    let wait = 60;
    try {
      wait = await tick();
    } catch (err) {
      log('error:', err);
      if (once) process.exitCode = 1;
    }
    if (once) return;
    // Wait for the next round, checking for highlight asks every few seconds meanwhile.
    const nextRound = Date.now() + wait * 1000;
    while (Date.now() < nextRound) {
      await new Promise((r) => setTimeout(r, Math.min(askPollSeconds * 1000, Math.max(nextRound - Date.now(), 0))));
      if (Date.now() < nextRound - 1000) await checkAsks();
    }
  }
}

void main();
