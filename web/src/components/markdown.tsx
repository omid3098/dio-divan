// Markdown without raw HTML, links or images (the security model): member and chairman text is data. Every block decides its
// own direction (RTL-6); lists take their direction from their text and use logical padding, so a marker never hangs outside
// the panel in either direction.

import type { ElementType, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { normalizeAnswer, textDirection } from '../../../src/shared/text.ts';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

const block =
  (Tag: ElementType, className: string) =>
  ({ children }: { children?: ReactNode }) => (
    <Tag dir={textDirection(textOf(children)) ?? undefined} className={className}>
      {children}
    </Tag>
  );

const list =
  (Tag: 'ul' | 'ol', marker: string) =>
  ({ children }: { children?: ReactNode }) => (
    <Tag dir={textDirection(textOf(children)) ?? undefined} className={cn('ps-6', marker)}>
      {children}
    </Tag>
  );

export function Markdown({
  text,
  answer = false,
  className,
}: {
  text: string;
  /** The chairman's answer: «۱. …» steps become a list and a new line is a line break. */
  answer?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col gap-3 text-[15px] leading-7 [&_*]:min-w-0', className)}
      data-md
    >
      <ReactMarkdown
        skipHtml
        urlTransform={() => ''}
        components={{
          p: block('p', 'text-pretty'),
          li: ({ children }) => (
            <li
              className="ps-1 marker:text-muted-foreground"
              dir={textDirection(textOf(children)) ?? undefined}
            >
              {children}
            </li>
          ),
          ul: list('ul', 'list-disc'),
          ol: list('ol', 'list-decimal'),
          h1: block('h3', 'mt-1 text-base font-semibold'),
          h2: block('h3', 'mt-1 text-base font-semibold'),
          h3: block('h4', 'mt-1 text-sm font-semibold'),
          h4: block('h4', 'mt-1 text-sm font-semibold'),
          h5: block('h4', 'mt-1 text-sm font-semibold'),
          h6: block('h4', 'mt-1 text-sm font-semibold'),
          blockquote: block('blockquote', 'border-s-2 ps-3 text-muted-foreground'),
          a: ({ children }) => <span>{children}</span>,
          img: () => null,
          code: ({ children }) => (
            <code dir="ltr" className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre dir="ltr" className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              {children}
            </pre>
          ),
        }}
      >
        {answer ? normalizeAnswer(text) : text}
      </ReactMarkdown>
    </div>
  );
}
