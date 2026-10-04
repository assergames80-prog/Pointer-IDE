import { monaco } from './monaco';
import { api } from './api';
import { useStore } from './store';

// Ctrl+K inline edit: prompt box above the selection, AI rewrites it, the result is shown
// as an inline diff (removed lines in red above, new lines highlighted green) with Accept/Reject.

let active = null;

function modelLabel() {
  const st = useStore.getState();
  const sel = st.settings?.inlineModel || st.settings?.chatModel;
  if (!sel) return '';
  const m = st.models[sel.provider]?.find((x) => x.id === sel.model);
  return m?.label || sel.model;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function installInlineEdit(editor) {
  const ctxActive = editor.createContextKey('pointerInlineEdit', false);
  const ctxReady = editor.createContextKey('pointerInlineEditReady', false);

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => active?.accept(), 'pointerInlineEditReady');
  editor.addCommand(monaco.KeyCode.Escape, () => active?.reject(), 'pointerInlineEdit');

  // Ctrl+K belongs to us inside the editor (Monaco would treat it as a chord prefix).
  editor.getContainerDomNode().addEventListener(
    'keydown',
    (e) => {
      const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
        e.preventDefault();
        e.stopPropagation();
        start(editor, ctxActive, ctxReady);
      }
    },
    true,
  );

  editor.addAction({
    id: 'pointer.inlineEdit',
    label: 'Edit with AI',
    contextMenuGroupId: '0_ai',
    contextMenuOrder: 1,
    run: () => start(editor, ctxActive, ctxReady),
  });

  editor.onDidChangeModel(() => active?.dispose(true));
}

