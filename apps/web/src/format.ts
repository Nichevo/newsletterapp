const DAY = 86_400_000;

/** "7:02", "Yesterday", "Mon", "14 Oct" style timestamps for list rows. */
export function shortTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((startOfToday.getTime() - ms) / DAY) + (ms < startOfToday.getTime() ? 1 : 0);
  if (ms >= startOfToday.getTime()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function longDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

const WORDS_PER_MINUTE = 230;

/** Rough reading time from the item's word count, or from its text. */
export function readingMinutes(source: number | string | null | undefined): number {
  const words = typeof source === 'number' ? source : source ? source.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

const PROVIDER_LABEL: Record<string, string> = { ollama: 'Ollama on your PC', anthropic: 'Claude (hosted)' };

/** "Summary by qwen3:32b via Ollama on your PC, prompt v2, 12 s" */
export function aiAttribution(ai: { provider: string; model: string; promptVersion: number | null; seconds: number | null }): string {
  const parts = [`Summary by ${ai.model} via ${PROVIDER_LABEL[ai.provider] ?? ai.provider}`];
  if (ai.promptVersion) parts.push(`prompt v${ai.promptVersion}`);
  if (ai.seconds !== null) parts.push(`${Math.round(ai.seconds)} s`);
  return parts.join(', ');
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
