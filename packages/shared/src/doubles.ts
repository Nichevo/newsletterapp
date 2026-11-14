/**
 * Sources that look like the same thing followed twice: a site's feed and a
 * watch on its page, the same feed added twice, or a newsletter and its feed.
 * Matched on the site address (host plus first path part) and on the name.
 */

export interface DoubleCandidate {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  feedUrl: string | null;
  senderEmail?: string | null;
  savedPages?: boolean;
}

// Path parts that say nothing about which site it is.
const FEED_PARTS =
  /^(feed|feeds|rss|atom|index\.(xml|rss)|rss\.xml|atom\.xml|feed\.xml|rss2|default)$/i;
// Path parts shared by many different sources on one host, so the next part is needed too.
const SHARED_PARTS =
  /^(r|u|user|users|c|channel|channels|feeds|playlist|blog|blogs|news|en|p|@.*)$/i;

// Hosts where each owner/repo is its own source.
const TWO_PART_HOSTS = /^(github\.com|gitlab\.com|codeberg\.org)$/;

/** "informationisbeautiful.net/beautifulnews" from any address on that part of the site. */
export function doubleSiteKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|feeds?|rss|m)\./, "");
  const parts = u.pathname
    .split("/")
    .map((p) => decodeURIComponent(p).toLowerCase())
    .filter((p) => p && !FEED_PARTS.test(p));
  // YouTube channel feeds carry the channel in the query.
  const channel = u.searchParams.get("channel_id");
  if (channel) return `${host}/channel/${channel.toLowerCase()}`;
  if (parts.length === 0) return host;
  const first = parts[0]!.replace(/\.(xml|rss|atom|php|html?)$/, "");
  if ((SHARED_PARTS.test(first) || TWO_PART_HOSTS.test(host)) && parts[1])
    return `${host}/${first}/${parts[1].replace(/\.(xml|rss|atom)$/, "")}`;
  return `${host}/${first}`;
}

/** "beautifulnews" from "Beautiful News RSS Feed" and "The Beautiful News". */
export function nameKey(name: string): string | null {
  const k = name
    .toLowerCase()
    .replace(
      /\b(rss|atom|feed|feeds|newsletter|blog|website|the|daily|weekly|home ?page)\b/g,
      " ",
    )
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return k.length >= 4 ? k : null;
}

/** Groups of two or more sources that look like the same thing; each group keeps the given order. */
export function findDoubles<T extends DoubleCandidate>(sources: T[]): T[][] {
  const parent = sources.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]!));
  const firstWith = new Map<string, number>();
  sources.forEach((s, i) => {
    if (s.savedPages) return;
    const keys = new Set<string>();
    for (const u of [s.url, s.feedUrl]) {
      const k = doubleSiteKey(u);
      if (k) keys.add(`u:${k}`);
    }
    const n = nameKey(s.name);
    if (n) keys.add(`n:${n}`);
    if (s.senderEmail) keys.add(`e:${s.senderEmail.toLowerCase()}`);
    for (const k of keys) {
      const j = firstWith.get(k);
      if (j === undefined) firstWith.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, T[]>();
  sources.forEach((s, i) => {
    if (s.savedPages) return;
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), s]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

/** A source that can be merged away: a feed or website watch (a newsletter would come back with its next issue). */
export function canMergeAway(s: DoubleCandidate): boolean {
  return (s.kind === "feed" || s.kind === "site") && !s.savedPages;
}
