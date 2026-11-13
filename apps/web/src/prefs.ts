// Reading preferences kept on this device (localStorage): text size, whether
// sponsored sections are hidden, and which newsletters may load images.
// Storage can be missing (private browsing), so every access is guarded.

export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';

export const TEXT_SIZES: { id: TextSize; label: string; px: number }[] = [
  { id: 'small', label: 'S', px: 15 },
  { id: 'medium', label: 'M', px: 17 },
  { id: 'large', label: 'L', px: 19 },
  { id: 'xlarge', label: 'XL', px: 22 },
];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered on this device; the app still works.
  }
}

export function getTextSize(): TextSize {
  const v = read('reader:textSize');
  return TEXT_SIZES.some((t) => t.id === v) ? (v as TextSize) : 'medium';
}

export function setTextSize(size: TextSize) {
  write('reader:textSize', size);
}

export function textSizePx(size: TextSize): number {
  return TEXT_SIZES.find((t) => t.id === size)?.px ?? 17;
}

/** Sponsored sections are hidden unless the reader turned that off. */
export function getHideSponsored(): boolean {
  return read('reader:hideSponsored') !== '0';
}

export function setHideSponsored(on: boolean) {
  write('reader:hideSponsored', on ? '1' : '0');
}

/** Which way a swipe marks an item read; the other way saves it. */
export type SwipeReadSide = 'right' | 'left';

export function getSwipeReadSide(): SwipeReadSide {
  return read('inbox:swipeReadSide') === 'left' ? 'left' : 'right';
}

export function setSwipeReadSide(side: SwipeReadSide) {
  write('inbox:swipeReadSide', side);
}

/** How far (px) a pull goes before it switches to the long swipe (Not interested / star and read), on this device. */
export const LONG_SWIPE_MIN = 105;
export const LONG_SWIPE_MAX = 260;
export const LONG_SWIPE_DEFAULT = 130;

export function getLongSwipePx(): number {
  const n = Number(read('inbox:longSwipePx'));
  return Number.isFinite(n) && n >= LONG_SWIPE_MIN && n <= LONG_SWIPE_MAX ? n : LONG_SWIPE_DEFAULT;
}

export function setLongSwipePx(px: number) {
  write('inbox:longSwipePx', String(Math.round(Math.min(LONG_SWIPE_MAX, Math.max(LONG_SWIPE_MIN, px)))));
}

/** Reading speed for the minutes shown on items, on this device. */
export const READING_SPEEDS = [180, 230, 300, 400] as const;

export function getReadingSpeed(): number {
  const n = Number(read('reader:wordsPerMinute'));
  return (READING_SPEEDS as readonly number[]).includes(n) ? n : 230;
}

export function setReadingSpeed(wpm: number) {
  write('reader:wordsPerMinute', String(wpm));
}

/** Where Live page opens Reddit and YouTube posts on Android: their app (the default) or the browser. */
export type OpenIn = 'app' | 'browser';
export type AppSite = 'reddit' | 'youtube';

export function getOpenIn(site: AppSite): OpenIn {
  return read(`reader:openIn:${site}`) === 'browser' ? 'browser' : 'app';
}

export function setOpenIn(site: AppSite, where: OpenIn) {
  write(`reader:openIn:${site}`, where);
}

const APPS: Record<AppSite, { re: RegExp; host: (m: RegExpExecArray) => string; pkg: string }> = {
  reddit: {
    re: /^https?:\/\/(?:www\.|old\.|new\.|m\.)?reddit\.com(\/.*)$/i,
    host: (m) => `www.reddit.com${m[1]}`,
    pkg: 'com.reddit.frontpage',
  },
  youtube: {
    re: /^https?:\/\/((?:www\.|m\.)?youtube\.com\/.*|youtu\.be\/.*)$/i,
    host: (m) => m[1]!,
    pkg: 'com.google.android.youtube',
  },
};

/**
 * The address Live page uses. On Android, Reddit and YouTube posts become an
 * intent link naming their app (the installed web app would otherwise open them
 * in the browser); without the app installed the browser opens the normal page.
 */
