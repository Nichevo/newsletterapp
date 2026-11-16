/** A site's name for the app's log: the host without www, and every Reddit address as reddit.com. */
export function siteOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return /(^|\.)(reddit\.com|redd\.it)$/.test(host) ? 'reddit.com' : host;
  } catch {
    return null;
  }
}
