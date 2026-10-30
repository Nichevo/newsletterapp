import type { Sender, SenderStatus } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack } from '../icons';

const CHECK_LABEL = {
  pass: 'Passed sender checks',
  fail: 'Failed sender checks · likely spam',
  unknown: 'Sender checks not available',
} as const;

export function SendersPage({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SenderStatus>('pending');
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .senders(status)
      .then(setSenders)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'))
      .finally(() => setLoading(false));
  }, [status]);

  async function decide(sender: Sender, decision: 'allow' | 'block') {
    setSenders((prev) => prev.filter((s) => s.id !== sender.id));
    try {
      await api.decideSender(sender.id, decision);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      setSenders((prev) => [sender, ...prev]);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Senders</h1>
        </div>
      </header>

      <div className="tabs">
        {(['pending', 'approved', 'blocked'] as SenderStatus[]).map((s) => (
          <button key={s} className="pill" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === 'pending' ? 'New' : s === 'approved' ? 'Allowed' : 'Blocked'}
          </button>
        ))}
      </div>

      {status === 'pending' && (
        <p className="hint" style={{ padding: '0 16px 8px' }}>
          Mail from a sender you haven't approved waits here and never reaches your inbox. The first sender to an address you
          created in the app is let through automatically.
        </p>
      )}

      {error && <div className="error">{error}</div>}

      <div className="section">
        {senders.map((s) => (
          <section key={s.id} className="card">
            <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong style={{ fontSize: 15 }}>{s.name ?? s.email}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {shortTime(s.lastSeenAt)}
              </span>
            </div>
            <span className="cardrow__sub">{s.email}</span>
            {s.latestSubject && (
              <span style={{ fontSize: 13 }}>
                {s.latestItemId && status !== 'blocked' ? (
                  <Link to={`/item/${s.latestItemId}`}>“{s.latestSubject}”</Link>
                ) : (
                  <>“{s.latestSubject}”</>
                )}
                {s.pendingCount > 1 ? ` and ${s.pendingCount - 1} more` : ''}
              </span>
            )}
            {s.addressLocalPart && <span className="cardrow__sub">Sent to {s.addressLocalPart}@…</span>}
            <span className={`check check--${s.authResult}`}>
              <span className="check__dot" />
              {CHECK_LABEL[s.authResult]}
            </span>
            <div className="inline" style={{ marginTop: 4 }}>
              {status !== 'approved' && (
                <button
                  className={`btn btn--block ${s.authResult === 'pass' ? 'btn--primary' : ''}`}
                  onClick={() => void decide(s, 'allow')}
                >
                  Allow
                </button>
              )}
              {status !== 'blocked' && (
                <button className="btn btn--block" onClick={() => void decide(s, 'block')}>
                  Block
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      {loading && <div className="spinner">Loading…</div>}
      {!loading && senders.length === 0 && !error && (
        <div className="empty">
          <h2>{status === 'pending' ? 'No new senders' : status === 'approved' ? 'No allowed senders yet' : 'Nothing blocked'}</h2>
        </div>
      )}
    </div>
  );
}
