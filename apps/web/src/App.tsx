import type { Me } from '@newsletterapp/shared';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, api } from './api';
import { TabBar } from './components/TabBar';
import { AddPage } from './pages/Add';
import { AskPage } from './pages/Ask';
import { AiSettingsPage } from './pages/AiSettings';
import { AiUsagePage } from './pages/AiUsage';
import { HighlightsPage } from './pages/Highlights';
import { HighlightPromptsPage } from './pages/HighlightPrompts';
import { WebSearchPage } from './pages/WebSearch';
import { PcSitesPage } from './pages/PcSites';
import { PcFetchStatsPage } from './pages/PcFetchStats';
import { DigestPage } from './pages/Digest';
import { InboxPage } from './pages/Inbox';
import { ReaderPage } from './pages/Reader';
import { KeySentencesPage } from './pages/KeySentences';
import { setKeysShown } from './keySentences';
import { SendersPage } from './pages/Senders';
import { SendPagesPage } from './pages/SendPages';
import { SettingsPage } from './pages/Settings';
import { SourcePage } from './pages/Source';
import { ExportPage } from './pages/Export';
import { SearchPage } from './pages/Search';
import { SourcesPage } from './pages/Sources';
import { SuggestedPage } from './pages/Suggested';
import { SuggestedLearntPage } from './pages/SuggestedLearnt';
import { ReadingStatsPage } from './pages/ReadingStats';
import { StatsPage } from './pages/Stats';
import { TagPagePage } from './pages/Tag';
import { TagsPage } from './pages/Tags';
import { StoriesPage, StoryPagePage } from './pages/Story';
import { StoryStatsPage } from './pages/StoryStats';
import { LinkPage, StudiesPage, StudyPage } from './pages/Studies';

// The Topics map pulls in the chart layout code, so it loads only when opened.
const TopicsPage = lazy(() => import('./pages/Topics').then((m) => ({ default: m.TopicsPage })));

export interface Counts {
  inbox: number;
  unread: number;
  saved: number;
  interesting: number;
  pendingSenders: number;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authError, setAuthError] = useState<ApiError | null>(null);
  const [counts, setCounts] = useState<Counts>({ inbox: 0, unread: 0, saved: 0, interesting: 0, pendingSenders: 0 });
  const location = useLocation();

  const refreshCounts = useCallback(() => {
    api.counts().then(setCounts).catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        setKeysShown(m.keySentencesOn);
        refreshCounts();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) setAuthError(err);
      });
  }, [refreshCounts]);

  // Not on opening an article: the reader shows no counts, and the inbox refreshes them on the way back.
  useEffect(() => {
    if (me && !location.pathname.startsWith('/item/')) refreshCounts();
  }, [location.pathname, me, refreshCounts]);

  if (authError) return <SetupNotice error={authError} />;
  if (!me) return <div className="spinner">Loading…</div>;

  const isReader = location.pathname.startsWith('/item/');

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<InboxPage key="inbox" mode="inbox" me={me} counts={counts} onChanged={refreshCounts} />} />
        <Route path="/digest" element={<DigestPage on={me.digestOn} />} />
        <Route path="/saved" element={<InboxPage key="saved" mode="saved" me={me} counts={counts} onChanged={refreshCounts} />} />
        <Route
          path="/saved/interesting"
          element={<InboxPage key="interesting" mode="interesting" me={me} counts={counts} onChanged={refreshCounts} />}
        />
        <Route path="/saved/highlights" element={<HighlightsPage />} />
        <Route path="/saved/stories" element={<StoriesPage />} />
        <Route path="/item/:id" element={<ReaderPage onChanged={refreshCounts} keySentencesOn={me.keySentencesOn} />} />
        <Route path="/senders" element={<SendersPage onChanged={refreshCounts} />} />
        <Route path="/add" element={<AddPage me={me} />} />
        <Route path="/ask" element={<AskPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route
          path="/settings"
          element={
            <SettingsPage
              me={me}
              onDigestChange={(on) => setMe((m) => (m ? { ...m, digestOn: on } : m))}
              onGroupChange={(on) => setMe((m) => (m ? { ...m, groupSameNews: on } : m))}
            />
          }
        />
        <Route path="/source/:id" element={<SourcePage />} />
        <Route path="/settings/ai" element={<AiSettingsPage />} />
        <Route path="/settings/ai/usage" element={<AiUsagePage />} />
        <Route path="/settings/ai/highlights" element={<HighlightPromptsPage />} />
        <Route path="/settings/ai/web-search" element={<WebSearchPage />} />
        <Route
          path="/settings/ai/key-sentences"
          element={
            <KeySentencesPage
              onChange={(on) => {
                setKeysShown(on);
                setMe((m) => (m ? { ...m, keySentencesOn: on } : m));
              }}
            />
          }
        />
        <Route path="/settings/ai/sites" element={<PcSitesPage />} />
        <Route path="/settings/send" element={<SendPagesPage />} />
        <Route path="/settings/sources" element={<SourcesPage />} />
        <Route path="/settings/sources/suggested" element={<SuggestedPage />} />
        <Route path="/settings/sources/suggested/learnt" element={<SuggestedLearntPage />} />
        <Route path="/settings/export" element={<ExportPage />} />
        <Route path="/stats" element={<ReadingStatsPage />} />
        <Route path="/stats/reading" element={<ReadingStatsPage />} />
        <Route path="/stats/ai" element={<StatsPage />} />
        <Route path="/stats/pc" element={<PcFetchStatsPage />} />
        <Route
          path="/stats/topics"
          element={
            <Suspense fallback={<div className="spinner">Loading…</div>}>
              <TopicsPage />
            </Suspense>
          }
        />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/story/:id" element={<StoryPagePage />} />
        <Route path="/studies" element={<StudiesPage />} />
        <Route path="/study/:id" element={<StudyPage />} />
        <Route path="/link/:id" element={<LinkPage />} />
        <Route path="/stats/stories" element={<StoryStatsPage />} />
        <Route path="/tag/*" element={<TagPagePage />} />
        <Route path="*" element={<InboxPage key="inbox" mode="inbox" me={me} counts={counts} onChanged={refreshCounts} />} />
      </Routes>
      {!isReader && <TabBar pendingSenders={counts.pendingSenders} showDigest={me.digestOn} />}
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
