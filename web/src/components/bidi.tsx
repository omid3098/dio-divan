// Direction of content, block by block (Dio Docs RTL-6): any Persian letter makes a block right to left, Latin only makes it
// left to right, nothing readable leaves it to its parent. The shell never flips for its content; machine values (ids,
// keys, model names) stay left to right in mono (RTL-17), inline ones in `bdi` (RTL-7).

import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import { useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import { textDirection } from '../../../src/shared/text.ts';

/** A block whose direction follows its own text. */
export function Bidi<T extends ElementType = 'p'>({
  as,
  text,
  children,
  ...rest
}: { as?: T; text: string; children?: ReactNode } & Omit<
  ComponentPropsWithoutRef<T>,
  'dir' | 'as'
>) {
  const Tag = (as ?? 'p') as ElementType;
  const dir = textDirection(text);
  return (
    <Tag dir={dir ?? undefined} {...rest}>
      {children ?? text}
    </Tag>
  );
}

/**
 * A title in a list (the sidebar, Continue, All sessions): its words run in the title's own direction, so a Latin title in a
 * Persian list is cut at ITS end («Should the first release inc…»), but it sits at the start of the shell, so the column of
 * titles lines up whichever language each one is in. Reading content (the answer, claims) keeps per-block alignment instead.
 */
export function ListText({
  text,
  className,
  ...rest
}: { text: string; className?: string } & Omit<
  ComponentPropsWithoutRef<'span'>,
  'dir' | 'className' | 'children'
>) {
  const { dir } = useI18n();
  return (
    <span
      dir={textDirection(text) ?? dir}
      // the line is cut at its own end; a short one is placed at the shell's start (physical, since the box has its own direction)
      style={{ textAlign: dir === 'rtl' ? 'right' : 'left' }}
      className={cn('block min-w-0 truncate', className)}
      {...rest}
    >
      {text}
    </span>
  );
}

/** A confidence 0 to 1 as a percentage that keeps its shape in a right-to-left line. */
export function Pct({ value }: { value: number }) {
  return <bdi dir="ltr">{Math.round(value * 100)}%</bdi>;
}

/** A machine value (id, path, model name): left to right, mono, never translated, never broken at a hyphen. */
export function Mono({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & Omit<
  ComponentPropsWithoutRef<'bdi'>,
  'dir' | 'className'
>) {
  return (
    <bdi
      dir="ltr"
      translate="no"
      className={cn('font-mono text-[0.92em] whitespace-nowrap', className)}
      {...rest}
    >
      {children}
    </bdi>
  );
}

/** An inline left-to-right run inside a sentence (a shortcut, a number with a unit). */
export function Ltr({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}

const OPEN = String.fromCharCode(0x2066);
const CLOSE = String.fromCharCode(0x2069);
const ISLAND = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, 'u');

/**
 * A note written on the server, whose machine values (a model, a provider, an assistant's name) come wrapped in isolates
 * (U+2066 .. U+2069): each is set as a left-to-right island of its own, so «litellm/zai» keeps its shape in the sentence.
 */
export function NoteText({ text }: { text: string }) {
  let offset = 0;
  return (
    <>
      {text.split(ISLAND).map((part, index) => {
        const key = `${offset}:${part}`;
        offset += part.length + 1;
        return index % 2 === 1 ? (
          <bdi key={key} dir="ltr">
            {part}
          </bdi>
        ) : (
          part
        );
      })}
    </>
  );
}
