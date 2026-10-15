// React Flow UI's BaseNode (xyflow, installed through the shadcn CLI), kept as it came except for what the page needs: the
// node's wrapper takes the keyboard focus (so the node itself is not a second tab stop) and shows a focus ring.

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function BaseNode({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'bg-card text-card-foreground relative rounded-md border',
        'hover:ring-1',
        // React Flow displays node elements inside of a `NodeWrapper` component, which compiles down to a div with the class
        // `react-flow__node`. When a node is selected, the class `selected` is added to it, and while it has the keyboard
        // focus (React Flow makes the wrapper focusable) it matches `:focus-visible`.
        'in-[.selected]:border-muted-foreground',
        'in-[.selected]:shadow-lg',
        'in-[.react-flow__node:focus-visible]:ring-3 in-[.react-flow__node:focus-visible]:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}

/** A consistent header layout intended to be used inside `<BaseNode />`. */
export function BaseNodeHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      {...props}
      className={cn(
        'mx-0 my-0 -mb-1 flex flex-row items-center justify-between gap-2 px-3 py-2',
        className,
      )}
    />
  );
}

/** The title text of the node. To keep a native application feel it is not selectable. */
export function BaseNodeHeaderTitle({ className, ...props }: ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="base-node-title"
      className={cn('user-select-none flex-1 font-semibold', className)}
      {...props}
    />
  );
}

export function BaseNodeContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="base-node-content"
      className={cn('flex flex-col gap-y-2 p-3', className)}
      {...props}
    />
  );
}

export function BaseNodeFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="base-node-footer"
      className={cn('flex flex-col items-center gap-y-2 border-t px-3 pb-3 pt-2', className)}
      {...props}
    />
  );
}
