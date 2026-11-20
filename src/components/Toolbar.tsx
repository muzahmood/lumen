import type { ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  Bold,
  Camera,
  CheckSquare,
  Code,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Minus,
  MoreHorizontal,
  Paperclip,
  PenTool,
  Pi,
  Pilcrow,
  Quote,
  Redo2,
  Sigma,
  Strikethrough,
  Table,
  Undo2,
  Workflow,
  SquareChevronRight,
} from 'lucide-react';
import {
  insertBlock,
  insertCodeBlock,
  insertFootnote,
  insertLink,
  insertTable,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
} from '../lib/editorCommands';
import type { EditorHost } from '../lib/editorExtensions';
import { modKey } from '../lib/utils';
import { MenuButton } from './ui';

interface Props {
  getView: () => EditorView | null;
  host: EditorHost;
  onUndo: () => void;
  onRedo: () => void;
  compact?: boolean;
}

function Tool({ label, onRun, children, kbd }: { label: string; onRun: () => void; children: ReactNode; kbd?: string }) {
  return (
    <button
      type="button"
      className="tool"
      aria-label={label}
      data-tip={label}
      data-tip-kbd={kbd}
      // Keep focus (and the phone keyboard) in the editor.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function Toolbar({ getView, host, onUndo, onRedo, compact }: Props) {
  const m = modKey();
  const v = (fn: (view: EditorView) => void) => () => {
    const view = getView();
    if (view) fn(view);
  };
  const s = 17;

  const moreItems = () => [
    { label: 'Strikethrough', icon: <Strikethrough size={15} />, hint: `${m} Shift X`, onSelect: v((x) => toggleWrap(x, '~~')) },
    { label: 'Callout', icon: <MessageSquareQuote size={15} />, onSelect: v((x) => insertBlock(x, '> [!note] Note\n> ', [10, 14])) },
    { label: 'Collapsible section', icon: <SquareChevronRight size={15} />, onSelect: v((x) => insertBlock(x, '<details>\n<summary>Summary</summary>\n\nHidden content\n\n</details>', [19, 26])) },
    { label: 'Inline math', icon: <Pi size={15} />, hint: '$x$', onSelect: v((x) => toggleWrap(x, '$', '$', 'x')) },
    { label: 'Math block', icon: <Sigma size={15} />, hint: '$$', onSelect: v((x) => insertBlock(x, '$$\n\n$$', [3, 3])) },
    { label: 'Divider', icon: <Minus size={15} />, onSelect: v((x) => insertBlock(x, '---')) },
    { label: 'Footnote', icon: <Pilcrow size={15} />, onSelect: v(insertFootnote) },
    { separator: true },
    { label: 'Attach a file', icon: <Paperclip size={15} />, onSelect: host.pickFiles },
    ...(compact ? [] : [{ label: 'Take a photo', icon: <Camera size={15} />, onSelect: host.takePhoto }]),
  ];

  const headingItems = [
    { label: 'Heading 1', icon: <Heading1 size={15} />, hint: '#', onSelect: v((x) => setHeading(x, 1)) },
    { label: 'Heading 2', icon: <Heading2 size={15} />, hint: '##', onSelect: v((x) => setHeading(x, 2)) },
    { label: 'Heading 3', icon: <Heading3 size={15} />, hint: '###', onSelect: v((x) => setHeading(x, 3)) },
    { label: 'Normal text', icon: <Pilcrow size={15} />, onSelect: v((x) => setHeading(x, 0)) },
  ];

  return (
    <div className={`dock${compact ? ' is-compact' : ''}`} role="toolbar" aria-label="Formatting">
      {compact && (
        <>
          <Tool label="Undo" onRun={onUndo}>
            <Undo2 size={s} />
          </Tool>
          <Tool label="Redo" onRun={onRedo}>
            <Redo2 size={s} />
          </Tool>
          <span className="dock-sep" />
        </>
      )}
      <MenuButton label="Text style" icon={<Heading size={s} />} items={headingItems} align="start" className="tool" />
      <Tool label="Bold" kbd={`${m} B`} onRun={v((x) => toggleWrap(x, '**'))}>
        <Bold size={s} />
      </Tool>
      <Tool label="Italic" kbd={`${m} I`} onRun={v((x) => toggleWrap(x, '*'))}>
        <Italic size={s} />
      </Tool>
      <Tool label="Highlight" kbd={`${m} Shift H`} onRun={v((x) => toggleWrap(x, '=='))}>
        <Highlighter size={s} />
      </Tool>
      <span className="dock-sep" />
      <Tool label="Checklist" onRun={v((x) => toggleLinePrefix(x, 'task'))}>
        <CheckSquare size={s} />
      </Tool>
      <Tool label="Bulleted list" onRun={v((x) => toggleLinePrefix(x, 'bullet'))}>
        <List size={s} />
      </Tool>
      {!compact && (
        <Tool label="Numbered list" onRun={v((x) => toggleLinePrefix(x, 'number'))}>
          <ListOrdered size={s} />
        </Tool>
      )}
      {!compact && (
        <Tool label="Quote" onRun={v((x) => toggleLinePrefix(x, 'quote'))}>
          <Quote size={s} />
        </Tool>
      )}
      <span className="dock-sep" />
      {!compact && (
        <Tool label="Link" kbd={`${m} Shift K`} onRun={v(insertLink)}>
          <Link2 size={s} />
        </Tool>
      )}
      <Tool label="Image" onRun={host.pickImages}>
        <ImagePlus size={s} />
      </Tool>
      {compact && (
        <Tool label="Take a photo" onRun={host.takePhoto}>
          <Camera size={s} />
        </Tool>
      )}
      <Tool label="Drawing" onRun={host.openDrawing}>
        <PenTool size={s} />
      </Tool>
      <Tool label="Diagram" onRun={() => host.openMermaid()}>
        <Workflow size={s} />
      </Tool>
      <Tool label="Table" onRun={v((x) => insertTable(x))}>
        <Table size={s} />
      </Tool>
      {!compact && (
        <Tool label="Code block" onRun={v((x) => insertCodeBlock(x))}>
          <Code size={s} />
        </Tool>
      )}
      <span className="dock-sep" />
      <MenuButton label="More formatting" icon={<MoreHorizontal size={s} />} items={moreItems} align="end" className="tool" />
    </div>
  );
}
