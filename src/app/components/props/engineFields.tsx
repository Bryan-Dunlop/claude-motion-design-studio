// Extra Properties-panel controls used by the rendering-engine sections (effects, transitions, text animation, shapes).
// Fields.tsx and props/common.tsx stay the shared basics.
import type { ReactNode } from 'react';

/** A checkbox on the Properties grid ("☐ Drop shadow"). */
export function CheckRow({ label, tip, checked, onChange, testId }: { label: string; tip: string; checked: boolean; onChange: (on: boolean) => void; testId: string }) {
  return (
    <div className="row check-row" title={tip}>
      <span className="row-kf" />
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
        {label}
      </label>
    </div>
  );
}

/** A read-only line of information in a section ("From: Hook"). */
export function InfoLine({ children, tip, testId }: { children: ReactNode; tip: string; testId: string }) {
  return (
    <p className="info-line" title={tip} data-testid={testId}>
      {children}
    </p>
  );
}

/** Seconds for display: at most two decimals, no trailing zeros (0.6, 1.25, 2). */
export const secs = (v: number) => String(Number(v.toFixed(2)));
