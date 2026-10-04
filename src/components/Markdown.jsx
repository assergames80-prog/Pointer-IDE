import { memo, useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { activeEditor, useStore } from '../lib/store';
import { api } from '../lib/api';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const codeStore = new Map();
let codeSeq = 0;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const info = (lang || '').trim();
      // Support ```ts src/file.ts  and ```ts:src/file.ts
      const [language, ...rest] = info.split(/[\s:]+/);
      const file = rest.join(' ');
      let html;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
      } catch {
        html = escapeHtml(text);
      }
      const id = `c${++codeSeq}`;
      codeStore.set(id, text);
      if (codeStore.size > 2000) codeStore.delete(codeStore.keys().next().value);
      return `<div class="codeblock"><div class="codeblock-head"><span class="lang">${escapeHtml(file || language || 'text')}</span><button data-act="insert" data-id="${id}" title="Insert at cursor in the editor">Insert</button><button data-act="copy" data-id="${id}">Copy</button></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

function onClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const text = codeStore.get(btn.dataset.id) || '';
    if (btn.dataset.act === 'copy') {
      navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    } else if (btn.dataset.act === 'insert') {
      const ed = activeEditor;
      if (!ed?.getModel()) {
        useStore.getState().newUntitled(text);
        return;
      }
      const sel = ed.getSelection();
      ed.pushUndoStop();
      ed.executeEdits('pointer.insert', [{ range: sel, text, forceMoveMarkers: true }]);
      ed.pushUndoStop();
      ed.focus();
    }
    return;
  }
  const a = e.target.closest('a');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) api.openExternal(href);
  }
}

function Markdown({ text, streaming }) {
  const html = useMemo(() => {
    let src = text || '';
    // While streaming, close an unterminated code fence so it renders as code.
    if (streaming && (src.match(/```/g) || []).length % 2 === 1) src += '\n```';
    return DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['data-act', 'data-id', 'target'] });
  }, [text, streaming]);
  return <div className={`md ${streaming ? 'cursor-blink-last' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

export default memo(Markdown);
