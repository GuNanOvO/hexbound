import type { QuoteDto } from './quote-dto';
import type { QuoteRejection } from './quote';

export type QuoteActionResult =
  | Readonly<{ kind: 'invalid-input'; issues: readonly string[] }>
  | Readonly<{ kind: 'quoted'; dto: QuoteDto }>
  | Readonly<{ kind: 'rejected'; reason: QuoteRejection }>;

export type QuoteActionState = Readonly<{ kind: 'idle' }> | QuoteActionResult;

export const initialQuoteActionState: QuoteActionState = { kind: 'idle' };
