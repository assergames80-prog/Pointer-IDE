import { useRef, useState } from 'react';

/**
 * Drag handle. `onDrag(delta)` receives the pixel delta since drag start; the parent
 * clamps and applies it to its own size.
 */
export default function Splitter({ direction = 'v', onStart, onDrag, onEnd, onDoubleClick }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef(0);

  const onPointerDown = (e) => {
    e.preventDefault();
    start.current = direction === 'v' ? e.clientX : e.clientY;
    setDragging(true);
    onStart?.();
    document.body.classList.add('resizing');
    document.body.style.cursor = direction === 'v' ? 'col-resize' : 'row-resize';
    const move = (ev) => onDrag((direction === 'v' ? ev.clientX : ev.clientY) - start.current);
    const up = () => {
      setDragging(false);
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`${direction === 'v' ? 'splitter-v' : 'splitter-h'} ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
