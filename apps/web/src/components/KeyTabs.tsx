import { INDEX_TYPE_NAMES, INDEX_TYPES, type IndexTerm, type ItemKeySentences, type ItemReferences, type ItemStudy, type KeyUseEvent } from '@newsletterapp/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { flashRange, keySpans, kindDot, rangeForQuote, revealKey, termRanges } from '../keySentences';

// Under an article with key sentences (or studies): Outline (the key
// sentences in order, under the article's own headings), Index (people,
// organisations, places and terms, tap to jump to each mention) and
// References (the studies it cites, with how many other articles cite the
// same one, and source links other articles share).

type Root = ShadowRoot | HTMLElement;
export type KeyTab = 'outline' | 'index' | 'refs';
type Tab = KeyTab;

export function KeyTabs({
  data,
  refs,
  root,
  want,
  onRefs,
  onUse,
}: {
  data: ItemKeySentences;
  refs: ItemReferences | null;
  root: Root | null;
  /** Asked for from the key sentences bar; n changes on every tap. */
  want?: { tab: Tab; n: number } | null;
  onRefs: () => void;
  /** Counted for Statistics. */
  onUse: (e: KeyUseEvent) => void;
}) {
  const live = useMemo(() => data.marks.map((m, i) => ({ m, i })).filter((x) => x.m.fix !== 'removed'), [data.marks]);
  const hasOutline = data.status === 'done' && live.length > 0;
  const hasIndex = data.terms.length > 0;
  const refCount = (refs?.studies.length ?? 0) + (refs?.links.length ?? 0);
  const hasRefs = refCount > 0;
  const tabs: Tab[] = [...(hasOutline ? (['outline'] as const) : []), ...(hasIndex ? (['index'] as const) : []), ...(hasRefs ? (['refs'] as const) : [])];
  const [picked, setPicked] = useState<Tab | null>(null);
  useEffect(() => {
    if (want) setPicked(want.tab);
  }, [want]);
  const tab = picked && tabs.includes(picked) ? picked : (tabs[0] ?? null);
  if (!tab) return null;
  const elsewhere = refs?.studies.filter((s) => s.cites > 1).length ?? 0;
  const label: Record<Tab, string> = {
    outline: `Outline`,
    index: `Index`,
    refs: `References${refCount ? ` (${refCount})` : ''}`,
  };
  return (
    <section className="kstabs" id="key-tabs" aria-label="Outline, index and references">
      <div className="segmented segmented--small" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => {
              setPicked(t);
              onUse(t === 'refs' ? 'refs' : t);
            }}>
            {label[t]}
          </button>
        ))}
      </div>
      {tab === 'refs' && elsewhere > 0 && (
        <p className="hint">
          {elsewhere === 1 ? 'One study here is' : `${elsewhere} studies here are`} also cited by other articles.
        </p>
      )}
      {tab === 'outline' && <Outline data={data} live={live} root={root} onJump={() => onUse('jump')} />}
      {tab === 'index' && <Index terms={data.terms} root={root} onJump={() => onUse('jump')} />}
      {tab === 'refs' && refs && <References refs={refs} root={root} onRefs={onRefs} />}
    </section>
  );
}

