// App problems: things going wrong inside the app itself (a source that stopped
// bringing posts in, a site turning the PC away, the PC helper offline or
// reporting errors), shown at the top of System status with the log lines
// behind each one, so nothing goes wrong quietly.

export type ProblemLevel = 'major' | 'minor';

export type ProblemKind = 'helper_offline' | 'site_resting' | 'source_failing' | 'source_silent' | 'source_unchecked' | 'helper_errors';

export interface AppProblem {
  /** Stable key, e.g. "source_failing:<id>" or "site_resting:reddit.com". */
  key: string;
  kind: ProblemKind;
  level: ProblemLevel;
  title: string;
  /** One or two plain sentences: what is happening and what the app is doing about it. */
  detail: string;
  /** When it started, as far as the app can tell. */
  since: number | null;
  /** The source it is about, for a link to its page. */
  sourceId?: string | null;
  /** The site it is about (site_resting). */
  site?: string | null;
  /** site_resting: when the PC tries the site again. */
  until?: number | null;
  /** source_failing: checks failed in a row; source_silent: usual hours between posts. */
  count?: number | null;
  /** source_*: the last good check. */
  lastOkAt?: number | null;
  /** source_*: the newest post it brought in. */
  lastItemAt?: number | null;
  /** Log lines behind it, newest first. */
  log: AppLogEntry[];
  /** Hidden by you until it clears up (it comes back if it happens again later). */
  hidden: boolean;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** One line of the app's log: from the PC helper (sent with its check-ins) or from Cloudflare. */
export interface AppLogEntry {
  id: number;
  at: number;
  level: LogLevel;
  /** Where it came from: 'pc' (the helper) or 'cloud' (the Worker). */
  origin: 'pc' | 'cloud';
  /** What part: 'feed', 'page', 'article', 'reddit', 'ai', 'helper'... */
  area: string;
  site: string | null;
  sourceId: string | null;
  message: string;
  /** The same line repeated this many times in a row (folded into one). */
  count: number;
}

/** A log line the helper sends with its heartbeat. */
export interface HelperLogEvent {
  at: number;
  level: LogLevel;
  area: string;
  site?: string | null;
  sourceId?: string | null;
  message: string;
  count?: number;
}

export interface ProblemsView {
  problems: AppProblem[];
  checkedAt: number;
}

export interface AppLogView {
  entries: AppLogEntry[];
  /** For the next page (older lines). */
  before: number | null;
}

/** What the inbox's Status button and banner show for app problems. */
export interface ProblemsSummary {
  open: number;
  level: 'ok' | ProblemLevel;
  top: { title: string; detail: string } | null;
  checkedAt: number;
}

export const NO_PROBLEMS: ProblemsSummary = { open: 0, level: 'ok', top: null, checkedAt: 0 };

/** Log lines are kept this long. */
export const LOG_KEEP_DAYS = 14;
