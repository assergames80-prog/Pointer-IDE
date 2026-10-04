import { monaco } from './monaco';
import { api } from './api';
import { useStore } from './store';

// "Tab" autocomplete: ghost-text suggestions from a fast model (Groq by default).

let registered = false;
let lastRequest = 0;

export function registerAutocomplete() {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider('*', {
    debounceDelayMs: 350,
    async provideInlineCompletions(model, position, context, token) {
      const st = useStore.getState();
      if (!st.settings?.autocompleteEnabled) return { items: [] };
      if (!st.keys.google.set && !st.keys.groq.set) return { items: [] };
      if (model.uri.scheme !== 'file' && model.uri.scheme !== 'untitled') return { items: [] };
      const lineText = model.getLineContent(position.lineNumber);
      const after = lineText.slice(position.column - 1);
      // Don't suggest in the middle of a word or when there's real code right after the cursor.
      if (/^[\w$]/.test(after)) return { items: [] };
      if (after.trim() && !/^[)\]}'"`;,.\s]*$/.test(after)) return { items: [] };
      if (model.getValueLength() > 2_000_000) return { items: [] };

      const myReq = ++lastRequest;
      await new Promise((r) => setTimeout(r, context.triggerKind === 1 ? 0 : 150));
      if (token.isCancellationRequested || myReq !== lastRequest) return { items: [] };

      const full = model.getFullModelRange();
      const prefix = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const suffix = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: full.endLineNumber, endColumn: full.endColumn });
      let text = '';
      try {
        text = await api.autocomplete({
          prefix,
          suffix,
          language: model.getLanguageId(),
          path: model.uri.scheme === 'file' ? model.uri.fsPath : 'untitled',
        });
      } catch (e) {
        return { items: [] };
      }
      if (token.isCancellationRequested || !text || !text.trim()) return { items: [] };
      return {
        items: [
          {
            insertText: text,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          },
        ],
      };
    },
    disposeInlineCompletions() {},
    freeInlineCompletions() {},
  });
}
