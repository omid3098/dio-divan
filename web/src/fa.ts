// Interface text (Persian) and number/time formatting. Latin digits in the interface chrome (Dio Docs RTL-14);
// Persian quotes and punctuation (RTL-19); sentence-style labels, a verb first on buttons (VOI-5).

import {
  classifyFailure,
  type FailureKind,
  SKIPPED_SAME_FAMILY,
} from '../../src/shared/failure.ts';
import type { ClaimStatus, SeatState } from '../../src/shared/types.ts';

const number = new Intl.NumberFormat('en-US');
export const fmt = (value: number): string => number.format(Math.round(value));

/** 12,345 → "12.3k" for tight places. */
export const compact = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(Math.round(value));

/** «399 میلی‌ثانیه», «6.2 ثانیه», «37 ثانیه»: Persian units, Latin digits (Dio Docs RTL-14). */
export function seconds(ms: number): string {
  return ms < 1000
    ? `${Math.round(ms)} میلی‌ثانیه`
    : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} ثانیه`;
}

const relative = new Intl.RelativeTimeFormat('fa', {
  numeric: 'auto',
  numberingSystem: 'latn',
} as Intl.RelativeTimeFormatOptions);
export function ago(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return relative.format(Math.round(diff), 'second');
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(diff / 3600), 'hour');
  return relative.format(Math.round(diff / 86_400), 'day');
}

export const SEAT_STATE: Record<SeatState, string> = {
  pending: 'در صف',
  running: 'در حال اجرا…',
  done: 'انجام شد',
  failed: 'ناموفق',
  timeout: 'زمان پاسخ تمام شد',
  invalid: 'خروجی نامعتبر',
  skipped: 'شرکت نکرد',
  blocked: 'پیش‌نیاز آماده نیست',
};

/** The state word of a member: a call that was cut short by «لغو دور» says so; the rest is `SEAT_STATE`. */
export const seatStateWord = (state: SeatState, error: string | null): string =>
  state === 'failed' && error === 'cancelled' ? 'لغو شد' : SEAT_STATE[state];

/** Why a member did not take part, as the end of a sentence about its model («اعتبار مدلش تمام شده»). */
const WHY: Record<FailureKind, string> = {
  credit: 'اعتبار مدلش تمام شده',
  rate: 'مدلش محدودیت سرعت دارد',
  timeout: '10 دقیقه هیچ نشانه‌ای از کار نداد و متوقف شد',
  invalid: 'خروجی‌اش قالب خواسته‌شده را نداشت',
  cancelled: 'دور لغو شد',
  skipped: 'مدلش کنار گذاشته شده بود',
  other: 'اجرایش ناموفق بود',
};

/** Whether a skipped member was left out for a rate limit (a short pause) or for credit (a long one). */
const skippedForRate = (error: string | null): boolean => (error ?? '').includes('rate');

/**
 * One plain line on a member's card for a member that did not answer, whatever the harness said (the raw text stays behind
 * a "details" fold, with the identity). `error` is the seat's own error text.
 */
export function failureLine(state: SeatState, error: string | null): string {
  const kind = classifyFailure(state, error);
  if (kind === 'skipped' && error === SKIPPED_SAME_FAMILY) {
    return 'این عضو هم‌خانوادهٔ رئیس است؛ این دور شرکت نکرد';
  }
  if (kind === 'skipped') {
    return skippedForRate(error)
      ? 'مدلش محدودیت سرعت داشت؛ از آن پرسیده نشد'
      : 'اعتبار مدلش تمام شده بود؛ از آن پرسیده نشد';
  }
  return WHY[kind];
}

/**
 * What the notice at the top of the panel says about one member that is missing: one sentence in two parts, the verb and
 * the reason («عضو B این دور شرکت نکرد» + «اعتبار مدلش تمام شده»). A member that was left out is not one that failed.
 */
export function missingLine(state: SeatState, error: string | null): { verb: string; why: string } {
  const kind = classifyFailure(state, error);
  if (kind === 'skipped') {
    return {
      verb: 'این دور شرکت نکرد',
      why:
        error === SKIPPED_SAME_FAMILY
          ? 'هم‌خانوادهٔ رئیس است'
          : skippedForRate(error)
            ? WHY.rate
            : WHY.credit,
    };
  }
  return { verb: 'پاسخ نداد', why: WHY[kind] };
}

/**
 * What a round that failed says in one plain line, without the identity: the engine's own sentences are kept, and what a
 * harness said about the chairman's call is told by its kind. The raw text waits for the reveal. Null: nothing to add.
 */
export function roundFailureLine(error: string | null): string | null {
  const text = error ?? '';
  if (!text || text === 'cancelled') return null;
  if (text.startsWith('کمتر از دو عضو')) return text;
  if (text.startsWith('خروجی رئیس معتبر نبود')) return 'خروجی رئیس قالب خواسته‌شده را نداشت.';
  if (text.startsWith('رئیس ناموفق بود')) {
    switch (classifyFailure('failed', text.replace(/^رئیس ناموفق بود:\s*/u, ''))) {
      case 'timeout':
        return 'رئیس 10 دقیقه هیچ نشانه‌ای از کار نداد و متوقف شد.';
      case 'credit':
        return 'اعتبار مدل رئیس تمام شده.';
      case 'rate':
        return 'مدل رئیس محدودیت سرعت دارد.';
      default:
        return 'اجرای رئیس ناموفق بود.';
    }
  }
  return null;
}

/** A member's text with the markdown marks taken out (a preview line is plain text, not a rendered page). */
export const plainText = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/__(.+?)__/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^\s*#{1,6}\s+/gmu, '');

/** What the cut a member's answer got means, in one plain line. */
export const TRIMMED_LINE = 'کوتاه شد تا در سقف بماند';

/** «MM:SS» for an elapsed time, Latin digits. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * What a round usually takes, from the shortest and the longest that were measured: «40 تا 90 ثانیه», always a range when
 * there are two measurements or more (a round with a comment, or deeper in the tree, takes longer than the first). «حدود 40
 * ثانیه» is for a single measurement only. `upper` is the longest the text allows, in seconds: past it a round has taken
 * longer than usual.
 */
export function typicalDuration(
  min: number,
  max: number,
  count: number,
): { text: string; upper: number } {
  if (count < 2) return { text: aboutDuration(min), upper: Math.max(min, 10) * 1.5 };
  if (max < 150) {
    const step = max < 60 ? 5 : 10;
    const low = Math.max(step, Math.floor(min / step) * step);
    const high = Math.max(low + step, Math.ceil(max / step) * step);
    return { text: `${low} تا ${high} ثانیه`, upper: high };
  }
  const high = Math.max(2, Math.ceil(max / 60));
  if (min < 60) {
    return {
      text: `${Math.max(5, Math.floor(min / 5) * 5)} ثانیه تا ${high} دقیقه`,
      upper: high * 60,
    };
  }
  return { text: `${Math.min(Math.floor(min / 60), high - 1)} تا ${high} دقیقه`, upper: high * 60 };
}

/** What the waiting round says about the time: the usual range, or that it has already taken longer. */
export const OVERDUE = 'بیشتر از معمول طول کشید';

/** «حدود 2 دقیقه» for a duration in seconds (exact digits, VOI-9). */
export function aboutDuration(seconds: number): string {
  if (seconds < 90) return `حدود ${Math.max(10, Math.round(seconds / 10) * 10)} ثانیه`;
  return `حدود ${Math.round(seconds / 60)} دقیقه`;
}

export const CLAIM_MARK: Record<ClaimStatus, string> = { accepted: '✓', rejected: '✕', open: '؟' };
export const CLAIM_WORD: Record<ClaimStatus, string> = {
  accepted: 'پذیرفته',
  rejected: 'ردشده',
  open: 'باز',
};

/** What the interface calls a harness (the program that runs a model): an assistant. */
export const HARNESS_NOUN = 'دستیار';

export const HARNESS_LABEL: Record<string, string> = {
  hermes: 'Hermes',
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'agy',
  grok: 'Grok',
  pi: 'Pi',
};

/** Pi is the chairman and has no seat among the members (switched off or not there), whatever the reason. */
export const piOnlyChairs = (
  chairman: { harness: string },
  seats: readonly { harness: string; enabled?: boolean }[],
): boolean =>
  chairman.harness === 'pi' &&
  !seats.some((seat) => seat.harness === 'pi' && seat.enabled !== false);
