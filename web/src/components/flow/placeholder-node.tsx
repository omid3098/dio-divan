// React Flow UI's PlaceholderNode (xyflow, installed through the shadcn CLI): the dashed ghost of the node that comes next.
// Changed from the original: a click calls `onClick` (the page puts the cursor in the composer) instead of turning the node
// into another one, and the colours are the theme's.

import { Handle, Position } from '@xyflow/react';
import type { ReactNode } from 'react';

import { BaseNode } from '@/components/flow/base-node';
import { cn } from '@/lib/utils';

export function PlaceholderNode({
  children,
  onClick,
  className,
  source = Position.Bottom,
  target = Position.Top,
}: {
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
  source?: Position;
  target?: Position;
}) {
  return (
    <BaseNode
      className={cn(
        'bg-card/60 border-dashed border-muted-foreground/50 p-2 text-center text-muted-foreground shadow-none',
        className,
      )}
      onClick={onClick}
    >
      {children}
      <Handle
        type="target"
        style={{ visibility: 'hidden' }}
        position={target}
        isConnectable={false}
      />
      <Handle
        type="source"
        style={{ visibility: 'hidden' }}
        position={source}
        isConnectable={false}
      />
    </BaseNode>
  );
}
