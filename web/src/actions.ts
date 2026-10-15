// What the page asks the server to do, one function each, so the shape of every request lives in one place.

import type {
  Meta,
  QuestionAnswer,
  ReasoningLevel,
  Session,
  SettingsView,
} from '../../src/shared/types.ts';
import { api } from './api.ts';

export interface StartSession {
  question: string;
  /** What the asker added about the situation: its own field, read by the council right after the question. */
  context?: string;
  profileId: string;
  level: ReasoningLevel;
  /** The revision and settings fingerprint the page last had acknowledged (a mismatch is a 409). */
  revision: number;
  fingerprint: string;
  /** The working folder the members read in (an absolute path; the server checks it: 400 `bad_cwd`). */
  cwd?: string;
}

export const startSession = (body: StartSession) => api<Session>('/sessions', 'POST', body);

/** The result of trying the endpoint the way a client would. */
export type EndpointTest =
  | { ok: true; baseUrl: string; models: string[] }
  | {
      ok: false;
      baseUrl: string;
      code: string;
      params?: Record<string, string | number>;
      message: string;
    };

export const testEndpoint = () => api<EndpointTest>('/endpoint/test', 'POST', {});

/** What a round starts from: answers to the chairman's questions and a comment, or neither (the critique round). */
export interface RoundText {
  answers?: QuestionAnswer[];
  comment?: string;
}

export function startRound(
  sessionId: string,
  fromNodeId: string,
  input: RoundText | null,
  editedFrom?: string,
) {
  const answers = input?.answers?.filter((item) => item.answer.trim()) ?? [];
  return api<{ userId: string; chairId: string }>(`/sessions/${sessionId}/rounds`, 'POST', {
    fromNodeId,
    ...(answers.length > 0 ? { answers } : {}),
    // the comment alone is the older `text` form: the same round either way
    ...(input?.comment?.trim() ? { comment: input.comment.trim() } : {}),
    ...(editedFrom ? { editedFrom } : {}),
  });
}

/** «Stop waiting for the rest»: every member still working is left out; the chairman writes from those that answered. */
export const skipRest = (sessionId: string, chairId: string) =>
  api<{ skipped: number }>(`/sessions/${sessionId}/rounds/${chairId}/skip-rest`, 'POST', {});

export const cancelRound = (sessionId: string, chairId: string) =>
  api(`/sessions/${sessionId}/rounds/${chairId}/cancel`, 'POST', {});

export const rerunRound = (sessionId: string, chairId: string) =>
  api(`/sessions/${sessionId}/rounds/${chairId}/rerun`, 'POST', {});

/** «Stop waiting for this member»: the round goes on without it (the chairman still needs two valid answers). */
export const skipSeat = (sessionId: string, chairId: string, label: string) =>
  api(`/sessions/${sessionId}/rounds/${chairId}/skip`, 'POST', { label });

export const renameSession = (id: string, name: string) =>
  api(`/sessions/${id}`, 'PATCH', { name });

export const deleteSession = (id: string) => api(`/sessions/${id}`, 'DELETE');

export const loadMeta = () => api<Meta>('/meta');

export const detect = () => api<SettingsView>('/detect', 'POST', {});
