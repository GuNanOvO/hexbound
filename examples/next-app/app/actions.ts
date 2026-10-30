'use server';

import type { QuoteActionState } from '@/domain/quote-contract';
import { quoteOrder, type QuoteOutcome } from '@/domain/quote';
import { toQuoteDto } from '@/domain/quote-dto';
import { createQuoteContext } from '@/server/services/quote-context';
import { parseQuoteRequest } from '@/validation/quote';

export async function quoteAction(
  _previousState: QuoteActionState,
  formData: FormData,
): Promise<QuoteActionState> {
  const productIds = formData.getAll('productId');
  const quantities = formData.getAll('quantity');
  const rawInput: unknown = {
    lines: productIds.map((productId, index) => ({
      productId,
      quantity: quantities[index],
    })),
  };

  const parsed = parseQuoteRequest(rawInput);
  if (parsed.kind === 'invalid') {
    return { kind: 'invalid-input', issues: parsed.issues };
  }

  const outcome: QuoteOutcome = quoteOrder(parsed.value, createQuoteContext());

  switch (outcome.kind) {
    case 'quoted':
      return { kind: 'quoted', dto: toQuoteDto(outcome.quote) };
    case 'rejected':
      return { kind: 'rejected', reason: outcome.reason };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}
