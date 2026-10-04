import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../lib/store';
import { COMMANDS, formatKeys } from '../lib/commands';

export default function ShortcutsModal() {
  const close = useStore((s) => s.closeOverlay);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const extra = [
    { title: 'Accept AI autocomplete', category: 'AI', keys: 'tab' },
    { title: 'Accept inline edit', category: 'AI', keys: 'mod+enter' },
    { title: 'Reject inline edit', category: 'AI', keys: 'escape' },
  ];
  const list = [...COMMANDS.filter((c) => c.keys || c.keysLabel), ...extra];
  const groups = {};
  for (const c of list) (groups[c.category] ||= []).push(c);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(640px, 92vw)' }}>
        <div className="modal-head">
          <span className="spacer">Keyboard Shortcuts</span>
          <button className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {Object.entries(groups).map(([cat, items]) => (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                {cat}
              </div>
              <div className="shortcut-grid" style={{ gridTemplateColumns: '1fr auto' }}>
                {items.map((c) => (
                  <div key={c.title} style={{ display: 'contents' }}>
                    <span style={{ color: 'var(--text)' }}>{c.title}</span>
                    <span>
                      <kbd>{formatKeys(c.keys || c.keysLabel)}</kbd>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
