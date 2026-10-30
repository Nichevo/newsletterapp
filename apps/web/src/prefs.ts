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
