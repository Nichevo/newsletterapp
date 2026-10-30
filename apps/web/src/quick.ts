// "In this issue": section headings and main story links, pulled out of the
// email HTML in the browser with a real parser. No AI involved.

export interface IssueOutline {
  headings: string[];
  links: { text: string; href: string }[];
}

const SKIP_LINK =
  /unsubscribe|preferences|manage (your )?subscription|view (this |it )?(in|online|email)|web version|browser|forward|share|refer|tweet|twitter|facebook|linkedin|instagram|threads|youtube|tiktok|privacy|terms|advertise|sponsor|update your|sign up|subscribe|download (the|our) app|app store|google play|contact us|reply|feedback/i;
const SPONSOR_HEADING = /sponsor|presented by|brought to you by|in partnership with|together with|advertisement|partner/i;
const SKIP_HREF = /^mailto:|^tel:|unsubscribe|list-manage\.com\/(profile|unsubscribe)|\/preferences|twitter\.com|x\.com\/intent|facebook\.com|linkedin\.com\/(share|company)|instagram\.com/i;

const clean = (s: string | null | undefined) => (s ?? '').replace(/[​-‏͏­﻿]/g, '').replace(/\s+/g, ' ').trim();

export function outlineOf(html: string, maxLinks = 8, maxHeadings = 8): IssueOutline {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const headings: string[] = [];
  for (const h of doc.querySelectorAll('h1, h2, h3')) {
    const t = clean(h.textContent);
    if (t.length >= 4 && t.length <= 120 && !headings.includes(t) && !SKIP_LINK.test(t) && !SPONSOR_HEADING.test(t)) {
      headings.push(t);
    }
    if (headings.length >= maxHeadings) break;
  }

  const links: IssueOutline['links'] = [];
  const seen = new Set<string>();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    const text = clean(a.textContent);
    if (!/^https?:\/\//i.test(href) || SKIP_HREF.test(href)) continue;
    if (text.length < 20 || text.length > 160 || SKIP_LINK.test(text) || /^https?:\/\//i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text, href });
    if (links.length >= maxLinks) break;
  }
  return { headings, links };
}
