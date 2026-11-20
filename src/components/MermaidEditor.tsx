import { useEffect, useRef, useState } from 'react';
import { MERMAID_TEMPLATES, mermaidErrorMessage, renderMermaid } from '../lib/mermaid';
import { useMediaQuery, useResolvedTheme } from '../lib/settings';
import { confirmDialog, useApp } from '../lib/store';
import { Modal, Segmented, Spinner } from './ui';

export function MermaidEditor() {
  const request = useApp((s) => s.mermaid);
  const theme = useResolvedTheme();
  const narrow = useMediaQuery('(max-width: 759px)');
  const [code, setCode] = useState('');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [tab, setTab] = useState<'code' | 'preview'>('code');
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** The code the editor opened with, to tell whether closing would discard anything. */
  const startCode = useRef('');

  useEffect(() => {
    if (!request) return;
    startCode.current = request.code || (request.isNew ? MERMAID_TEMPLATES[0].code : '');
    setCode(startCode.current);
    setTab('code');
    setSvg('');
    setError(null);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const src = code.trim();
    if (!src) {
      setSvg('');
      setError(null);
      return;
    }
    let cancelled = false;
    setRendering(true);
    const t = setTimeout(() => {
      renderMermaid(src, theme)
        .then((out) => {
          if (cancelled) return;
          setSvg(out);
          setError(null);
        })
        .catch((err) => !cancelled && setError(mermaidErrorMessage(err)))
        .finally(() => !cancelled && setRendering(false));
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code, theme, request]);

  if (!request) return null;

  const finish = (value: string | null) => {
    useApp.setState({ mermaid: null });
    request.resolve(value);
  };

  /** Esc, the close button and Cancel: ask first if the code was changed. */
  const cancel = async () => {
    if (code !== startCode.current) {
      const ok = await confirmDialog({
        title: 'Discard changes to this diagram?',
        message: 'Your edits to the diagram’s code will be lost.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    finish(null);
  };

  return (
    <Modal
      open
      size="xl"
      title={request.isNew ? 'New diagram' : 'Edit diagram'}
      description="Write Mermaid code on the left; the preview updates as you type."
      onClose={() => void cancel()}
      closeOnBackdrop={false}
      initialFocus="textarea"
      className="mermaid-modal"
      footer={
        <>
          <a className="footer-link" href="https://mermaid.js.org/intro/syntax-reference.html" target="_blank" rel="noopener noreferrer">
            Mermaid syntax guide
          </a>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => void cancel()}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => finish(code)} disabled={!code.trim()}>
            {request.isNew ? 'Insert diagram' : 'Save diagram'}
          </button>
        </>
      }
    >
      <div className="template-row" role="group" aria-label="Start from a template">
        {MERMAID_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="chip-btn"
            onClick={async () => {
              const edited = code.trim() && !MERMAID_TEMPLATES.some((x) => x.code === code);
              if (edited) {
                const ok = await confirmDialog({
                  title: `Replace your diagram with the ${t.label.toLowerCase()} template?`,
                  confirmLabel: 'Replace',
                });
                if (!ok) return;
              }
              setCode(t.code);
              textRef.current?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {narrow && (
        <div className="mermaid-tabs">
          <Segmented
            label="Show"
            full
            value={tab}
            onChange={setTab}
            options={[
              { value: 'code', label: 'Code' },
              { value: 'preview', label: 'Preview' },
            ]}
          />
        </div>
      )}
      <div className="mermaid-split">
        {(!narrow || tab === 'code') && (
          <textarea
            ref={textRef}
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Diagram code"
            onKeyDown={(e) => {
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: s, selectionEnd: end } = el;
                const next = `${code.slice(0, s)}    ${code.slice(end)}`;
                setCode(next);
                requestAnimationFrame(() => el.setSelectionRange(s + 4, s + 4));
              } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                // As the Save button: no saving an empty diagram over the one in the note.
                if (code.trim()) finish(code);
              }
            }}
          />
        )}
        {(!narrow || tab === 'preview') && (
          <div className="mermaid-preview" aria-live="polite">
            {rendering && !svg && <Spinner label="Rendering diagram" />}
            {error && (
              <div className="kb-mermaid-error">
                <strong>The diagram can’t be drawn yet.</strong>
                <pre>{error}</pre>
              </div>
            )}
            {svg && <div className={`mermaid-preview-svg${error ? ' is-stale' : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />}
          </div>
        )}
      </div>
    </Modal>
  );
}
