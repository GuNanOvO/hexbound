import type { OrderId, ProductId } from './identity';
import { formatMoney, type Currency } from './money';
import type { Quote } from './quote';

export type QuoteLineDto = Readonly<{
  readonly productId: ProductId;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
}>;

export type QuoteDto = Readonly<{
  readonly orderId: OrderId;
  readonly quotedAt: string;
  readonly currency: Currency;
  readonly lines: readonly QuoteLineDto[];
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
}>;

export function toQuoteDto(quote: Quote): QuoteDto {
  return {
    orderId: quote.orderId,
    quotedAt: quote.quotedAt,
    currency: quote.currency,
    lines: quote.lines.map(line => ({
      productId: line.product.id,
      productName: line.product.name,
      quantity: line.quantity,
      unitPrice: formatMoney(line.unitPrice),
      lineTotal: formatMoney(line.lineTotal),
    })),
    subtotal: formatMoney(quote.subtotal),
    tax: formatMoney(quote.tax),
    total: formatMoney(quote.total),
  };
}
