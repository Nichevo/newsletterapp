#!/usr/bin/env node
// Runs in CI before `wrangler deploy`, from apps/worker.
//
// - Creates the D1 database and R2 bucket on first deploy and writes the
//   database id into wrangler.jsonc, so nobody has to paste ids around.
// - Copies deploy-time settings from environment variables (GitHub
//   repository variables) into the config: the app hostname and the
//   Cloudflare Access details.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CONFIG = 'wrangler.jsonc';
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

function wrangler(args, { json = false } = {}) {
  try {
    const out = execFileSync('pnpm', ['exec', 'wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return json ? JSON.parse(out) : out;
  } catch (err) {
    console.error(err.stdout ?? '', err.stderr ?? '');
    throw err;
  }
}

// --- D1 -------------------------------------------------------------------
const d1 = config.d1_databases[0];
let databases = wrangler(['d1', 'list', '--json'], { json: true });
let db = databases.find((d) => d.name === d1.database_name);
if (!db) {
  console.log(`Creating D1 database ${d1.database_name}`);
  wrangler(['d1', 'create', d1.database_name]);
  databases = wrangler(['d1', 'list', '--json'], { json: true });
  db = databases.find((d) => d.name === d1.database_name);
}
if (!db) throw new Error(`D1 database ${d1.database_name} not found after create`);
d1.database_id = db.uuid;
console.log(`D1 ${d1.database_name} = ${db.uuid}`);

// --- R2 -------------------------------------------------------------------
// `wrangler r2 bucket list` fails outright when R2 has never been enabled on
// the account (a one-time click in the dashboard, free tier), so explain that
// instead of letting `wrangler deploy` fail later with "bucket not found".
const bucket = config.r2_buckets[0].bucket_name;
let buckets;
try {
  buckets = wrangler(['r2', 'bucket', 'list'], { json: false });
} catch {
  console.error(
    `\nCould not list R2 buckets. Either R2 is not enabled on this Cloudflare account yet\n` +
      `(dashboard -> R2 Object Storage -> Get started; the free tier costs nothing) or the\n` +
      `API token is missing the "Workers R2 Storage: Edit" permission.\n`,
  );
  process.exit(1);
}
if (new RegExp(`^name:\\s+${bucket}$`, 'm').test(buckets)) {
  console.log(`R2 bucket ${bucket} already exists`);
} else {
  console.log(`Creating R2 bucket ${bucket}`);
  wrangler(['r2', 'bucket', 'create', bucket]);
}

// --- Hostname and settings ------------------------------------------------
const hostname = process.env.APP_HOSTNAME?.trim();
if (hostname) {
  config.routes = [{ pattern: hostname, custom_domain: true }];
  config.workers_dev = false;
  console.log(`Serving at https://${hostname}`);
} else {
  console.log('APP_HOSTNAME not set; serving on the workers.dev subdomain');
}

for (const key of ['MAIL_DOMAIN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS']) {
  const value = process.env[key]?.trim();
  if (value) {
    config.vars[key] = value;
    console.log(`${key} set`);
  }
}

writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
