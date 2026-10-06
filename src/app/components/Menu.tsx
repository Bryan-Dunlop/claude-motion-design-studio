// Shared dropdown menu for the toolbar ("+ Shape ▾", "File ▾", "More ▾"): a button that opens a list, which closes
// when an item is picked, on a pointerdown anywhere outside it, and on Escape.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * While `active`, call `onDismiss` on a pointerdown outside `ref` or on Escape. Escape is consumed (capture phase), so
 * it doesn't also clear the selection.
 */
export function useDismiss(active: boolean, ref: RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [active, ref, onDismiss]);
}

export function Menu({
  label,
  title,
  testId,
  className = '',
  children,
}: {
  label: ReactNode;
  title: string;
  testId?: string;
  className?: string;
  /** The items; call `close` after an item's action (MenuItem does it for you). */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div className={`menu ${className}`} ref={ref}>
      <button className={`menu-trigger ${open ? 'open' : ''}`} title={title} data-testid={testId} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu-list" role="menu" data-testid={testId ? `${testId}-list` : undefined} onClick={(e) => (e.target as HTMLElement).closest('[role=menuitem]') && close()}>
          {children}
        </div>
      )}
    </div>
  );
}

/** One menu entry; picking it closes the menu. */
export function MenuItem({ onClick, title, testId, disabled, children }: { onClick?: () => void; title: string; testId?: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} title={title} data-testid={testId} disabled={disabled}>
      {children}
    </button>
  );
}
