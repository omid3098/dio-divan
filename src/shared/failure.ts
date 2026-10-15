// What a failed member (or chairman) call means, in a few kinds. The engine decides from it how long a model stays out;
// the web app says it in one plain line («اعتبار این مدل تمام شده») and keeps the raw text behind a "details" fold.

/** The account behind a provider is out of credit or quota. */
export const ACCOUNT_OUT =
  /\b402\b|insufficient (?:balance|quota|credit|funds)|credit balance|no resource package|payment required|billing|quota (?:exceeded|exhausted)/iu;
/** A plain rate limit. */
export const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|resource_exhausted/iu;

/** A transient connection or provider failure; credit and rate errors take precedence. */
export const CONNECTION_FAILURE =
  /connection (?:closed|reset|refused)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|APIConnectionError|\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:[_ ]code)?|error(?:[_ ]code)?)["']?\s*[:=]?\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service (?:temporarily )?unavailable|gateway timeout)\b|overloaded/iu;

/** The error of a seat that was left out of a round because it is of the chairman's family (a `quick` session keeps them apart). */
export const SKIPPED_SAME_FAMILY = 'skipped: same family as the chairman';

/** The error of a seat the asker stopped waiting for («منتظرش نمی‌مانم»): left out of the round, what it cost counted. */
export const SKIPPED_BY_USER = 'skipped: stopped waiting';

export type FailureKind =
  | 'credit' // the account is out of credit or quota
  | 'rate' // rate limited
  | 'timeout'
  | 'invalid' // it answered, but not in a usable form
  | 'cancelled'
  | 'skipped' // not asked: its model was known to be out
  | 'other';

/** The kind of a failed call, from its seat state and the error text the harness gave. */
export function classifyFailure(state: string, error: string | null): FailureKind {
  const text = error ?? '';
  if (state === 'skipped') return 'skipped';
  if (state === 'timeout' || text === 'timeout') return 'timeout';
  if (state === 'invalid') return 'invalid';
  if (text === 'cancelled') return 'cancelled';
  if (ACCOUNT_OUT.test(text)) return 'credit';
  if (RATE_LIMIT.test(text)) return 'rate';
  return 'other';
}
