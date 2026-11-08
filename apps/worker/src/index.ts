import { app } from './api';
import { snapshotBacklog } from './backlog';
import { tidyDeleted } from './deleting';
import { buildDigestIfDue } from './digest';
import { handleEmail } from './email';
import type { Env } from './env';
import { runFeedChecks } from './feeds';
import { scoreRecentItems } from './scoring';

/** Must match the first cron in wrangler.jsonc; the others only check feeds. */
const HOURLY = '5 * * * *';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  email: (message, env) => handleEmail(message, env),
  // Every 15 minutes: note the AI backlog, then check the feeds that are due. Hourly also: refresh
  // scores for the last week of items, then build the daily digest once the
  // reader's chosen hour comes round, and tidy up items deleted more than ten minutes ago.
  scheduled: async (event, env) => {
    if (event.cron === HOURLY) {
      await scoreRecentItems(env);
      await buildDigestIfDue(env);
      await tidyDeleted(env).catch((err: unknown) => console.error('tidying deleted items failed', err));
    }
    await snapshotBacklog(env).catch((err: unknown) => console.error('backlog snapshot failed', err));
    await runFeedChecks(env);
  },
} satisfies ExportedHandler<Env>;
