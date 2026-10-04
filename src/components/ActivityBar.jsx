import { Files, Search, Settings, Bot } from 'lucide-react';
import { useStore } from '../lib/store';
import { useChat } from '../lib/chat';

export default function ActivityBar() {
  const layout = useStore((s) => s.layout);
  const show = useStore((s) => s.showSidebarView);
  const openOverlay = useStore((s) => s.openOverlay);
  const toggle = useStore((s) => s.toggle);
  const dirtyCount = useStore((s) => Object.keys(s.dirty).length);
  const running = useChat((s) => Object.keys(s.runs).length);

  return (
    <div className="activitybar">
      <button className={`icon-btn ${layout.sidebar && layout.sidebarView === 'explorer' ? 'active' : ''}`} title="Explorer (Ctrl+Shift+E)" onClick={() => show('explorer')}>
        <Files size={19} strokeWidth={1.7} />
        {dirtyCount > 0 && <span className="badge">{dirtyCount}</span>}
      </button>
      <button className={`icon-btn ${layout.sidebar && layout.sidebarView === 'search' ? 'active' : ''}`} title="Search (Ctrl+Shift+F)" onClick={() => show('search')}>
        <Search size={19} strokeWidth={1.7} />
      </button>
      <button className={`icon-btn ${layout.chat ? 'active' : ''}`} title="AI Agent (Ctrl+I)" onClick={() => toggle('chat')}>
        <Bot size={19} strokeWidth={1.7} className={running ? 'pulse' : ''} />
        {running > 0 && <span className="badge">•</span>}
      </button>
      <div className="spacer" />
      <button className="icon-btn" title="Settings (Ctrl+,)" onClick={() => openOverlay('settings')}>
        <Settings size={19} strokeWidth={1.7} />
      </button>
    </div>
  );
}
