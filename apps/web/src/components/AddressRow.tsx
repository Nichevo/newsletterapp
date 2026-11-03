import type { Address, AddressMonth } from '@newsletterapp/shared';
import { useState } from 'react';
import { api } from '../api';
import { agoText, shortTime } from '../format';
import { IconCopy } from '../icons';
import { BarChart } from './BarChart';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "34 emails · last 3 days ago" for the row, from the counts stored on the address. */
function statsLine(a: Address): string {
  if (a.itemCount === 0) return 'no emails yet';
  return `${plural(a.itemCount, 'email')}${a.lastItemAt ? ` · last ${agoText(a.lastItemAt)}` : ''}`;
}

interface MonthPoint {
  at: number;
  key: string;
  n: number;
}

/** The last 12 months (or since the address was made, if sooner), with empty months filled in. */
function lastMonths(months: AddressMonth[], createdAt: number): MonthPoint[] {
  const counts = new Map(months.map((m) => [m.month, m.count]));
  const now = new Date();
  const first = new Date(createdAt);
  const out: MonthPoint[] = [];
  for (let back = 11; back >= 0; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (d.getTime() < Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) && !counts.has(key)) continue;
    out.push({ at: d.getTime(), key, n: counts.get(key) ?? 0 });
  }
  return out;
}

const monthName = (at: number, long = false) =>
  new Date(at).toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' });

export function AddressRow({
  address: a,
  onCopy,
  onChange,
  onDeleted,
  onError,
}: {
  address: Address;
  onCopy: (email: string) => void;
  onChange: (a: Address) => void;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState<AddressMonth[] | null>(null);
  const [label, setLabel] = useState(a.label ?? '');
  const [note, setNote] = useState(a.note ?? '');
  const [busy, setBusy] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLabel(a.label ?? '');
      setNote(a.note ?? '');
      if (months === null && a.itemCount > 0) api.addressMonths(a.id).then(setMonths).catch(() => setMonths([]));
    }
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      onChange(await api.saveAddress(a.id, { label: label.trim() || null, note: note.trim() || null }));
      setOpen(false);
    });

  const toggleBlock = () =>
    run(async () => {
      onChange(await api.addressAction(a.id, a.status === 'blocked' ? 'unblock' : 'block'));
    });

  const remove = () =>
    run(async () => {
      if (!window.confirm(`Delete ${a.email}? It has never received an email.`)) return;
      await api.deleteAddress(a.id);
      onDeleted(a.id);
    });

  const changed = label.trim() !== (a.label ?? '') || note.trim() !== (a.note ?? '');
  const points = months ? lastMonths(months, a.createdAt) : [];
  const total = points.reduce((s, p) => s + p.n, 0);
  const perMonth = points.length ? total / points.length : 0;

  return (
    <div>
      <div className="cardrow">
        <button
          type="button"
          className="cardrow__main"
          style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="cardrow__title">{a.label ?? a.localPart}</span>
          <span className="cardrow__sub">
            {a.email}
            {a.status === 'blocked'
              ? ` · blocked · ${plural(a.blockedCount, 'email')} stopped`
              : a.approvedSenderCount > 0
                ? ` · ${plural(a.approvedSenderCount, 'allowed sender')}`
                : a.itemCount === 0
                  ? ' · waiting for its first email'
                  : ''}
          </span>
          {a.itemCount > 0 && <span className="cardrow__sub">{statsLine(a)}</span>}
          {a.note && (
            <span className="cardrow__sub" style={{ fontStyle: 'italic' }}>
              {a.note}
            </span>
          )}
        </button>
        <button className="iconbtn" aria-label={`Copy ${a.email}`} onClick={() => onCopy(a.email)}>
          <IconCopy size={18} />
        </button>
      </div>

      {open && (
        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {a.itemCount > 0 ? (
            months === null ? (
              <span className="hint" style={{ margin: 0 }}>Loading…</span>
            ) : (
              <>
                <BarChart
                  points={points}
                  value={(p) => p.n}
                  unit="emails"
                  label={`Emails a month to ${a.email}`}
                  summary={`${total} in the last ${plural(points.length, 'month')} · about ${perMonth < 10 ? perMonth.toFixed(1).replace(/\.0$/, '') : Math.round(perMonth)} a month · tap a bar`}
                  describe={(p) => `${monthName(p.at, true)}: ${plural(p.n, 'email')}`}
                  tick={(p, i) => (points.length <= 6 || i % 3 === 0 || i === points.length - 1 ? monthName(p.at) : null)}
                />
              </>
            )
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              Made {shortTime(a.createdAt)}; nothing has arrived here yet.
            </span>
          )}
          <div className="field">
            <label htmlFor={`addr-name-${a.id}`}>Name</label>
            <input
              id={`addr-name-${a.id}`}
              className="input"
              placeholder={a.localPart}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor={`addr-note-${a.id}`}>Note</label>
            <textarea
              id={`addr-note-${a.id}`}
              className="input"
              rows={2}
              maxLength={500}
              placeholder="e.g. now shared by several Substack newsletters"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ resize: 'vertical', font: 'inherit' }}
            />
          </div>
          <div className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn--primary btn--small" disabled={busy || !changed} onClick={() => void save()}>
              Save
            </button>
            <button className="btn btn--small" disabled={busy} onClick={() => void toggleBlock()}>
              {a.status === 'blocked' ? 'Unblock' : 'Block'}
            </button>
            {a.itemCount === 0 && (
              <button className="btn btn--ghost btn--small" style={{ color: 'var(--red-ink)' }} disabled={busy} onClick={() => void remove()}>
                Delete
              </button>
            )}
          </div>
          {a.itemCount > 0 && (
            <span className="hint" style={{ margin: 0 }}>
              Addresses that have received emails can't be deleted, so their newsletters keep their history. Block it instead.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
