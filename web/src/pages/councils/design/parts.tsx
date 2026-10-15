// Small parts the panels of the inspector share.

import type { ReactNode } from 'react';

/** A label and its control, in two columns. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{children}</h3>
      {aside}
    </div>
  );
}

/** A name inside a sentence, in the quotation marks of the language («» in Persian). */
export const quoted = (text: string, lang: string): string =>
  lang === 'fa' ? `«${text}»` : `“${text}”`;