export function liveLink(url: string): string {
  if (typeof navigator === 'undefined' || !/Android/i.test(navigator.userAgent)) return url;
  for (const site of Object.keys(APPS) as AppSite[]) {
    const app = APPS[site];
    const m = app.re.exec(url);
    if (!m) continue;
    if (getOpenIn(site) === 'browser') return url;
    return `intent://${app.host(m)}#Intent;scheme=https;package=${app.pkg};S.browser_fallback_url=${encodeURIComponent(url)};end`;
  }
  return url;
}

/** Where the AI notes card sits in the reader: under the summary at the top, or after the article. */
export type NotesPlace = 'top' | 'bottom';

export function getNotesPlace(): NotesPlace {
  return read('reader:notesPlace') === 'bottom' ? 'bottom' : 'top';
}

export function setNotesPlace(place: NotesPlace) {
  write('reader:notesPlace', place);
}

/** Where a highlight ask's answer goes when picked from the bar: the prompt's own default, or a fixed choice. */
export type AskOutputPref = 'default' | 'note' | 'item' | 'both';

export function getAskOutput(): AskOutputPref {
  const v = read('reader:askOutput');
  return v === 'note' || v === 'item' || v === 'both' ? v : 'default';
}

export function setAskOutput(v: AskOutputPref) {
  write('reader:askOutput', v);
}

/** Newsletters whose images load without asking, by source id. */
export function imagesAllowed(sourceId: string | null): boolean {
  return sourceId !== null && read(`images:${sourceId}`) === '1';
}

export function setImagesAllowed(sourceId: string, on: boolean) {
  write(`images:${sourceId}`, on ? '1' : null);
}

// ---------- Inbox density: compact rows, cards (default) or expanded summaries ----------

export type Density = 'compact' | 'card' | 'expanded';

export const DENSITIES: { id: Density; label: string; hint: string }[] = [
  { id: 'compact', label: 'Compact', hint: 'One line per issue' },
  { id: 'card', label: 'Card', hint: 'Subject and a two-line preview' },
  { id: 'expanded', label: 'Expanded', hint: 'Full summary and key points in the list' },
];

const densityListeners = new Set<() => void>();

export function getDensity(): Density {
  const v = read('inbox:density');
  return DENSITIES.some((d) => d.id === v) ? (v as Density) : 'card';
}

export function setDensity(d: Density) {
  write('inbox:density', d);
  densityListeners.forEach((fn) => fn());
}

export function subscribeDensity(fn: () => void): () => void {
  densityListeners.add(fn);
  return () => densityListeners.delete(fn);
}

// ---------- What each inbox view shows ----------

export interface ViewOptions {
  /** Preview lines under the subject in Card view; 0 hides the preview. */
  cardLines: 0 | 1 | 2 | 3;
  cardTags: boolean;
  /** Expanded view: whole summary, or clamped to a few lines. */
  expandedFullSummary: boolean;
  /** Key points shown in Expanded view; 0 hides them, 99 shows all. */
  expandedPoints: 0 | 3 | 5 | 99;
  expandedWhy: boolean;
  expandedTags: boolean;
  /** Key sentences under the summary in Card and Expanded rows (switched from the list's top bar). */
  inboxKeys: boolean;
  /** Which colours show there. */
  inboxKeyKinds: InboxKeyKinds;
  /** How many show per row; 99 = all. */
  inboxKeyCount: 3 | 5 | 99;
}

export type InboxKeyKinds = 'main' | 'main-takeaway' | 'all';

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  cardLines: 2,
  cardTags: true,
  expandedFullSummary: true,
  expandedPoints: 5,
  expandedWhy: true,
  expandedTags: true,
  inboxKeys: false,
  inboxKeyKinds: 'main-takeaway',
  inboxKeyCount: 5,
};

let viewCache: { raw: string | null; value: ViewOptions } | null = null;

export function getViewOptions(): ViewOptions {
  const raw = read('inbox:viewOptions');
  if (viewCache && viewCache.raw === raw) return viewCache.value;
  let value = DEFAULT_VIEW_OPTIONS;
  if (raw) {
    try {
      value = { ...DEFAULT_VIEW_OPTIONS, ...(JSON.parse(raw) as Partial<ViewOptions>) };
    } catch {
      value = DEFAULT_VIEW_OPTIONS;
    }
  }
  viewCache = { raw, value };
  return value;
}

export function setViewOptions(patch: Partial<ViewOptions>) {
  write('inbox:viewOptions', JSON.stringify({ ...getViewOptions(), ...patch }));
  densityListeners.forEach((fn) => fn());
}
