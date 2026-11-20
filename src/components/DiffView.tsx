import { useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { diffText, type DiffRow } from '../lib/diff';

interface Side {
  title: string;
  content: string;
}

function Line({ row }: { row: DiffRow }) {
  const sign = row.op === 'add' ? '+' : row.op === 'del' ? '−' : ' ';
  return (
    <div className={`diff-line is-${row.op}`}>
      <span className="diff-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="diff-text">
        {row.parts
          ? row.parts.map((p, i) => (p.changed ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))
          : row.text || ' '}
      </span>
    </div>
  );
}

/**
 * Two versions of a note compared line by line: lines only in `before` struck in red, lines only in
 * `after` in green, the words that changed within a line marked, unchanged stretches folded.
 */
export function DiffView({ before, after, beforeLabel, afterLabel }: { before: Side; after: Side; beforeLabel: string; afterLabel: string }) {
  const diff = useMemo(() => diffText(before.content, after.content), [before.content, after.content]);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const titleChanged = before.title.trim() !== after.title.trim();

  if (!diff) {
    return <p className="diff-note">These versions are too different to compare line by line. Switch to Preview to read this one.</p>;
  }
  const same = diff.added === 0 && diff.removed === 0 && !titleChanged;

  return (
    <div className="diff-view">
      <div className="diff-legend">
        <span className="diff-key is-del">− {beforeLabel}</span>
        <span className="diff-key is-add">+ {afterLabel}</span>
        <span className="spacer" />
        {!same && (
          <span className="diff-count">
            {diff.added > 0 && <span className="is-add">+{diff.added}</span>}
            {diff.removed > 0 && <span className="is-del">−{diff.removed}</span>}
            <span>
              {' '}
              {diff.added + diff.removed === 1 ? 'line' : 'lines'}
            </span>
          </span>
        )}
      </div>
      {same ? (
        <p className="diff-note">No differences: the text is the same in both.</p>
      ) : (
        <div className="diff" role="table" aria-label="Changes">
          {titleChanged && (
            <div className="diff-title">
              <span className="diff-title-label">Title</span>
              <Line row={{ op: 'del', text: before.title || 'Untitled' }} />
              <Line row={{ op: 'add', text: after.title || 'Untitled' }} />
            </div>
          )}
          {diff.rows.map((row, i) =>
            row.op === 'fold' ? (
              open.has(i) ? (
                row.rows.map((r, j) => <Line key={`${i}-${j}`} row={r} />)
              ) : (
                <button key={i} type="button" className="diff-fold" onClick={() => setOpen((s) => new Set(s).add(i))}>
                  <ChevronsUpDown size={13} aria-hidden="true" />
                  {row.rows.length} unchanged {row.rows.length === 1 ? 'line' : 'lines'}
                </button>
              )
            ) : (
              <Line key={i} row={row} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
