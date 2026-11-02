import { DEFAULT_SETTINGS, type AppSettings, type DigestOptions, type SavedFilter, type SummaryKind } from '@newsletterapp/shared';
import type { Env } from './env';
import { now } from './ids';

const KEY = 'app';

/** App settings with defaults filled in for anything never saved. */
export async function loadSettings(env: Env): Promise<AppSettings> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first<{ value: string }>();
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(row.value) as Partial<AppSettings>);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(env: Env, settings: AppSettings): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3',
  )
    .bind(KEY, JSON.stringify(settings), now())
    .run();
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validates untrusted input (a PUT body or a stored value) into a full settings object. */
export function normalizeSettings(input: Partial<AppSettings>, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const categories = Array.isArray(input.categories)
    ? [...new Set(input.categories.map((c) => str(c, 40)).filter(Boolean))].slice(0, 40)
    : base.categories;
  const keywordRules = Array.isArray(input.keywordRules)
    ? input.keywordRules
        .map((r) => ({ match: str(r?.match, 200), category: str(r?.category, 40) }))
        .filter((r) => r.match && r.category)
        .slice(0, 100)
    : base.keywordRules;
  const aiByKind = { ...base.aiByKind };
  if (input.aiByKind && typeof input.aiByKind === 'object') {
    for (const kind of Object.keys(aiByKind) as SummaryKind[]) {
      const v = input.aiByKind[kind];
      if (typeof v === 'boolean') aiByKind[kind] = v;
    }
  }
  const aiOffCategories = Array.isArray(input.aiOffCategories)
    ? [...new Set(input.aiOffCategories.map((c) => str(c, 40)).filter(Boolean))].slice(0, 40)
    : (base.aiOffCategories ?? []);
  const interests = typeof input.interests === 'string' ? str(input.interests, 300) : base.interests;
  const digestHour =
    typeof input.digestHour === 'number' && Number.isInteger(input.digestHour) && input.digestHour >= 0 && input.digestHour <= 23
      ? input.digestHour
      : base.digestHour;
  const timezone = typeof input.timezone === 'string' && isTimezone(input.timezone) ? input.timezone : base.timezone;
  const d = (input.digest && typeof input.digest === 'object' ? input.digest : {}) as Partial<DigestOptions>;
  const bd = base.digest;
  const digest: DigestOptions = {
    stories: d.stories === 6 || d.stories === 12 || d.stories === 20 ? d.stories : bd.stories,
    windowHours: d.windowHours === 0 || d.windowHours === 24 || d.windowHours === 48 ? d.windowHours : bd.windowHours,
    includeRead: typeof d.includeRead === 'boolean' ? d.includeRead : bd.includeRead,
    includeSponsored: typeof d.includeSponsored === 'boolean' ? d.includeSponsored : bd.includeSponsored,
    groupBy: d.groupBy === 'category' || d.groupBy === 'source' ? d.groupBy : bd.groupBy,
    skipCategories: Array.isArray(d.skipCategories)
      ? [...new Set(d.skipCategories.map((c) => str(c, 40)).filter(Boolean))].slice(0, 40)
      : bd.skipCategories,
    doneMarksRead: typeof d.doneMarksRead === 'boolean' ? d.doneMarksRead : bd.doneMarksRead,
  };
  const savedFilters: SavedFilter[] = Array.isArray(input.savedFilters)
    ? input.savedFilters
        .map((f) => ({
          name: str(f?.name, 40),
          view: (['inbox', 'unread', 'saved', 'interesting', 'likely', 'archived'] as const).find((v) => v === f?.view) ?? 'inbox',
          sort: (['newest', 'oldest', 'top'] as const).find((v) => v === f?.sort) ?? 'newest',
          source: typeof f?.source === 'string' ? f.source.slice(0, 64) : null,
          category: typeof f?.category === 'string' ? str(f.category, 40) || null : null,
          kind: (['newsletter', 'feed', 'site', 'ai'] as const).find((v) => v === f?.kind) ?? null,
        }))
        .filter((f) => f.name)
        .slice(0, 20)
    : base.savedFilters;
  return { categories, keywordRules, aiByKind, aiOffCategories, interests, digestHour, timezone, digest, savedFilters };
}
