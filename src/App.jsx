import { useEffect, useRef } from 'react';
import { useStore, applyTheme } from './lib/store';
import { useChat } from './lib/chat';
import { api } from './lib/api';
import { installKeybindings } from './lib/commands';
import TitleBar from './components/TitleBar.jsx';
import ActivityBar from './components/ActivityBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import EditorArea from './components/EditorArea.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import QuickOpen from './components/QuickOpen.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import ShortcutsModal from './components/ShortcutsModal.jsx';
import { ContextMenu, Dialog, Toasts } from './components/Overlays.jsx';
import Splitter from './components/Splitter.jsx';

export default function App() {
  const ready = useStore((s) => s.ready);
  const layout = useStore((s) => s.layout);
  const overlay = useStore((s) => s.overlay);
  const setLayout = useStore((s) => s.setLayout);
  const startSize = useRef(0);

  useEffect(() => {
    let disposeKeys = () => {};
    (async () => {
      const [info, settings, keys, state, recent] = await Promise.all([
        api.info(),
        api.getSettings(),
        api.getKeys(),
        api.getState(),
        api.recent(),
      ]);
      applyTheme(settings.theme);
      useStore.setState({
        info,
        settings,
        keys,
        recent,
        layout: { ...useStore.getState().layout, ...(state.layout || {}), panel: false },
      });
      if (state.chatMode) useChat.setState({ mode: state.chatMode });
      disposeKeys = installKeybindings();
      useStore.getState().refreshModels();
      const folder = info.argvFolder || state.lastFolder;
      if (folder && (await api.exists(folder))) await useStore.getState().openFolder(folder);
      else {
        const { loadChatsForRoot } = await import('./lib/chat.js');
        await loadChatsForRoot(null);
      }
      useStore.setState({ ready: true });
      if (!keys.google.set && !keys.groq.set) useStore.getState().openOverlay('settings', 'models');
    })();
    return () => disposeKeys();
  }, []);

  // Prevent the window from navigating when files are dropped outside drop targets.
  useEffect(() => {
    const prevent = (e) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  if (!ready) {
    return (
      <div className="app">
        <TitleBar minimal />
        <div className="workbench" />
        <div className="statusbar" />
      </div>
    );
  }

  const maxSide = Math.max(240, window.innerWidth * 0.5);

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        {layout.sidebar && (
          <>
            <div className="sidebar" style={{ width: layout.sidebarWidth }}>
              <Sidebar />
            </div>
            <Splitter
              onStart={() => (startSize.current = layout.sidebarWidth)}
              onDrag={(d) => setLayout({ sidebarWidth: Math.min(maxSide, Math.max(170, startSize.current + d)) })}
            />
          </>
        )}
        <div className="center">
          <EditorArea />
          {layout.panel && (
            <>
              <Splitter
                direction="h"
                onStart={() => (startSize.current = layout.panelHeight)}
                onDrag={(d) => setLayout({ panelHeight: Math.min(window.innerHeight - 160, Math.max(90, startSize.current - d)) })}
              />
              <TerminalPanel />
            </>
          )}
        </div>
        {layout.chat && (
          <>
            <Splitter
              onStart={() => (startSize.current = layout.chatWidth)}
              onDrag={(d) => setLayout({ chatWidth: Math.min(window.innerWidth * 0.6, Math.max(300, startSize.current - d)) })}
            />
            <ChatPanel />
          </>
        )}
      </div>
      <StatusBar />
      {overlay === 'quickOpen' && <QuickOpen />}
      {overlay === 'settings' && <SettingsModal />}
      {overlay === 'shortcuts' && <ShortcutsModal />}
      <ContextMenu />
      <Dialog />
      <Toasts />
    </div>
  );
}
