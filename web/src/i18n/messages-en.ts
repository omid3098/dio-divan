// English text of the server's messages: the server's own English templates (`src/shared/messages.ts`), keyed `msg.<code>`
// so that one catalogue lookup words a note in either language.

import { MESSAGES, type MessageCode } from '../../../src/shared/messages.ts';

type Table = { [C in MessageCode as `msg.${C}`]: string };

export const messagesEn = Object.fromEntries(
  Object.entries(MESSAGES).map(([code, text]) => [`msg.${code}`, text]),
) as Table;
