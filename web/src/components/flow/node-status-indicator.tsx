// React Flow UI's NodeStatusIndicator (xyflow, installed through the shadcn CLI): a running node gets a travelling border, a
// failed or stopped one an error border. Changed from the original: the colours are the theme's (state is the only colour on
// the map), the radius follows the node (`--node-radius`), the animation is a utility instead of an injected <style>, and
// under reduced motion the border holds still.

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type NodeStatus = 'loading' | 'success' | 'error' | 'initial';

export type NodeStatusIndicatorProps = {
  status?: NodeStatus | undefined;
  children: ReactNode;
};

const RADIUS = 'rounded-(--node-radius,9px)';

/** A 2 px ring around the node, `-1px` outside its own border. */
function StatusBorder({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <>
      <div
        data-status-border
        className={cn(
          'pointer-events-none absolute -start-px -top-px h-[calc(100%+2px)] w-[calc(100%+2px)] border-2',
          RADIUS,
          className,
        )}
      />
      {children}
    </>
  );
}

/** The border of a running node: a conic gradient turning behind the node (still, as a solid ring, under reduced motion). */
function BorderLoadingIndicator({ children }: { children: ReactNode }) {
  return (
    <>
      <div
        className="pointer-events-none absolute -start-px -top-px h-[calc(100%+2px)] w-[calc(100%+2px)]"
        data-status-border="loading"
      >
        <div className={cn('absolute inset-0 overflow-hidden', RADIUS)}>
          <div className="absolute start-1/2 top-1/2 aspect-square w-[140%] -translate-x-1/2 -translate-y-1/2 animate-[spin_2s_linear_infinite] rounded-full bg-[conic-gradient(from_0deg_at_50%_50%,var(--ring)_0deg,transparent_360deg)] motion-reduce:hidden" />
          <div
            className={cn(
              'absolute inset-0 hidden border-2 border-ring motion-reduce:block',
              RADIUS,
            )}
          />
        </div>
      </div>
      {children}
    </>
  );
}

export function NodeStatusIndicator({ status, children }: NodeStatusIndicatorProps) {
  switch (status) {
    case 'loading':
      return <BorderLoadingIndicator>{children}</BorderLoadingIndicator>;
    case 'success':
      return <StatusBorder className="border-emerald-600">{children}</StatusBorder>;
    case 'error':
      return <StatusBorder className="border-destructive">{children}</StatusBorder>;
    default:
      return <>{children}</>;
  }
}
