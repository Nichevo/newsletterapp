// Local AI usage: run-time limits and the running cost estimate.

/** Caps on how long the PC may spend on AI work. null = no cap. */
export interface AiLimits {
  /** Minutes of AI work in any rolling 60 minutes. */
  perHourMinutes: number | null;
  /** Minutes of AI work per calendar day, in the reader's time zone. */
  perDayMinutes: number | null;
  /** Minutes in one session: a stretch of work with no break as long as `breakMinutes`. */
  perSessionMinutes: number | null;
  /** A gap this long ends a session; after hitting the session cap the PC rests this long. */
  breakMinutes: number;
}

/** What it takes to work out a rough running cost. Money is in the reader's own currency. */
export interface AiCostSettings {
  /** Shown before amounts, e.g. "$" or "£". */
  currency: string;
  electricityPerKwh: number;
  /** GPU draw while working, used when the helper can't measure it with nvidia-smi. */
  gpuWatts: number;
  /** Extra draw from the rest of the PC (CPU, fans, RAM) while the AI works. */
  otherWatts: number;
  /** What the hardware cost (GPU alone, or the whole PC). */
  hardwareCost: number;
  /** What it might sell for at the end of its life. */
  resaleValue: number;
  lifespanYears: number;
  /** Hours a day the hardware is busy with everything (games, AI, work), to share the wear out fairly. */
  busyHoursPerDay: number;
}

export interface AiUsageSettings {
  limits: AiLimits;
  cost: AiCostSettings;
}

export const DEFAULT_USAGE_SETTINGS: AiUsageSettings = {
  limits: { perHourMinutes: null, perDayMinutes: null, perSessionMinutes: null, breakMinutes: 15 },
  cost: {
    currency: '$',
    electricityPerKwh: 0.15,
    gpuWatts: 450,
    otherWatts: 80,
    hardwareCost: 2500,
    resaleValue: 500,
    lifespanYears: 4,
    busyHoursPerDay: 6,
  },
};

/** Which cap is holding work back, and until when. */
export interface AiLimitHit {
  limit: 'hour' | 'day' | 'session';
  /** e.g. "20 of 20 minutes this hour" */
  message: string;
  until: number;
}

export interface UsageBucket {
  /** Bucket start (ms). */
  at: number;
  /** Local label: "14:00" or "2026-10-30". */
  label: string;
  minutes: number;
  runs: number;
  kwh: number;
  /** Electricity + wear, in the reader's currency. */
  cost: number;
}

export interface UsageTotals {
  minutes: number;
  runs: number;
  kwh: number;
  electricity: number;
  wear: number;
}

export interface AiUsageView {
  settings: AiUsageSettings;
  timezone: string;
  now: {
    hourMinutes: number;
    dayMinutes: number;
    sessionMinutes: number;
    limited: AiLimitHit | null;
  };
  /** Clock hours, last 7 days, oldest first. */
  hourly: UsageBucket[];
  /** Calendar days, last 90 days, oldest first. */
  daily: UsageBucket[];
  totals: {
    today: UsageTotals;
    last7Days: UsageTotals;
    last30Days: UsageTotals;
    last365Days: UsageTotals;
    allTime: UsageTotals;
  };
  /** Measured GPU draw per run, when the helper reports it. */
  avgWatts: number | null;
  /** Cost of one hour of AI work at these settings. */
  costPerHour: { electricity: number; wear: number };
}

// ---------- Is the PC keeping up? ----------

export interface BacklogPoint {
  at: number;
  label: string;
  /** Most items waiting at any snapshot in the period; null before snapshots began. */
  waiting: number | null;
  /** Longest any item had been waiting at a snapshot in the period, in minutes. */
  oldestMinutes: number | null;
}

export interface WaitBucket {
  at: number;
  label: string;
  /** Items that joined the AI queue. */
  arrived: number;
  /** Summaries written. */
  done: number;
  /** Minutes from joining the queue to the summary. */
  medianMinutes: number | null;
  p90Minutes: number | null;
}

export interface AiBacklogView {
  now: { waiting: number; working: number; oldestAt: number | null };
  /** Clock hours, last 7 days, oldest first. */
  hourly: BacklogPoint[];
  /** Calendar days, last 90 days, oldest first. */
  daily: BacklogPoint[];
  waitsHourly: WaitBucket[];
  waitsDaily: WaitBucket[];
  /** When the 15-minute snapshots started; earlier periods have no backlog figure. */
  snapshotsSince: number | null;
}
