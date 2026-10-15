// Numbers, durations and the small sentences about a member or a round, in the language in force. Latin digits in both
// languages (Dio Docs RTL-14). Persian wording that tests pin (`web/src/fa.ts`) is delegated to that module; English is
// written here.

import { useMemo } from 'react';
import {
  classifyFailure,
  type FailureKind,
  SKIPPED_BY_USER,
  SKIPPED_SAME_FAMILY,
} from '../../../src/shared/failure.ts';
import type { ChairNode, ClaimStatus, SeatState } from '../../../src/shared/types.ts';
import * as legacy from '../fa.ts';
import { type I18n, type Key, type Lang, useI18n } from './index.tsx';
import { noteText } from './notes.tsx';

/** What of a failed round the lines below read: the text, and the same as a code the server worded. */
type RoundFailure = Pick<ChairNode, 'error' | 'errorNote'>;

const number = new Intl.NumberFormat('en-US');
const faCompact = new Intl.NumberFormat('fa-u-nu-latn', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** 12,345 for a table, 12.3k for a tight place. */
export const num = (value: number): string => number.format(Math.round(value));
export const compact = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/u, '')}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/u, '')}k`
      : String(Math.round(value));

/** «MM:SS» for an elapsed time. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const EN_WHY: Record<FailureKind, string> = {
  credit: 'its model is out of credit',
  rate: 'its model is rate limited',
  timeout: 'it showed no sign of work for 10 minutes',
  invalid: 'its output did not have the form that was asked for',
  cancelled: 'the round was cancelled',
  skipped: 'its model had been set aside',
  other: 'its run failed',
};

export interface Format {
  lang: Lang;
  num: (value: number) => string;
  /** 12.3k for a tight place (the token meter, a table of figures): Latin in both languages. */
  compact: (value: number) => string;
  /** The same in running text and chips: «12.3k» in English, «12.3 هزار» in Persian (Latin digits). */
  compactText: (value: number) => string;
  clock: (ms: number) => string;
  /** «4 min 1 s», «37 s», «399 ms». */
  duration: (ms: number) => string;
  /** «3 minutes ago», from an ISO time. */
  ago: (iso: string) => string;
  /** The word for a member's state («Done», «Working…»). */
  seatState: (state: SeatState, error: string | null) => string;
  /** One plain line on a member's card for a member that did not answer. */
  failureLine: (state: SeatState, error: string | null) => string;
  /** The notice at the top of a round about one member: its verb and its reason. */
  missingLine: (state: SeatState, error: string | null) => { verb: string; why: string };
  /** What a failed round says without the identity; null when there is nothing to add. */
  roundFailureLine: (round: RoundFailure) => string | null;
  /** Whether a failed round has a technical text of its own to show behind the "details" fold. */
  roundHasDetail: (round: RoundFailure) => boolean;
  /** What a round usually takes: the text, and the upper bound in seconds. */
  typical: (min: number, max: number, count: number) => { text: string; upper: number };
  claimWord: (status: ClaimStatus) => string;
}

/**
 * The one plain line of a failed round that the server gave a code (every round since the server words nothing itself): the
 * engine's own sentences are said by their code, and what a harness said about the chairman's call is told by its kind.
 * Null: the round has no code (an older one), or there is nothing to add.
 */
function codedRoundLine(round: RoundFailure, t: I18n['t']): string | null | undefined {
  const coded = round.errorNote;
  if (!coded) return undefined;
  switch (coded.code) {
    case 'few_members':
    case 'few_members_skipped':
      return noteText(coded);
    case 'chairman_invalid':
      return t('why.chairmanInvalid');
    case 'round_save_failed':
      return t('why.roundNotSaved');
    case 'chairman_failed':
      switch (classifyFailure('failed', String(coded.params?.detail ?? ''))) {
        case 'timeout':
          return t('why.chairmanTimeout');
        case 'credit':
          return t('why.chairmanCredit');
        case 'rate':
          return t('why.chairmanRate');
        default:
          return t('why.chairmanFailed');
      }
    default:
      return null;
  }
}

function makeFormat({ lang, t }: Pick<I18n, 'lang' | 't'>): Format {
  const relative = new Intl.RelativeTimeFormat(lang, {
    numeric: 'auto',
    numberingSystem: 'latn',
  } as Intl.RelativeTimeFormatOptions);
  const duration = (ms: number): string => {
    if (ms < 1000) return t('unit.ms', { n: Math.round(ms) });
    const total = Math.round(ms / 1000);
    if (total < 60) return t('unit.s', { n: ms < 10_000 ? (ms / 1000).toFixed(1) : total });
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes < 60) {
      return rest === 0
        ? t('unit.min', { n: minutes })
        : `${t('unit.min', { n: minutes })} ${t('unit.s', { n: rest })}`;
    }
    const hours = Math.floor(minutes / 60);
    return `${t('unit.h', { n: hours })} ${t('unit.min', { n: minutes % 60 })}`;
  };
  const ago = (iso: string): string => {
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return relative.format(Math.round(diff), 'second');
    if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
    if (abs < 86_400) return relative.format(Math.round(diff / 3600), 'hour');
    return relative.format(Math.round(diff / 86_400), 'day');
  };
  const roundHasDetail = (round: RoundFailure): boolean =>
    round.errorNote
      ? ['chairman_failed', 'chairman_invalid', 'round_save_failed'].includes(round.errorNote.code)
      : Boolean(round.error) && round.error !== 'cancelled';
  const compactText =
    lang === 'fa' ? (value: number) => faCompact.format(Math.round(value)) : compact;
  const base = { lang, num, compact, compactText, clock, duration, ago, roundHasDetail };

  if (lang === 'fa') {
    // what the tested Persian wording (`fa.ts`) does not cover: a member the asker stopped waiting for, and the idle stop
    // (a member is stopped only after 10 minutes without a sign of work; there is no fixed deadline any more)
    return {
      ...base,
      seatState: (state, error) =>
        state === 'timeout' ? t('seat.state.timeout') : legacy.seatStateWord(state, error),
      failureLine: (state, error) =>
        error === SKIPPED_BY_USER
          ? t('why.byUserLong')
          : classifyFailure(state, error) === 'timeout'
            ? t('why.timeoutLong')
            : legacy.failureLine(state, error),
      missingLine: (state, error) =>
        error === SKIPPED_BY_USER
          ? { verb: t('why.verbSkipped'), why: t('why.byUser') }
          : classifyFailure(state, error) === 'timeout'
            ? { verb: t('why.verbNone'), why: t('why.timeout') }
            : legacy.missingLine(state, error),
      roundFailureLine: (round) =>
        codedRoundLine(round, t) ?? (round.errorNote ? null : legacy.roundFailureLine(round.error)),
      typical: legacy.typicalDuration,
      claimWord: (status) => legacy.CLAIM_WORD[status],
    };
  }

  const seatState = (state: SeatState, error: string | null): string =>
    state === 'failed' && error === 'cancelled'
      ? t('seat.cancelled')
      : t(`seat.state.${state}` as Key);
  const missingLine = (state: SeatState, error: string | null) => {
    const kind = classifyFailure(state, error);
    if (error === SKIPPED_BY_USER)
      return { verb: 'did not take part this round', why: 'you stopped waiting for it' };
    if (kind === 'skipped') {
      return {
        verb: 'did not take part this round',
        why:
          error === SKIPPED_SAME_FAMILY
            ? 'it is of the chairman’s family'
            : (error ?? '').includes('rate')
              ? EN_WHY.rate
              : EN_WHY.credit,
      };
    }
    return { verb: 'did not answer', why: EN_WHY[kind] };
  };
  const failureLine = (state: SeatState, error: string | null): string => {
    const kind = classifyFailure(state, error);
    if (error === SKIPPED_BY_USER)
      return 'You stopped waiting for this member; it did not take part';
    if (kind === 'skipped' && error === SKIPPED_SAME_FAMILY) {
      return 'Same family as the chairman; it did not take part this round';
    }
    if (kind === 'skipped') {
      return (error ?? '').includes('rate')
        ? 'Its model was rate limited; it was not asked'
        : 'Its model was out of credit; it was not asked';
    }
    return EN_WHY[kind].replace(/^./u, (first) => first.toUpperCase());
  };
  const roundFailureLine = (round: RoundFailure): string | null => {
    const coded = codedRoundLine(round, t);
    if (coded !== undefined) return coded;
    // a round saved before the server gave codes carries Persian text of its own
    const text = round.error ?? '';
    if (!text || text === 'cancelled') return null;
    if (text.startsWith('کمتر از دو عضو')) return 'Fewer than two members returned a valid answer.';
    if (text.startsWith('خروجی رئیس معتبر نبود')) {
      return 'The chairman’s output did not have the form that was asked for.';
    }
    if (text.startsWith('رئیس ناموفق بود')) {
      switch (classifyFailure('failed', text.replace(/^رئیس ناموفق بود:\s*/u, ''))) {
        case 'timeout':
          return t('why.chairmanTimeout');
        case 'credit':
          return 'The chairman’s model is out of credit.';
        case 'rate':
          return 'The chairman’s model is rate limited.';
        default:
          return 'The chairman’s run failed.';
      }
    }
    return null;
  };
  const typical = (min: number, max: number, count: number): { text: string; upper: number } => {
    const about = (seconds: number) =>
      seconds < 90
        ? `about ${Math.max(10, Math.round(seconds / 10) * 10)} s`
        : `about ${Math.round(seconds / 60)} min`;
    if (count < 2) return { text: about(min), upper: Math.max(min, 10) * 1.5 };
    if (max < 150) {
      const step = max < 60 ? 5 : 10;
      const low = Math.max(step, Math.floor(min / step) * step);
      const high = Math.max(low + step, Math.ceil(max / step) * step);
      return { text: `${low} to ${high} s`, upper: high };
    }
    const high = Math.max(2, Math.ceil(max / 60));
    if (min < 60) {
      return { text: `${Math.max(5, Math.floor(min / 5) * 5)} s to ${high} min`, upper: high * 60 };
    }
    return { text: `${Math.min(Math.floor(min / 60), high - 1)} to ${high} min`, upper: high * 60 };
  };
  return {
    ...base,
    seatState,
    failureLine,
    missingLine,
    roundFailureLine,
    typical,
    claimWord: (status) => t(`claim.${status}` as Key),
  };
}

export function useFormat(): Format {
  const { lang, t } = useI18n();
  return useMemo(() => makeFormat({ lang, t }), [lang, t]);
}
