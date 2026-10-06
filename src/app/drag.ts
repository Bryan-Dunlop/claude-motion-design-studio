// Pointer-drag helper. Wraps a drag in one history gesture (one drag = one undo step).
import type React from 'react';
import { useEditor } from './store';

export interface DragHandlers {
  onMove: (dx: number, dy: number, e: PointerEvent) => void;
  onEnd?: (moved: boolean) => void;
  /** Runs before the gesture ends: last edits that belong to the same undo step (e.g. tidying up after a drop). */
  beforeEnd?: (moved: boolean) => void;
  /** Pixels before the drag starts counting (avoids accidental moves on click). */
  threshold?: number;
  history?: boolean;
}

export function startDrag(e: React.PointerEvent | PointerEvent, h: DragHandlers) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  const threshold = h.threshold ?? 2;
  const useHistory = h.history !== false;
  let moved = false;
  if (useHistory) useEditor.getState().beginGesture();
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    moved = true;
    h.onMove(dx, dy, ev);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    h.beforeEnd?.(moved);
    if (useHistory) useEditor.getState().endGesture();
    h.onEnd?.(moved);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
