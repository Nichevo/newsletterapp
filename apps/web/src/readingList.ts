// The order of items in the list the reader was opened from, so Previous /
// Next can walk it without going back. Kept in sessionStorage so it survives
// a reload but not a new tab.

const KEY = 'reader:list';

export function rememberList(ids: string[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Not remembered; the buttons just don't show.
  }
}

function readList(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Ids of the items before and after this one in the remembered list, if any. */
export function neighbours(id: string): { prev: string | null; next: string | null; position: number | null; total: number } {
  const ids = readList();
  const i = ids.indexOf(id);
  if (i === -1) return { prev: null, next: null, position: null, total: ids.length };
  return { prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null, position: i + 1, total: ids.length };
}
