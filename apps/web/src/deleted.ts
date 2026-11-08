// The item just deleted from the reader, so the list the reader goes back to
// can offer Undo for a few seconds.

let last: { id: string; title: string; at: number } | null = null;

/** How long the list offers Undo after a delete. */
export const UNDO_SHOW_MS = 10_000;

export function noteDeleted(id: string, title: string) {
  last = { id, title, at: Date.now() };
}

/** The delete to offer Undo for, once; null when there is none or it is too old. */
export function takeDeleted(): { id: string; title: string } | null {
  const d = last;
  last = null;
  return d && Date.now() - d.at < UNDO_SHOW_MS ? d : null;
}
