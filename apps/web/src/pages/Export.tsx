import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack } from '../icons';

// Settings > Backup and export: the feed list for any other reader, the
// newsletter list, and everything else as one JSON file plus a CSV of items.
// The full export is fetched a page at a time and assembled here, on the device.

const ITEM_COLUMNS = [
  'id',
  'kind',
  'status',
  'subject',
  'source',
  'from_name',
  'from_email',
  'received_at',
  'read_at',
  'saved_at',
  'interesting_at',
  'archived_at',
  'category',
  'tags',
  'summary',
  'why_it_matters',
  'word_count',
  'web_url',
] as const;
const DATE_COLUMNS = new Set(['received_at', 'read_at', 'saved_at', 'interesting_at', 'archived_at']);

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function itemsCsv(items: Record<string, unknown>[]): string {
  const rows = items.map((it) =>
    ITEM_COLUMNS.map((col) => {
      const v = it[col];
      if (DATE_COLUMNS.has(col) && typeof v === 'number') return csvCell(new Date(v).toISOString());
      return csvCell(v);
    }).join(','),
  );
  return [ITEM_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

function download(content: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportPage() {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function exportAll() {
    setBusy(true);
    try {
      setProgress('Sources and settings…');
      const meta = await api.exportMeta();
      const items: Record<string, unknown>[] = [];
      for (let after = 0; ; ) {
        const page = await api.exportItems(after);
        items.push(...page.items);
        setProgress(`${items.length} items…`);
        if (page.next === null) break;
        after = page.next;
      }
      const events: Record<string, unknown>[] = [];
      for (let after = 0; ; ) {
        const page = await api.exportEvents(after);
        events.push(...page.events);
        setProgress(`${items.length} items, ${events.length} reading events…`);
        if (page.next === null) break;
        after = page.next;
      }
      const day = new Date().toISOString().slice(0, 10);
      download(JSON.stringify({ ...meta, items, events }, null, 1), 'application/json', `newsletter-app-${day}.json`);
      download(itemsCsv(items), 'text/csv', `newsletter-app-items-${day}.csv`);
      setProgress(`Done: ${items.length} items, ${meta.sources.length} sources, ${events.length} reading events, ${meta.highlights.length} highlights.`);
    } catch (err) {
      setProgress(err instanceof Error ? `Stopped: ${err.message}` : 'Stopped');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Backup and export</h1>
        </div>
      </header>

      <div className="section">
        <span className="label">Your subscriptions</span>
        <section className="card">
          <div className="inline">
            <a className="btn btn--small" href="/api/export/opml" download>
              Feeds (OPML)
            </a>
            <a className="btn btn--small" href="/api/export/newsletters.csv" download>
              Newsletters (CSV)
            </a>
          </div>
          <span className="hint">
            The OPML file imports into Feedly or any other feed reader, with your folders. Website watches go in a folder of their own, since
            other readers can only follow feeds. Newsletters have no OPML equivalent, so they come as a list with the sender and the address
            each one is sent to.
          </span>
        </section>
      </div>

      <div className="section">
        <span className="label">Everything</span>
        <section className="card">
          <div className="inline">
            <button className="btn btn--small btn--primary" onClick={() => void exportAll()} disabled={busy}>
              {busy ? 'Exporting…' : 'Export all data'}
            </button>
          </div>
          {progress && <span className="hint">{progress}</span>}
          <span className="hint">
            Two files: a JSON file with every item (dates, read, saved and starred, category, tags, AI summary), your sources, settings,
            highlights and reading history, and a CSV of the items for a spreadsheet. The emails and saved pages themselves are not included;
            the nightly backup from your PC will cover those.
          </span>
        </section>
      </div>
    </div>
  );
}
