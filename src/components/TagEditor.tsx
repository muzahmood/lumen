import { useMemo, useRef, useState } from 'react';
import { Hash, X } from 'lucide-react';
import { cleanTags } from '../../shared/noteText';
import { useApp } from '../lib/store';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  readOnly?: boolean;
}

export function TagEditor({ tags, onChange, readOnly }: Props) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const notes = useApp((s) => s.notes);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of Object.values(notes)) {
      if (n.deleted_at) continue;
      for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [notes]);

  const lower = new Set(tags.map((t) => t.toLowerCase()));
  const q = draft.trim().replace(/^#/, '').toLowerCase();
  const suggestions = focused
    ? allTags.filter((t) => !lower.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q))).slice(0, 6)
    : [];

  const add = (raw: string) => {
    // Cleaned as every tag is ("# job" is "job"), so what's shown is what's saved.
    const tag = cleanTags([raw])[0] ?? '';
    setDraft('');
    if (!tag || lower.has(tag.toLowerCase())) return;
    onChange([...tags, tag]);
  };

  if (readOnly && !tags.length) return null;

  return (
    <div className="tags-row">
      {tags.map((t) => (
        <span key={t} className="tag">
          <Hash size={12} aria-hidden="true" />
          {t}
          {!readOnly && (
            <button type="button" className="tag-remove" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <span className="tag-input-wrap">
          <input
            ref={inputRef}
            className="tag-input"
            name="note-tag"
            value={draft}
            placeholder={tags.length ? 'Add tag' : 'Add tags'}
            aria-label="Add tag"
            onChange={(e) => {
              const v = e.target.value;
              if (/[,\n]$/.test(v)) add(v.slice(0, -1));
              else setDraft(v);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setTimeout(() => setFocused(false), 150);
              // Escape drops what was typed; leaving the box any other way keeps it as a tag.
              if (cancelled.current) cancelled.current = false;
              else if (draft.trim()) add(draft);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Tab') {
                if (draft.trim()) {
                  e.preventDefault();
                  add(draft);
                }
              } else if (e.key === 'Backspace' && !draft && tags.length) {
                onChange(tags.slice(0, -1));
              } else if (e.key === 'Escape') {
                cancelled.current = true;
                setDraft('');
                inputRef.current?.blur();
              }
            }}
          />
          {suggestions.length > 0 && (
            <span className="tag-suggest" role="listbox">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    add(s);
                    inputRef.current?.focus();
                  }}
                >
                  #{s}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