function start(editor, ctxActive, ctxReady) {
  if (active) {
    active.focus();
    return;
  }
  const model = editor.getModel();
  if (!model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  const sel = editor.getSelection();
  let range;
  if (sel.isEmpty()) {
    const p = sel.getPosition();
    range = new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column);
  } else {
    let endLine = sel.endLineNumber;
    if (sel.endColumn === 1 && endLine > sel.startLineNumber) endLine--;
    range = new monaco.Range(sel.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
  }
  const originalText = model.getValueInRange(range);
  const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);

  // --- widget DOM
  const root = el('div', 'inline-edit');
  const ta = el('textarea');
  ta.rows = 1;
  ta.placeholder = sel.isEmpty() ? 'Generate code… (Enter to submit, Esc to close)' : 'Edit selected code… (Enter to submit, Esc to close)';
  const bar = el('div', 'ie-bar');
  const status = el('span', '', modelLabel());
  const spacer = el('span', 'spacer');
  const btnCancel = el('button', 'btn ghost', 'Close');
  const btnGo = el('button', 'btn primary', 'Generate ⏎');
  const btnReject = el('button', 'btn', 'Reject  Esc');
  const btnAccept = el('button', 'btn primary', 'Accept  Ctrl+⏎');
  btnReject.style.display = 'none';
  btnAccept.style.display = 'none';
  bar.append(status, spacer, btnCancel, btnReject, btnGo, btnAccept);
  root.append(ta, bar);

  let widgetZoneId = null;
  let removedZoneId = null;
  let decorations = editor.createDecorationsCollection();
  let tracker = null;
  let generating = false;
  let hasResult = false;
  let disposed = false;
  let requestSeq = 0;

  const overlay = {
    getId: () => 'pointer.inlineEdit.widget',
    getDomNode: () => root,
    getPosition: () => null,
  };
  root.style.position = 'absolute';
  root.style.left = editor.getLayoutInfo().contentLeft + 8 + 'px';
  editor.addOverlayWidget(overlay);

  const placeZone = () => {
    editor.changeViewZones((acc) => {
      if (widgetZoneId) acc.removeZone(widgetZoneId);
      const startLine = (tracker ? tracker.getRange(0) : range)?.startLineNumber ?? range.startLineNumber;
      widgetZoneId = acc.addZone({
        afterLineNumber: startLine - 1,
        heightInPx: root.offsetHeight + 10,
        domNode: el('div'),
        ordinal: 0,
        onDomNodeTop: (top) => {
          root.style.top = top + 4 + 'px';
        },
      });
    });
  };

  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
    placeZone();
  };

  const clearResultUi = () => {
    decorations.clear();
    editor.changeViewZones((acc) => {
      if (removedZoneId) acc.removeZone(removedZoneId);
      removedZoneId = null;
    });
  };

  const setReady = (ready) => {
    hasResult = ready;
    ctxReady.set(ready);
    btnAccept.style.display = ready ? '' : 'none';
    btnReject.style.display = ready ? '' : 'none';
    btnGo.style.display = ready ? 'none' : '';
    btnCancel.style.display = ready ? 'none' : '';
    btnGo.textContent = 'Generate ⏎';
    ta.placeholder = ready ? 'Follow-up instruction… (Enter to regenerate)' : ta.placeholder;
  };

  const currentRange = () => (tracker ? tracker.getRange(0) : null) || range;

  const generate = async () => {
    const instruction = ta.value.trim();
    if (!instruction || generating) return;
    generating = true;
    const seq = ++requestSeq;
    status.textContent = '';
    const spin = el('span', 'ie-spinner');
    status.append(spin, document.createTextNode(' Generating…'));
    btnGo.disabled = true;
    try {
      const full = model.getFullModelRange();
      const r = currentRange();
      const before = model.getValueInRange(new monaco.Range(1, 1, r.startLineNumber, r.startColumn));
      const after = model.getValueInRange(new monaco.Range(r.endLineNumber, r.endColumn, full.endLineNumber, full.endColumn));
      const result = await api.inlineEdit({
        instruction,
        // Follow-up instructions refine the previous result.
        code: hasResult ? model.getValueInRange(r) : originalText,
        language: model.getLanguageId(),
        path: model.uri.scheme === 'file' ? model.uri.fsPath : 'untitled',
        before,
        after,
      });
      if (disposed || seq !== requestSeq) return;
      applyResult(result);
      status.textContent = modelLabel();
    } catch (e) {
      if (disposed) return;
      status.textContent = '⚠ ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      status.style.color = 'var(--danger)';
      setTimeout(() => (status.style.color = ''), 4000);
    } finally {
      generating = false;
      btnGo.disabled = false;
    }
  };

  const applyResult = (text) => {
    clearResultUi();
    let newText = text;
    // Keep a trailing newline structure consistent with the original selection.
    if (!sel.isEmpty() && newText.endsWith('\n') && !originalText.endsWith('\n')) newText = newText.replace(/\n+$/, '');
    const target = currentRange();
    editor.pushUndoStop();
    editor.executeEdits('pointer.inlineEdit', [{ range: target, text: newText, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    const lines = newText.split('\n');
    const endLine = target.startLineNumber + lines.length - 1;
    const endCol = lines.length === 1 ? target.startColumn + lines[0].length : lines[lines.length - 1].length + 1;
    const newRange = new monaco.Range(target.startLineNumber, target.startColumn, endLine, endCol);
    if (!tracker) tracker = editor.createDecorationsCollection();
    tracker.set([{ range: newRange, options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }]);
    if (newText) {
      decorations.set([{ range: new monaco.Range(newRange.startLineNumber, 1, newRange.endLineNumber, 1), options: { isWholeLine: true, className: 'ie-added-line' } }]);
    }
    if (originalText) {
      const dom = el('div', 'ie-removed-zone');
      dom.style.fontFamily = fontInfo.fontFamily;
      dom.style.fontSize = fontInfo.fontSize + 'px';
      dom.style.lineHeight = lineHeight + 'px';
      dom.style.paddingLeft = '0px';
      dom.textContent = originalText;
      editor.changeViewZones((acc) => {
        removedZoneId = acc.addZone({
          afterLineNumber: newRange.startLineNumber - 1,
          heightInLines: originalText.split('\n').length,
          domNode: dom,
          ordinal: 1,
        });
      });
    }
    setReady(true);
    ta.value = '';
    autosize();
    editor.revealRangeInCenterIfOutsideViewport(newRange);
  };

  const dispose = (keep = true) => {
    if (disposed) return;
    disposed = true;
    if (!keep && hasResult) {
      const r = currentRange();
      editor.pushUndoStop();
      editor.executeEdits('pointer.inlineEdit.reject', [{ range: r, text: originalText }]);
      editor.pushUndoStop();
    }
    clearResultUi();
    tracker?.clear();
    editor.changeViewZones((acc) => widgetZoneId && acc.removeZone(widgetZoneId));
    editor.removeOverlayWidget(overlay);
    ctxActive.set(false);
    ctxReady.set(false);
    active = null;
    editor.focus();
  };

  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasResult) dispose(false);
      else dispose(true);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && hasResult) {
      e.preventDefault();
      dispose(true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      generate();
    }
  });
  btnGo.onclick = generate;
  btnCancel.onclick = () => dispose(true);
  btnAccept.onclick = () => dispose(true);
  btnReject.onclick = () => dispose(false);

  active = {
    accept: () => dispose(true),
    reject: () => dispose(!hasResult),
    dispose,
    focus: () => ta.focus(),
  };
  ctxActive.set(true);
  requestAnimationFrame(() => {
    placeZone();
    editor.revealLineInCenterIfOutsideViewport(range.startLineNumber);
    ta.focus();
  });
}
