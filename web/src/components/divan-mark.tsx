// Divan's mark, the seal: five members, each one half of a yin and yang, turn round the chairman's disc. Drawn in the
// theme's glow colours so it follows light and dark; below 32 px the small cut keeps the gaps open.

import { useId } from 'react';
import { MARK, MARK_SMALL } from '@/components/divan-mark-paths';

export function DivanMark({ size = 22, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/gu, '');
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none' }}
    >
      <defs>
        <linearGradient
          id={`g${id}`}
          gradientUnits="userSpaceOnUse"
          x1="164"
          y1="20"
          x2="92"
          y2="236"
        >
          <stop offset="0" style={{ stopColor: 'var(--glow-start)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--glow-mid)' }} />
          <stop offset="1" style={{ stopColor: 'var(--glow-end)' }} />
        </linearGradient>
      </defs>
      <path fill={`url(#g${id})`} d={size < 32 ? MARK_SMALL : MARK} />
    </svg>
  );
}
