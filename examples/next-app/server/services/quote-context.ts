import 'server-only';
import { OrderIdSchema } from '@/domain/identity';
import type { QuoteContext } from '@/domain/quote';

/**
 * Request-boundary dependencies: the server action validates a fresh order ID
 * and reads the current instant once, then passes both explicitly to the domain.
 */
export function createQuoteContext(): QuoteContext {
  const orderId = OrderIdSchema.parse(crypto.randomUUID());
  return { orderId, now: new Date() };
}
