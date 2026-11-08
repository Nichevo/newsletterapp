import {
  DEFAULT_SETTINGS,
  DEFAULT_SKIP_SITES,
  siteName,
  SOURCE_TYPES,
  formatFilterSet,
  parseFilterSet,
  FILE_FILTERS,
  type AppSettings,
  type DigestOptions,
  TOPICS_DAYS,
  type SavedFilter,
  type SourceType,
  type SummaryKind,
  type TopicFilter,
  type StorySettings,
} from '@newsletterapp/shared';
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
    enabled: typeof d.enabled === 'boolean' ? d.enabled : bd.enabled,
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
  const cleanTypes = (v: string) => {
    const set = parseFilterSet(v);
    const ok = (t: string) => (SOURCE_TYPES as string[]).includes(t) || (FILE_FILTERS as readonly string[]).includes(t);
    return formatFilterSet({ include: set.include.filter(ok), exclude: set.exclude.filter(ok) });
  };
  const savedFilters: SavedFilter[] = Array.isArray(input.savedFilters)
    ? input.savedFilters
        .map((f) => ({
          name: str(f?.name, 40),
          view: (['inbox', 'unread', 'saved', 'interesting', 'likely', 'archived'] as const).find((v) => v === f?.view) ?? 'inbox',
          sort: (['newest', 'oldest', 'top'] as const).find((v) => v === f?.sort) ?? 'newest',
          source: typeof f?.source === 'string' ? f.source.slice(0, 2000) || null : null,
          category: typeof f?.category === 'string' ? str(f.category, 400) || null : null,
          kind: typeof f?.kind === 'string' ? cleanTypes(f.kind) : null,
        }))
        .filter((f) => f.name)
        .slice(0, 20)
    : base.savedFilters;
  const pcSkipSites = Array.isArray(input.pcSkipSites)
    ? [...new Set(input.pcSkipSites.map((x) => siteName(str(x, 200))).filter(Boolean))].slice(0, 60)
    : (base.pcSkipSites ?? [...DEFAULT_SKIP_SITES]);
  const pcSkipAllowCategories = Array.isArray(input.pcSkipAllowCategories)
    ? [...new Set(input.pcSkipAllowCategories.map((c) => str(c, 40)).filter(Boolean))].slice(0, 40)
    : (base.pcSkipAllowCategories ?? []);
  const strs = (v: unknown, max: number, len: number) =>
    Array.isArray(v) ? [...new Set(v.map((x) => str(x, len)).filter(Boolean))].slice(0, max) : [];
  const topicFilters: TopicFilter[] = Array.isArray(input.topicFilters)
    ? input.topicFilters
        .map((f) => ({
          name: str(f?.name, 40),
          days: TOPICS_DAYS.find((d) => d === Number(f?.days)) ?? 30,
          categories: strs(f?.categories, 40, 40),
          sources: strs(f?.sources, 100, 64),
          types: strs(f?.types, 10, 20).filter((t): t is SourceType => (SOURCE_TYPES as string[]).includes(t)),
          read: (['all', 'unread', 'read', 'starred'] as const).find((v) => v === f?.read) ?? 'all',
          top: Math.min(Math.max(Math.round(Number(f?.top) || 0), 0), 200),
          min: Math.min(Math.max(Math.round(Number(f?.min) || 1), 1), 100),
          showSources: f?.showSources !== false,
        }))
        .filter((f) => f.name)
        .slice(0, 20)
    : (base.topicFilters ?? []);
  const st = (input.stories && typeof input.stories === 'object' ? input.stories : {}) as Partial<StorySettings>;
  const bs = base.stories ?? DEFAULT_SETTINGS.stories;
  const stories: StorySettings = {
    notes: typeof st.notes === 'boolean' ? st.notes : bs.notes,
    groupSameNews: typeof st.groupSameNews === 'boolean' ? st.groupSameNews : bs.groupSameNews,
    autoSummaries: typeof st.autoSummaries === 'boolean' ? st.autoSummaries : (bs.autoSummaries ?? false),
    match: st.match === 'loose' || st.match === 'normal' || st.match === 'strict' ? st.match : bs.match,
    categories:
      st.categories && typeof st.categories === 'object'
        ? Object.fromEntries(
            Object.entries(st.categories)
              .map(([k, v]) => [str(k, 40), v] as const)
              .filter(([k, v]) => k && (v === 'strict' || v === 'off'))
              .slice(0, 40),
          )
        : (bs.categories ?? {}),
  };
  return {
    categories,
    keywordRules,
    aiByKind,
    aiOffCategories,
    interests,
    digestHour,
    timezone,
    digest,
    savedFilters,
    pcSkipSites,
    pcSkipAllowCategories,
    topicFilters,
    stories,
  };
}
