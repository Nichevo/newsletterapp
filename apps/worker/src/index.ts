import { app } from './api';
import { buildDigestIfDue } from './digest';
import { handleEmail } from './email';
import type { Env } from './env';
import { scoreRecentItems } from './scoring';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  email: (message, env) => handleEmail(message, env),
  // Hourly: refresh scores for the last week of items, then build the daily
  // digest once the reader's chosen hour comes round.
  scheduled: async (_event, env) => {
    await scoreRecentItems(env);
    await buildDigestIfDue(env);
  },
} satisfies ExportedHandler<Env>;
