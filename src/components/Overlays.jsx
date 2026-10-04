import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useStore } from '../lib/store';
import { formatKeys } from '../lib/commands';

/** Generic dropdown/context menu. items: [{ label, onClick, keys, icon, danger, disabled } | { sep: true } | { header }] */
export function Menu({ x, y, items, onClose, minWidth }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y });
  const [focus, setFocus] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - r.width - 6);
    if (ny + r.height > window.innerHeight - 6) ny = Math.max(6, y - r.height);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const actionable = items.map((it, i) => (it.sep || it.header || it.disabled ? -1 : i)).filter((i) => i >= 0);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = actionable.indexOf(focus);
        const next = e.key === 'ArrowDown' ? actionable[(cur + 1) % actionable.length] : actionable[(cur - 1 + actionable.length) % actionable.length];
        setFocus(next ?? -1);
      } else if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault();
        const it = items[focus];
        onClose();
        it.onClick?.();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [items, focus, onClose]);

  return (
    <div className="dropdown" ref={ref} style={{ left: pos.x, top: pos.y, minWidth }}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} className="sep" />;
        if (it.header) return <div key={i} className="label">{it.header}</div>;
        const Icon = it.icon;
        return (
          <div
            key={i}
            className={`item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''} ${focus === i ? 'focused' : ''}`}
            onMouseEnter={() => setFocus(i)}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            {Icon && <Icon size={14} />}
            <span className="ellipsis">{it.label}</span>
            {(it.keys || it.hint) && <span className="kbd-hint">{it.hint || formatKeys(it.keys)}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const hide = useStore((s) => s.hideContextMenu);
  if (!menu) return null;
  return <Menu x={menu.x} y={menu.y} items={menu.items} onClose={hide} />;
}

export function Dialog() {
  const dialog = useStore((s) => s.dialog);
  const close = useStore((s) => s.closeDialog);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.value || '');
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        if (dialog.select && dialog.value) {
          const dot = dialog.value.lastIndexOf('.');
          el.setSelectionRange(0, dot > 0 ? dot : dialog.value.length);
        } else el.select();
      }, 10);
    }
  }, [dialog]);

  if (!dialog) return null;
  const cancel = () => close(dialog.kind === 'prompt' ? null : false);
  const ok = () => close(dialog.kind === 'prompt' ? value.trim() || null : true);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className="modal dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter') {
            e.preventDefault();
            ok();
          }
        }}
      >
        <div className="modal-head">{dialog.title}</div>
        <div className="modal-body">
          {dialog.message && <div>{dialog.message}</div>}
          {dialog.kind === 'prompt' && (
            <input ref={inputRef} className="input" value={value} placeholder={dialog.placeholder} onChange={(e) => setValue(e.target.value)} />
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} onClick={ok} autoFocus={dialog.kind === 'confirm'}>
            {dialog.confirmLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const Icon = t.kind === 'error' ? XCircle : t.kind === 'success' ? CheckCircle2 : t.kind === 'warning' ? AlertTriangle : Info;
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>{t.message}</div>
            <button className="icon-btn sm" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
