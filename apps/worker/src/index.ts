import { app } from './api';
import { handleEmail } from './email';
import type { Env } from './env';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  email: (message, env) => handleEmail(message, env),
} satisfies ExportedHandler<Env>;
