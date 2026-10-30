import type { Me, Source } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';

export function SettingsPage({ me }: { me: Me }) {
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    api.sources().then(setSources).catch(() => undefined);
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <h1>Settings</h1>
        </div>
      </header>

      <div className="section">
        <span className="label">Sources</span>
        <div className="card card--list">
          <Link to="/add" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Sign-up addresses</span>
              <span className="cardrow__sub">Create an address for a newsletter, or block one</span>
            </div>
          </Link>
          <Link to="/senders" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Senders</span>
              <span className="cardrow__sub">Allow or block who can reach your inbox</span>
            </div>
          </Link>
        </div>
      </div>

      {sources.length > 0 && (
        <div className="section">
          <span className="label">Newsletters you receive</span>
          <div className="card card--list">
            {sources.map((s) => (
              <Link key={s.id} to={`/?source=${s.id}`} className="cardrow">
                <div className="cardrow__main">
                  <span className="cardrow__title">{s.name}</span>
                  <span className="cardrow__sub">
                    {s.itemCount} issue{s.itemCount === 1 ? '' : 's'}
                    {s.lastReceivedAt ? ` · last ${shortTime(s.lastReceivedAt)}` : ''}
                    {s.senderEmail ? ` · ${s.senderEmail}` : ''}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <span className="label">Account</span>
        <div className="card card--list">
          <div className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Signed in as {me.email}</span>
              <span className="cardrow__sub">
                {me.domain ? `Newsletters are sent to @${me.domain}` : 'Mail domain not configured yet'}
              </span>
            </div>
          </div>
          <a href="/cdn-cgi/access/logout" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Sign out</span>
            </div>
          </a>
        </div>
      </div>

      <p className="hint" style={{ padding: '0 16px' }}>
        Phase 1. Summaries, tags, the digest, feeds, websites and stats arrive in later phases.
      </p>
    </div>
  );
}
