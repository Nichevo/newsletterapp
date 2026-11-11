import type { AiOutput } from '@newsletterapp/shared';

// Turning newsletter HTML into plain text for the model, and pulling the JSON
// answer out of what the model says.

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  zwnj: '',
  zwj: '',
  shy: '',
  // Typographic ones newsletters use a lot; key sentences must match the text the browser shows.
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  times: '\u00d7',
  euro: '\u20ac',
  pound: '\u00a3',
  cent: '\u00a2',
  yen: '\u00a5',
  eacute: '\u00e9',
  egrave: '\u00e8',
  aacute: '\u00e1',
  agrave: '\u00e0',
  oacute: '\u00f3',
  uuml: '\u00fc',
  ouml: '\u00f6',
  auml: '\u00e4',
  ccedil: '\u00e7',
  ntilde: '\u00f1',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

const NOISE_LINE =
  /^(view (this|in|it in|email in|online)|open in browser|unsubscribe|manage (your )?(preferences|subscription)|update your preferences|forward(ed)? (this|to a friend)|share (this|on)|follow us|you('| a)re receiving this|copyright|©|all rights reserved|privacy policy|terms of (use|service))/i;

/** Readable text: links become "text (url)" only when the text alone says little. */
export function htmlToText(html: string): string {
  const withLinks = html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-3])\b[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, ' ');
  return decode(withLinks)
    .replace(/[​-‏⁠͏­﻿ ]/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE_LINE.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function itemText(html: string | null, text: string | null, maxChars: number): string {
  const body = html ? htmlToText(html) : (text ?? '');
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n[... cut for length]` : body;
}

/** Finds the JSON object in a model reply, skipping <think> blocks and code fences. */
export function parseOutput(reply: string): AiOutput {
  const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<AiOutput>;
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('The model returned JSON without a summary');
  return {
    summary: parsed.summary,
    key_points: Array.isArray(parsed.key_points) ? parsed.key_points : [],
    why_it_matters: typeof parsed.why_it_matters === 'string' ? parsed.why_it_matters : '',
    category: Array.isArray(parsed.category) ? parsed.category : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    thin_content: parsed.thin_content === true,
    ...(typeof parsed.background === 'string' ? { background: parsed.background } : {}),
    ...(Array.isArray(parsed.coverage) ? { coverage: parsed.coverage } : {}),
  };
}

/** JSON schema for providers that can enforce structured output (Ollama, many OpenAI-compatible servers). */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    why_it_matters: { type: 'string' },
    category: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    thin_content: { type: 'boolean' },
    // Only asked for when the summary comes with web search results.
    background: { type: 'string' },
    coverage: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
  },
  required: ['summary', 'key_points', 'why_it_matters', 'category', 'topics', 'thin_content'],
};
