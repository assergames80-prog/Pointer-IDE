import { useState } from 'react';
import { Search, PanelLeft, PanelBottom, PanelRight, Settings } from 'lucide-react';
import Logo from './Logo.jsx';
import { Menu } from './Overlays.jsx';
import { useStore } from '../lib/store';
import { COMMANDS, runCommand } from '../lib/commands';
import { isMac, isWin, api } from '../lib/api';
import { basename } from '../lib/paths';

function cmd(id, label) {
  const c = COMMANDS.find((x) => x.id === id);
  return { label: label || c.title, keys: c.keys || c.keysLabel, onClick: () => c.run() };
}

export default function TitleBar({ minimal }) {
  const root = useStore((s) => s.root);
  const layout = useStore((s) => s.layout);
  const recent = useStore((s) => s.recent);
  const toggle = useStore((s) => s.toggle);
  const togglePanel = useStore((s) => s.togglePanel);
  const openOverlay = useStore((s) => s.openOverlay);
  const [open, setOpen] = useState(null);

  const menus = {
    File: [
      cmd('file.newFile'),
      cmd('file.newWindow'),
      { sep: true },
      cmd('file.openFile'),
      cmd('file.openFolder'),
      ...(recent.length
        ? [
            { header: 'Recent' },
            ...recent.slice(0, 6).map((p) => ({ label: basename(p), hint: p.length > 36 ? '…' + p.slice(-34) : p, onClick: () => useStore.getState().openFolder(p) })),
          ]
        : []),
      { sep: true },
      cmd('file.save'),
      cmd('file.saveAll'),
      { sep: true },
      cmd('app.settings', 'Settings'),
      { sep: true },
      cmd('file.closeEditor'),
      { ...cmd('file.closeFolder'), disabled: !root },
      { sep: true },
      cmd('app.quit'),
    ],
    Edit: [
      cmd('edit.undo'),
      cmd('edit.redo'),
      { sep: true },
      { label: 'Cut', keys: 'mod+x', onClick: () => document.execCommand('cut') },
      { label: 'Copy', keys: 'mod+c', onClick: () => document.execCommand('copy') },
      { label: 'Paste', keys: 'mod+v', onClick: () => document.execCommand('paste') },
      { sep: true },
      cmd('edit.find'),
      cmd('edit.replace'),
      cmd('view.search', 'Find in Files'),
      { sep: true },
      cmd('edit.commentLine'),
      cmd('edit.format'),
    ],
    View: [
      cmd('view.commandPalette'),
      cmd('view.quickOpen'),
      cmd('view.goToLine'),
      { sep: true },
      cmd('view.explorer', 'Explorer'),
      cmd('view.search', 'Search'),
      { sep: true },
      cmd('view.toggleSidebar'),
      cmd('view.toggleTerminal'),
      cmd('view.toggleChat'),
      { sep: true },
      cmd('view.toggleWordWrap'),
      cmd('view.toggleMinimap'),
      cmd('view.toggleTheme'),
      { sep: true },
      cmd('view.zoomIn'),
      cmd('view.zoomOut'),
      cmd('view.zoomReset'),
    ],
    AI: [cmd('ai.focusChat'), cmd('ai.newChat'), cmd('ai.addToChat'), cmd('ai.inlineEdit'), { sep: true }, cmd('ai.toggleAutocomplete'), cmd('ai.stop'), { sep: true }, { label: 'Models & API Keys…', onClick: () => openOverlay('settings', 'models') }],
    Terminal: [cmd('terminal.new'), cmd('terminal.kill'), cmd('view.toggleTerminal')],
    Help: [
      cmd('help.shortcuts'),
      { label: 'Get a Google API key', onClick: () => api.openExternal('https://aistudio.google.com/apikey') },
      { label: 'Get a Groq API key', onClick: () => api.openExternal('https://console.groq.com/keys') },
      { sep: true },
      cmd('help.reload'),
      cmd('help.devtools'),
      { sep: true },
      cmd('help.about'),
    ],
  };

  return (
    <div className={`titlebar ${isMac ? 'mac' : ''}`}>
      {!isMac && (
        <div className="logo no-drag">
          <Logo size={18} />
        </div>
      )}
      {!minimal && !isMac && (
        <div className="menus">
          {Object.keys(menus).map((name) => (
            <button
              key={name}
              className={`menu-btn ${open?.name === name ? 'open' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                if (open?.name === name) return setOpen(null);
                const r = e.currentTarget.getBoundingClientRect();
                setOpen({ name, x: r.left, y: r.bottom + 4 });
              }}
              onMouseEnter={(e) => {
                if (open && open.name !== name) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setOpen({ name, x: r.left, y: r.bottom + 4 });
                }
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {!minimal && (
        <button className="command-center" onClick={() => openOverlay('quickOpen', '')}>
          <Search size={13} />
          <span className="ellipsis">{root ? basename(root) : 'Pointer'}</span>
        </button>
      )}
      <div className="spacer" />
      {!minimal && (
        <div className="layout-btns">
          <button className={`icon-btn ${layout.sidebar ? 'active' : ''}`} title="Toggle Sidebar (Ctrl+B)" onClick={() => toggle('sidebar')}>
            <PanelLeft size={15} />
          </button>
          <button className={`icon-btn ${layout.panel ? 'active' : ''}`} title="Toggle Terminal (Ctrl+J)" onClick={() => togglePanel()}>
            <PanelBottom size={15} />
          </button>
          <button className={`icon-btn ${layout.chat ? 'active' : ''}`} title="Toggle AI Pane (Ctrl+Alt+B)" onClick={() => toggle('chat')}>
            <PanelRight size={15} />
          </button>
          <button className="icon-btn" title="Settings (Ctrl+,)" onClick={() => runCommand('app.settings')}>
            <Settings size={15} />
          </button>
        </div>
      )}
      {(isWin || !isMac) && <div className="overlay-space" />}
      {open && <Menu x={open.x} y={open.y} items={menus[open.name]} onClose={() => setOpen(null)} minWidth={240} />}
    </div>
  );
}
