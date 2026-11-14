import { canMergeAway, findDoubles, type Source } from "@newsletterapp/shared";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { sourceType } from "./FilterBar";

const KIND: Record<string, string> = {
  newsletter: "Newsletter",
  feed: "Feed",
  reddit: "Reddit",
  youtube: "YouTube",
  github: "GitHub",
  site: "Website",
  ai: "AI notes",
};

const DISMISSED = "doublesDismissed";

/** Group ids marked "Not the same", kept on this device. */
function loadDismissed(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(DISMISSED) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}
function saveDismissed(s: Set<string>) {
  try {
    localStorage.setItem(DISMISSED, JSON.stringify([...s]));
  } catch {
    /* private window: just for now */
  }
}
const groupId = (g: Source[]) =>
  g
    .map((s) => s.id)
    .sort()
    .join("+");

/** Groups of sources that look like the same site or publication, minus ones you said aren't. */
export function useDoubles(sources: Source[] | null) {
  const [dismissed, setDismissed] = useState(loadDismissed);
  const groups = sources
    ? findDoubles(sources).filter((g) => !dismissed.has(groupId(g)))
    : [];
  const dismiss = (g: Source[]) => {
    const next = new Set(dismissed).add(groupId(g));
    saveDismissed(next);
    setDismissed(next);
  };
  return { groups, dismiss };
}

function address(s: Source): string {
  if (s.kind === "newsletter") return s.senderEmail ?? "";
  return (s.feedUrl ?? s.url ?? "").replace(/^https?:\/\/(www\.)?/, "");
}

function lastPost(s: Source): string {
  if (!s.lastReceivedAt) return "nothing yet";
  const days = Math.floor((Date.now() - s.lastReceivedAt) / 86_400_000);
  return days < 1
    ? "latest today"
    : days === 1
      ? "latest yesterday"
      : `latest ${days} days ago`;
}

/** One group: pick the source to keep, the others' posts move into it. */
function DoubleGroup({
  group,
  onDone,
  onDismiss,
}: {
  group: Source[];
  onDone: (msg: string) => void;
  onDismiss: () => void;
}) {
  const [keep, setKeep] = useState<Source | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = keep ? group.filter((s) => s.id !== keep.id) : [];
  const merging = others.filter(canMergeAway);
  const staying = others.filter((s) => !canMergeAway(s));

  const merge = async () => {
    if (!keep) return;
    setBusy(true);
    setError(null);
    try {
      let moved = 0;
      for (const s of merging)
        moved += (await api.mergeSource(s.id, keep.id)).moved;
      onDone(
        `Merged into ${keep.name}: ${moved} post${moved === 1 ? "" : "s"} moved across.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not merge");
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <div className="card card--list">
        {group.map((s) => (
          <div
            key={s.id}
            className="cardrow"
            style={
              keep?.id === s.id
                ? { boxShadow: "inset 3px 0 0 var(--teal)" }
                : undefined
            }
          >
            <div className="cardrow__main">
              <Link to={`/source/${s.id}`} className="cardrow__title">
                {s.name}
              </Link>
              <span className="cardrow__sub">
                {KIND[sourceType(s)] ?? s.kind} · {s.itemCount} post
                {s.itemCount === 1 ? "" : "s"} · {lastPost(s)}
                {s.pausedAt
                  ? " · paused"
                  : s.lastError
                    ? " · last check failed"
                    : ""}
              </span>
              <span
                className="cardrow__sub"
                style={{ overflowWrap: "anywhere" }}
              >
                {address(s)}
              </span>
            </div>
            <button
              className="btn btn--small"
              aria-pressed={keep?.id === s.id}
              onClick={() => setKeep(keep?.id === s.id ? null : s)}
              disabled={busy}
            >
              {keep?.id === s.id ? "Keeping" : "Keep this one"}
            </button>
          </div>
        ))}
      </div>
      {keep ? (
        <>
          <span className="hint">
            {merging.length > 0
              ? `${merging.map((s) => s.name).join(", ")} will merge into ${keep.name}: ${merging.length === 1 ? "its" : "their"} posts, stars and reading history move across, and ${merging.length === 1 ? "it is" : "they are"} no longer followed. This can't be undone.`
              : "Nothing here can be merged into it."}
            {staying.length > 0 &&
              ` ${staying.map((s) => s.name).join(", ")} stay${staying.length === 1 ? "s" : ""}: a newsletter keeps arriving by email, so pause it on its page instead.`}
          </span>
          <div className="inline">
            {merging.length > 0 && (
              <button
                className="btn btn--small btn--primary"
                onClick={() => void merge()}
                disabled={busy}
              >
                {busy
                  ? "Merging…"
                  : `Merge ${merging.length === 1 ? "it" : merging.length} into ${keep.name}`}
              </button>
            )}
            <button
              className="btn btn--small"
              onClick={() => setKeep(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="inline">
          <button className="btn btn--small" onClick={onDismiss}>
            Not the same
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Your sources > Look like doubles. */
export function DoublesList({
  groups,
  onDismiss,
  onMerged,
}: {
  groups: Source[][];
  onDismiss: (g: Source[]) => void;
  onMerged: () => void;
}) {
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <div className="section">
        <span className="hint">
          These look like the same site or publication followed more than once
          (same address or name). Pick the one to keep, usually the feed that
          brings the newest posts; the others merge into it.
        </span>
        {done && <span className="hint">{done}</span>}
      </div>
      {groups.length === 0 && (
        <p className="hint" style={{ padding: "0 16px" }}>
          No doubles left.
        </p>
      )}
      {groups.map((g) => (
        <DoubleGroup
          key={g.map((s) => s.id).join("+")}
          group={g}
          onDismiss={() => onDismiss(g)}
          onDone={(msg) => {
            setDone(msg);
            onMerged();
          }}
        />
      ))}
    </>
  );
}