function Outline({
  data,
  live,
  root,
  onJump,
}: {
  data: ItemKeySentences;
  live: { m: ItemKeySentences['marks'][number]; i: number }[];
  root: Root | null;
  onJump: () => void;
}) {
  // Grouped under the article's own headings, in reading order.
  const groups: { section: string | null; rows: typeof live }[] = [];
  for (const x of [...live].sort((a, b) => a.m.textOffset - b.m.textOffset)) {
    const section = x.m.section ?? null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.rows.push(x);
    else groups.push({ section, rows: [x] });
  }
  const kindName = (k: string) => data.kinds.find((x) => x.id === k)?.name ?? k;
  return (
    <div className="ksoutline">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.section && <h4>{g.section}</h4>}
          <ol>
            {g.rows.map(({ m, i }) => {
              const shown = root ? keySpans(root, i).length > 0 : false;
              return (
                <li key={i}>
                  <button className="ksoutline__row" disabled={!shown} title={kindName(m.kind)} onClick={() => {
                      if (!root) return;
                      onJump();
                      revealKey(root, i);
                    }}>
                    <i style={{ background: kindDot(m.kind) }} aria-hidden="true" />
                    <span>{m.quote}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

function Index({ terms, root, onJump }: { terms: IndexTerm[]; root: Root | null; onJump: () => void }) {
  // Which mention each term is on, so a second tap goes to the next one.
  const at = useRef(new Map<string, number>());
  const [active, setActive] = useState<{ term: string; n: number; of: number } | null>(null);
  function jump(t: IndexTerm) {
    if (!root) return;
    onJump();
    const ranges = termRanges(root, t.term, t.type === 'term');
    if (!ranges.length) return setActive({ term: t.term, n: 0, of: 0 });
    const next = ((at.current.get(t.term) ?? -1) + 1) % ranges.length;
    at.current.set(t.term, next);
    flashRange(ranges[next]!);
    setActive({ term: t.term, n: next + 1, of: ranges.length });
  }
  return (
    <div className="ksindex">
      {INDEX_TYPES.map((type) => {
        const list = terms.filter((t) => t.type === type).sort((a, b) => a.term.localeCompare(b.term));
        if (!list.length) return null;
        return (
          <div key={type}>
            <h4>{INDEX_TYPE_NAMES[type]}</h4>
            <div className="pills">
              {list.map((t) => (
                <button key={t.term} className="pill" aria-pressed={active?.term === t.term} onClick={() => jump(t)}>
                  {t.term}
                  <span className="ksindex__count">
                    {active?.term === t.term && active.of ? `${active.n} of ${active.of}` : t.count > 1 ? `×${t.count}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {active && active.of === 0 && <p className="hint">“{active.term}” isn't in this copy of the article.</p>}
    </div>
  );
}

function References({ refs, root, onRefs }: { refs: ItemReferences; root: Root | null; onRefs: () => void }) {
  return (
    <div className="ksrefs">
      {refs.studies.length > 0 && (
        <>
          <h4>Studies and reports</h4>
          <ul className="ksrefs__list">
            {refs.studies.map((s, i) => {
              // Two studies here that may be the same one: ask once, on the first.
              const asked = s.maybe && refs.studies.slice(0, i).some((x) => x.id === s.maybe!.id && x.maybe?.id === s.id);
              return <StudyRow key={s.citeId} s={asked ? { ...s, maybe: null } : s} root={root} onRefs={onRefs} />;
            })}
          </ul>
        </>
      )}
      {refs.links.length > 0 && (
        <>
          <h4>Source links</h4>
          <ul className="ksrefs__list">
            {refs.links.map((l) => (
              <li key={l.id} className="ksrefs__link">
                <a href={l.url} target="_blank" rel="noreferrer noopener">
                  {l.title || l.url}
                </a>
                <span className="hint">
                  {l.host}
                  {l.cites > 1 && (
                    <>
                      {' · '}
                      <Link to={`/link/${l.id}`}>Linked from {l.cites} articles</Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {refs.hiddenLinks > 0 && (
        <p className="hint">
          {refs.hiddenLinks} other source link{refs.hiddenLinks === 1 ? '' : 's'} only this article uses {refs.hiddenLinks === 1 ? 'is' : 'are'} hidden. They show
          here once another article links to the same page.
        </p>
      )}
      <p className="hint">
        <Link to="/studies">All studies</Link>
      </p>
    </div>
  );
}

function StudyRow({ s, root, onRefs }: { s: ItemStudy; root: Root | null; onRefs: () => void }) {
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const others = s.cites - 1;
  async function answer(same: boolean) {
    if (!s.maybe) return;
    setBusy(true);
    try {
      await api.sameStudy(s.id, s.maybe.id, same);
      onRefs();
    } finally {
      setBusy(false);
    }
  }
  function show() {
    const r = root ? rangeForQuote(root, s) : null;
    if (r) flashRange(r);
    else setMissing(true);
  }
  return (
    <li className="ksstudy">
      <Link className="ksstudy__title" to={`/study/${s.id}`}>
        {s.title}
      </Link>
      <span className="hint">{[s.publisher, s.year].filter(Boolean).join(', ') || 'Publisher not named'}</span>
      {s.claim && <p className="ksstudy__claim">{s.claim}</p>}
      <div className="ksstudy__badges">
        {others > 0 && (
          <Link className="chip chip--outline" to={`/study/${s.id}`}>
            Also in {others} other article{others === 1 ? '' : 's'}
          </Link>
        )}
        {s.citeDiffers && (
          <Link className="chip chip--warn" to={`/study/${s.id}`} title="Another article gives different numbers for this study">
            Others quote this differently
          </Link>
        )}
        <button className="linkbtn" onClick={show}>
          {missing ? 'Not found in this copy' : 'Show in article'}
        </button>
        {s.url && (
          <a className="linkbtn" href={s.url} target="_blank" rel="noreferrer noopener">
            Open
          </a>
        )}
      </div>
      {s.maybe && (
        <div className="ksstudy__maybe">
          <span>
            Maybe the same study as “{s.maybe.title}” ({s.maybe.cites} article{s.maybe.cites === 1 ? '' : 's'})?
          </span>
          <span className="inline">
            <button className="btn btn--small" disabled={busy} onClick={() => void answer(true)}>
              Same
            </button>
            <button className="btn btn--ghost btn--small" disabled={busy} onClick={() => void answer(false)}>
              Different
            </button>
          </span>
        </div>
      )}
    </li>
  );
}
