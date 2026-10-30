import { HELPER_VERSION, type HelperConfig, type HelperJob, type ModelRef, type TrialResultInput } from '@newsletterapp/shared';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppClient } from './app';
import { UPDATED_EXIT_CODE } from './constants';
import { loadConfig, type LocalConfig } from './config';
import { log } from './log';
import { findProvider, providersFrom, type Provider } from './providers';
import { currentLoad, powerMeter } from './system';
import { itemText, parseOutput } from './text';

// The PC helper: every minute it checks in with the app, then summarises a
// few waiting items with the first switched-on model and posts the results.
// It only ever makes outbound requests.

const cfg = loadConfig();
const app = new AppClient(cfg);
const providers = providersFrom(cfg);
const once = process.argv.includes('--once');

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
  return app.heartbeat({ version: HELPER_VERSION, hostname: hostname(), models, providerErrors, load: await currentLoad() });
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
  const started = performance.now();
  const meter = powerMeter();
  try {
    const reply = await provider.complete(model, prompt, user);
    return { output: parseOutput(reply), seconds: (performance.now() - started) / 1000, watts: meter.stop() };
  } catch (err) {
    throw new RunError(err instanceof Error ? err.message : String(err), (performance.now() - started) / 1000, meter.stop());
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
  const model = config.models.find((m) => findProvider(providers, m));
  if (!model) return log('No switched-on model is available on this PC');
  const provider = findProvider(providers, model)!;

  const { jobs } = await app.claim(config.batchSize);
  for (const [i, job] of jobs.entries()) {
    const base = { itemId: job.itemId, provider: model.provider, model: model.name, promptId: job.promptId, promptVersion: job.promptVersion };
    let res: Awaited<ReturnType<typeof app.result>>;
    try {
      const { output, seconds, watts } = await run(provider, model.name, job.prompt, userMessage(job, cfg));
      res = await app.result({ ...base, ok: true, seconds, watts, output });
      log(`summarised "${job.subject.slice(0, 60)}" with ${model.name} in ${seconds.toFixed(1)}s${watts ? ` at ${Math.round(watts)} W` : ''}`);
    } catch (err) {
      const { error, seconds, watts } = failure(err);
      log(`failed "${job.subject.slice(0, 60)}" with ${model.name}: ${error}`);
      res = await app.result({ ...base, ok: false, seconds, watts, error });
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

/** Test mode: every chosen model on every chosen item, results side by side in the app. */
async function runTrial(trialId: string) {
  const trial = await app.trial(trialId);
  log(`test run ${trialId}: ${trial.items.length} items x ${trial.models.length} models`);
  for (const ref of trial.models as ModelRef[]) {
    const provider = findProvider(providers, ref);
    const results: TrialResultInput[] = [];
    for (const item of trial.items) {
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

async function tick(): Promise<number> {
  const config = await heartbeat();
  if (config.latestHelperVersion && config.latestHelperVersion !== HELPER_VERSION && !once) {
    await selfUpdate(config.latestHelperVersion).catch((err: unknown) => log('update failed, carrying on:', err));
  }
  if (config.trialId) await runTrial(config.trialId);
  await summariseQueue(config);
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
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

void main();
