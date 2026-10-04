import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Without a project-aware language server, semantic errors ("cannot find module") are noise.
try {
  const ts = monaco.typescript || monaco.languages.typescript;
  if (ts) {
    for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true });
      defaults.setCompilerOptions({
        target: ts.ScriptTarget?.ESNext ?? 99,
        allowNonTsExtensions: true,
        allowJs: true,
        jsx: ts.JsxEmit?.Preserve ?? 1,
        moduleResolution: ts.ModuleResolutionKind?.NodeJs ?? 2,
        module: ts.ModuleKind?.ESNext ?? 99,
        esModuleInterop: true,
      });
      defaults.setEagerModelSync(true);
    }
  }
} catch (e) {
  console.warn('TS defaults', e);
}

monaco.editor.defineTheme('pointer-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6A737D', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C792EA' },
    { token: 'string', foreground: 'A5D6A7' },
    { token: 'number', foreground: 'F78C6C' },
    { token: 'type', foreground: '82AAFF' },
    { token: 'type.identifier', foreground: '82AAFF' },
    { token: 'identifier', foreground: 'D6DEEB' },
    { token: 'delimiter', foreground: 'A6ACCD' },
    { token: 'tag', foreground: 'F07178' },
    { token: 'attribute.name', foreground: 'FFCB6B' },
    { token: 'attribute.value', foreground: 'A5D6A7' },
    { token: 'regexp', foreground: '89DDFF' },
    { token: 'key', foreground: '82AAFF' },
    { token: 'string.key.json', foreground: '82AAFF' },
    { token: 'string.value.json', foreground: 'A5D6A7' },
  ],
  colors: {
    'editor.background': '#181818',
    'editor.foreground': '#D6DEEB',
    'editorLineNumber.foreground': '#4B4B4B',
    'editorLineNumber.activeForeground': '#B0B0B0',
    'editor.lineHighlightBackground': '#ffffff08',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#3E8BFF40',
    'editor.inactiveSelectionBackground': '#3E8BFF22',
    'editorCursor.foreground': '#E6E6E6',
    'editorIndentGuide.background1': '#2A2A2A',
    'editorIndentGuide.activeBackground1': '#444444',
    'editorWhitespace.foreground': '#333333',
    'editorGutter.background': '#181818',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#303030',
    'editorSuggestWidget.background': '#202020',
    'editorSuggestWidget.border': '#303030',
    'editorSuggestWidget.selectedBackground': '#2C2C2C',
    'editorHoverWidget.background': '#202020',
    'editorHoverWidget.border': '#303030',
    'editorGhostText.foreground': '#7A7A7A',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'scrollbarSlider.activeBackground': '#ffffff30',
    'minimap.background': '#181818',
    'diffEditor.insertedTextBackground': '#3FB95022',
    'diffEditor.removedTextBackground': '#F8514922',
    'diffEditor.insertedLineBackground': '#3FB95014',
    'diffEditor.removedLineBackground': '#F8514914',
    'input.background': '#222222',
    'focusBorder': '#3E8BFF80',
  },
});

monaco.editor.defineTheme('pointer-light', {
  base: 'vs',
  inherit: true,
  rules: [{ token: 'comment', foreground: '8A8A8A', fontStyle: 'italic' }],
  colors: {
    'editor.background': '#FFFFFF',
    'editorLineNumber.foreground': '#B5B5B5',
    'editorLineNumber.activeForeground': '#444444',
    'editor.lineHighlightBackground': '#00000006',
    'editor.lineHighlightBorder': '#00000000',
    'editorGutter.background': '#FFFFFF',
    'minimap.background': '#FFFFFF',
    'editorGhostText.foreground': '#A0A0A0',
  },
});

export function monacoTheme(theme) {
  return theme === 'light' ? 'pointer-light' : 'pointer-dark';
}

export function languageForPath(path) {
  if (!path) return 'plaintext';
  const lower = path.toLowerCase();
  const base = lower.split(/[\\/]/).pop();
  const special = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    '.gitignore': 'ini',
    '.env': 'ini',
    '.npmrc': 'ini',
    '.editorconfig': 'ini',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
    '.babelrc': 'json',
  };
  if (special[base]) return special[base];
  if (base.startsWith('.env')) return 'ini';
  const ext = base.includes('.') ? '.' + base.split('.').pop() : '';
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(ext)) return lang.id;
    if (lang.filenames?.map((f) => f.toLowerCase()).includes(base)) return lang.id;
  }
  if (ext === '.jsx') return 'javascript';
  if (ext === '.tsx') return 'typescript';
  if (ext === '.vue' || ext === '.svelte') return 'html';
  if (ext === '.toml') return 'ini';
  return 'plaintext';
}

export function languageLabel(id) {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] || id;
}

export { monaco };
