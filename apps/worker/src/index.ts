import { app } from './api';
import { snapshotBacklog } from './backlog';
import { tidyDeleted } from './deleting';
import { handleEmail } from './email';
import type { Env } from './env';
import { runFeedChecks } from './feeds';
import { buildReviewsIfDue } from './reviews';
import { buildCatchUpIfDue } from './catchup';
import { scoreRecentItems } from './scoring';
import { runSecurityChecks } from './security';
import { runStatusChecks } from './status';
import { refreshProblemsSummary, tidyLog } from './problems';

/** Must match the first cron in wrangler.jsonc; the others only check feeds. */
const HOURLY = '5 * * * *';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  email: (message, env) => handleEmail(message, env),
  // Every 15 minutes: note the AI backlog, then check the feeds that are due. Hourly also: refresh
  // scores for the last week of items, then build the weekly or monthly review once
  // its day and hour come round, and tidy up items deleted more than ten minutes ago.
  // Every run ends with the service status checks that are due, then works out the app's own problems.
  scheduled: async (event, env) => {
    if (event.cron === HOURLY) {
      await scoreRecentItems(env);
      await buildReviewsIfDue(env).catch((err: unknown) => console.error('reviews failed', err));
      // Morning catch-up: at its hour, or after a long break with a big pile.
      await buildCatchUpIfDue(env).catch((err: unknown) => console.error('catch-up failed', err));
      await tidyDeleted(env).catch((err: unknown) => console.error('tidying deleted items failed', err));
      await tidyLog(env).catch((err: unknown) => console.error('tidying the app log failed', err));
      // Security alerts (Settings > Security alerts): HIBP's newest breach and a few detail refreshes.
      await runSecurityChecks(env).catch((err: unknown) => console.error('security checks failed', err instanceof Error ? err.message : err));
    }
    await snapshotBacklog(env).catch((err: unknown) => console.error('backlog snapshot failed', err));
    await runFeedChecks(env);
    // Service status pages (Settings > System status): a few small checks per run.
    await runStatusChecks(env, event.cron === HOURLY).catch((err: unknown) => console.error('status checks failed', err));
    // App problems (a source gone quiet, a site turning the PC away, the helper offline): the inbox's Status button and banner.
    await refreshProblemsSummary(env).catch((err: unknown) => console.error('app problems failed', err));
  },
} satisfies ExportedHandler<Env>;
