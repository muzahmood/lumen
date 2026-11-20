import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  codeBlockLines,
  completionSources,
  editorTheme,
  imagePeeks,
  markdownHighlight,
  pasteAndDrop,
  proseBrackets,
  type HostRef,
} from '../lib/editorExtensions';
import { insertLink, setHeading, toggleTask, toggleWrap } from '../lib/editorCommands';
import { livePreview } from '../lib/livePreview';
import { isMac } from '../lib/utils';

export interface EditorHandle {
  view: () => EditorView | null;
  focus: () => void;
  undo: () => void;
  redo: () => void;
  /**
   * Shows `text` in place of what's there (another device's version, or that merged with the edits
   * here): the cursor stays where it was in the text around it, and it's neither an edit to save nor a
   * step to undo.
   */
  replaceAll: (text: string) => void;
}

/** Marks a change that came from elsewhere (see replaceAll): not typed here, so not reported as an edit. */
const fromElsewhere = Annotation.define<boolean>();

/**
 * CodeMirror's standard keys, less Ctrl Alt \ (indent selection) away from a Mac: Windows reports
 * AltGr as Ctrl Alt, and AltGr types \ on German, French, Nordic and many other keyboards, which
 * the binding would swallow (LaTeX would be unwritable there). Tab still indents.
 */
const EDITOR_DEFAULT_KEYMAP = isMac() ? defaultKeymap : defaultKeymap.filter((b) => b.key !== 'Mod-Alt-\\');

/** The smallest single change turning `current` into `next`: what differs between their common start and end. */
function changeBetween(current: string, next: string): { from: number; to: number; insert: string } | null {
  if (current === next) return null;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endA = current.length;
  let endB = next.length;
  while (endA > start && endB > start && current.charCodeAt(endA - 1) === next.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: next.slice(start, endB) };
}

interface Props {
  docKey: string;
  value: string;
  onChange: (value: string) => void;
  host: HostRef;
  spellcheck: boolean;
  showImages: boolean;
  livePreview: boolean;
  autoFocus?: boolean;
  /** The selected text (all ranges, joined), each time it changes; '' with nothing selected. */
  onSelectionText?: (text: string) => void;
}

// React 19: `ref` is an ordinary prop.
export function Editor({ ref, ...props }: Props & { ref?: Ref<EditorHandle> }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onSelectionRef = useRef(props.onSelectionText);
  onSelectionRef.current = props.onSelectionText;
  const richComp = useMemo(() => new Compartment(), []);
  const attrsComp = useMemo(() => new Compartment(), []);
  const rich = (lp: boolean, images: boolean) => (lp ? livePreview(props.host) : images ? imagePeeks : []);

  useEffect(() => {
    const view = new EditorView({
      parent: parentRef.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          proseBrackets,
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
          syntaxHighlighting(markdownHighlight),
          editorTheme,
          codeBlockLines,
          placeholder('Start writing, or press / for headings, tasks, diagrams and drawings'),
          autocompletion({ override: completionSources(props.host), icons: false, defaultKeymap: true }),
          pasteAndDrop(props.host),
          keymap.of([
            { key: 'Mod-b', run: (v) => (toggleWrap(v, '**'), true) },
            { key: 'Mod-i', run: (v) => (toggleWrap(v, '*'), true) },
            { key: 'Mod-Shift-x', run: (v) => (toggleWrap(v, '~~'), true) },
            { key: 'Mod-Shift-h', run: (v) => (toggleWrap(v, '=='), true) },
            { key: 'Mod-`', run: (v) => (toggleWrap(v, '`', '`', 'code'), true) },
            { key: 'Mod-Shift-k', run: (v) => (insertLink(v), true) },
            // Ahead of the default Mod-Enter (a blank line below).
            { key: 'Mod-Enter', run: toggleTask },
            // Ctrl/⌘ Alt 1–6 for headings and 0 for plain text, as in Google Docs (Chrome keeps Ctrl 1–8 for tabs).
            ...[0, 1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-Alt-${level}`, run: (v: EditorView) => (setHeading(v, level), true) })),
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...EDITOR_DEFAULT_KEYMAP,
            indentWithTab,
          ]),
          richComp.of(rich(props.livePreview, props.showImages)),
          attrsComp.of(
            EditorView.contentAttributes.of({
              spellcheck: String(props.spellcheck),
              autocorrect: 'on',
              autocapitalize: 'sentences',
              'aria-label': 'Note text',
            }),
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromElsewhere))) onChangeRef.current(u.state.doc.toString());
            if ((u.selectionSet || u.docChanged) && onSelectionRef.current) {
              const ranges = u.state.selection.ranges.filter((r) => !r.empty);
              onSelectionRef.current(ranges.map((r) => u.state.sliceDoc(r.from, r.to)).join('\n'));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (props.autoFocus) {
      requestAnimationFrame(() => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
    }
    return () => {
      // Nothing is selected in an editor that's gone.
      onSelectionRef.current?.('');
      view.destroy();
      viewRef.current = null;
    };
    // The editor is recreated per note; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey]);

  // Apply content changes made outside the editor (task toggles, diagram edits, restores).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // The editor keeps "\n" line breaks: a note written with Windows ones ("\r\n") isn't a change.
    const change = changeBetween(view.state.doc.toString(), props.value.replace(/\r\n?/g, '\n'));
    if (change) view.dispatch({ changes: change });
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: richComp.reconfigure(rich(props.livePreview, props.showImages)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.showImages, props.livePreview, richComp]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: attrsComp.reconfigure(
        EditorView.contentAttributes.of({
          spellcheck: String(props.spellcheck),
          autocorrect: 'on',
          autocapitalize: 'sentences',
          'aria-label': 'Note text',
        }),
      ),
    });
  }, [props.spellcheck, attrsComp]);

  useImperativeHandle(
    ref,
    () => ({
      view: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
      undo: () => {
        const v = viewRef.current;
        if (v) undo(v);
      },
      redo: () => {
        const v = viewRef.current;
        if (v) redo(v);
      },
      replaceAll: (text) => {
        const v = viewRef.current;
        const change = v && changeBetween(v.state.doc.toString(), text.replace(/\r\n?/g, '\n'));
        if (!v || !change) return;
        v.dispatch({ changes: change, annotations: [fromElsewhere.of(true), Transaction.addToHistory.of(false)] });
      },
    }),
    [],
  );

  return <div className="editor-host" ref={parentRef} />;
}
