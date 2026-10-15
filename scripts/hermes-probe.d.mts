export const FIX12_SHA256: string;
export function withProbeSlot<T>(
  ledger: string,
  archiveHash: string,
  launch: (counter: { url: string; token: string; evidence?: boolean }) => Promise<T>,
  options?: { stage?: () => string; recordResult?: (result: T) => Record<string, unknown>; observe?: (event: Record<string, unknown>) => Record<string, unknown>; verify?: (summary: {result: T; requests: number; refused: number; evidence: Record<string, unknown>[]; invalidEvidence: boolean; slotsUsed: number}) => void },
): Promise<{ result: T; requests: number; refused: number; evidence: Record<string, unknown>[]; invalidEvidence: boolean; slotsUsed: number }>;
