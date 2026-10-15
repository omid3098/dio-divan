// The one sentence of an Agent Client Protocol client that both sides of Divan's bridge must spell the same: the bridge
// (`src/server/acp.ts`) and the server's mapping of a client's threads (`src/server/threads.ts`).

/** What T3 Code sends, word for word, when the user presses "continue" after a run that was interrupted or cancelled. */
export const CONTINUE_TEXT = 'Continue where you left off.';
