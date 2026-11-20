import { useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { FileDown, FileText, Printer } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { defaultPaper, exportMarkdown, noteAttachments, printNote, type ExportNote } from '../lib/exportNote';
import { ACCENTS, useSettings, type Settings } from '../lib/settings';
import { toast } from '../lib/store';
import { downloadBlob, noteTitle, safeName } from '../lib/utils';
import { Modal, Segmented } from './ui';

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Switch({ k, label, disabled }: { k: keyof Settings; label: string; disabled?: boolean }) {
  const value = useSettings((s) => s[k]) as boolean;
  const update = useSettings((s) => s.update);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value && !disabled}
      aria-label={label}
      disabled={disabled}
      className={`switch${value && !disabled ? ' is-on' : ''}`}
      onClick={() => update({ [k]: !value } as Partial<Settings>)}
    >
      <span />
    </button>
  );
}

/** Export the open note as a PDF (through the browser's print window) or as Markdown. */
export function ExportDialog({ note, onClose }: { note: ExportNote; onClose: () => void }) {
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const attachments = useMemo(() => noteAttachments(note.content), [note.content]);
  const format = settings.exportFormat;
  const paper = settings.exportPaper ?? defaultPaper();
  const zipped = settings.exportAttachments && attachments.length > 0;
  const base = safeName(noteTitle(note.title));

  const run = async () => {
    setBusy(true);
    try {
      if (format === 'pdf') {
        const accent = (ACCENTS[settings.accent] ?? ACCENTS.iris).light;
        // Closed for real before the print window opens, so it isn't left on screen behind it.
        await printNote(
          note,
          { paper, title: settings.exportTitle, details: settings.exportDetails, breaks: settings.lineBreaks, accent },
          () => flushSync(onClose),
        );
        return;
      }
      const { blob, filename, missing } = await exportMarkdown(note, {
        attachments: settings.exportAttachments,
        frontMatter: settings.exportFrontMatter,
      });
      downloadBlob(blob, filename);
      onClose();
      if (missing) {
        toast(`Downloaded ${filename}, but ${missing} ${missing === 1 ? 'attachment' : 'attachments'} couldn’t be fetched; ${missing === 1 ? 'its link points' : 'their links point'} to Lumen instead.`, {
          kind: 'error',
        });
      } else {
        toast(`Downloaded ${filename}`, { kind: 'success' });
      }
    } catch (err) {
      toast(`Couldn’t export the note: ${errorMessage(err)}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const action =
    format === 'pdf' ? (
      <>
        <Printer size={15} /> Save as PDF
      </>
    ) : (
      <>
        <FileDown size={15} /> Download .{zipped ? 'zip' : 'md'}
      </>
    );

  return (
    <Modal
      open
      size="sm"
      title="Export note"
      description={noteTitle(note.title)}
      onClose={() => !busy && onClose()}
      className="export-dialog"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy}>
            {busy ? 'Preparing…' : action}
          </button>
        </>
      }
    >
      <Segmented
        label="Format"
        full
        value={format}
        onChange={(v) => settings.update({ exportFormat: v })}
        options={[
          { value: 'pdf', label: 'PDF', icon: <Printer size={14} /> },
          { value: 'md', label: 'Markdown', icon: <FileText size={14} /> },
        ]}
      />

      {format === 'pdf' ? (
        <>
          <div className="export-options">
            <Row label="Paper">
              <Segmented
                label="Paper"
                size="sm"
                value={paper}
                onChange={(v) => settings.update({ exportPaper: v })}
                options={[
                  { value: 'a4', label: 'A4' },
                  { value: 'letter', label: 'Letter' },
                ]}
              />
            </Row>
            <Row label="Title" hint="The note’s title at the top of the first page.">
              <Switch k="exportTitle" label="Title" />
            </Row>
            <Row label="Date and tags" hint="When it was last edited, and its tags, under the title.">
              <Switch k="exportDetails" label="Date and tags" />
            </Row>
          </div>
          <p className="export-note">
            Your browser’s print window opens next: choose <strong>Save as PDF</strong> as the destination. The file is named “{base}”. To
            leave out the page address and date, turn off <strong>Headers and footers</strong> there.
          </p>
        </>
      ) : (
        <>
          <div className="export-options">
            <Row
              label="Images and drawings"
              hint={
                attachments.length
                  ? `Put the ${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} this note uses in a .zip beside it, so its images work anywhere.`
                  : 'This note has no images, files or drawings.'
              }
            >
              <Switch k="exportAttachments" label="Include images and drawings" disabled={!attachments.length} />
            </Row>
            <Row label="Front matter" hint="Title, tags and dates in a YAML header, as Obsidian and similar apps read them.">
              <Switch k="exportFrontMatter" label="Front matter" />
            </Row>
          </div>
          <p className="export-note">
            {zipped
              ? `Downloads “${base}.zip” with the note as Markdown and its files in folders beside it.`
              : `Downloads “${base}.md”.${attachments.length ? ' Its images and drawings link back to Lumen, so they only show while you’re signed in.' : ''}`}
          </p>
        </>
      )}
    </Modal>
  );
}
