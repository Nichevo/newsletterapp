import type { Me } from '@newsletterapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, api } from './api';
import { TabBar } from './components/TabBar';
import { AddPage } from './pages/Add';
import { InboxPage } from './pages/Inbox';
import { ReaderPage } from './pages/Reader';
import { SendersPage } from './pages/Senders';
import { SettingsPage } from './pages/Settings';

export interface Counts {
  inbox: number;
  unread: number;
  saved: number;
  pendingSenders: number;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authError, setAuthError] = useState<ApiError | null>(null);
  const [counts, setCounts] = useState<Counts>({ inbox: 0, unread: 0, saved: 0, pendingSenders: 0 });
  const location = useLocation();

  const refreshCounts = useCallback(() => {
    api.counts().then(setCounts).catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        refreshCounts();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) setAuthError(err);
      });
  }, [refreshCounts]);

  useEffect(() => {
    if (me) refreshCounts();
  }, [location.pathname, me, refreshCounts]);

  if (authError) return <SetupNotice error={authError} />;
  if (!me) return <div className="spinner">Loading…</div>;

  const isReader = location.pathname.startsWith('/item/');

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<InboxPage key="inbox" mode="inbox" me={me} counts={counts} onChanged={refreshCounts} />} />
        <Route path="/saved" element={<InboxPage key="saved" mode="saved" me={me} counts={counts} onChanged={refreshCounts} />} />
        <Route path="/item/:id" element={<ReaderPage onChanged={refreshCounts} />} />
        <Route path="/senders" element={<SendersPage onChanged={refreshCounts} />} />
        <Route path="/add" element={<AddPage me={me} />} />
        <Route path="/settings" element={<SettingsPage me={me} />} />
        <Route path="*" element={<InboxPage key="inbox" mode="inbox" me={me} counts={counts} onChanged={refreshCounts} />} />
      </Routes>
      {!isReader && <TabBar pendingSenders={counts.pendingSenders} />}
    </div>
  );
}

function SetupNotice({ error }: { error: ApiError }) {
  if (error.status === 503) {
    return (
      <div className="setup">
        <h1>Almost there</h1>
        <p>The app is deployed but sign-in isn't set up yet. {error.message}</p>
        <p>
          Protect this site with Cloudflare Access, then set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code> as
          described in the README.
        </p>
      </div>
    );
  }
  return (
    <div className="setup">
      <h1>Can't sign you in</h1>
      <p className="muted">{error.message}</p>
      <p>
        <a href="/">Try again</a>
      </p>
    </div>
  );
}
