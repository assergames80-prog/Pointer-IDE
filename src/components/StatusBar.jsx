import { GitBranch, Sparkles, Bot, AlertTriangle, Loader2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { useChat } from '../lib/chat';
import { modelLabel } from './ChatPanel.jsx';

export default function StatusBar() {
  const root = useStore((s) => s.root);
  const branch = useStore((s) => s.branch);
  const cursor = useStore((s) => s.cursor);
  const info = useStore((s) => s.editorInfo);
  const settings = useStore((s) => s.settings);
  const keys = useStore((s) => s.keys);
  const hasTab = useStore((s) => s.tabs.some((t) => t.id === s.activeTab && t.kind === 'text'));
  const running = useChat((s) => Object.keys(s.runs).length > 0);
  const update = useStore((s) => s.updateSettings);
  const open = useStore((s) => s.openOverlay);
  const noKeys = !keys.google.set && !keys.groq.set;

  return (
    <div className="statusbar">
      {branch && (
        <span className="status-item" title="Git branch">
          <GitBranch size={12} /> {branch}
        </span>
      )}
      {noKeys && (
        <button className="status-item warn" onClick={() => open('settings', 'models')}>
          <AlertTriangle size={12} /> No API key — click to add
        </button>
      )}
      {running && (
        <span className="status-item">
          <Loader2 size={12} className="spin" /> Agent working…
        </span>
      )}
      <span className="spacer" />
      {hasTab && (
        <>
          <button className="status-item" onClick={() => open('quickOpen', ':')}>
            Ln {cursor.line}, Col {cursor.col}
            {cursor.selected ? ` (${cursor.selected} selected)` : ''}
          </button>
          <span className="status-item">Spaces: {info.tabSize}</span>
          <span className="status-item">{info.eol}</span>
          <span className="status-item">{info.language}</span>
        </>
      )}
      <button className="status-item" title="AI chat model" onClick={() => open('settings', 'models')}>
        <Bot size={12} /> {modelLabel(settings.chatModel)}
      </button>
      <button
        className="status-item"
        title={`AI Tab autocomplete is ${settings.autocompleteEnabled ? 'on' : 'off'} (click to toggle)`}
        onClick={() => update({ autocompleteEnabled: !settings.autocompleteEnabled })}
        style={{ opacity: settings.autocompleteEnabled ? 1 : 0.55 }}
      >
        <Sparkles size={12} /> Tab
      </button>
    </div>
  );
}
