import { findProduct, type Product } from './catalog';
import type { OrderId, ProductId } from './identity';
import {
  addMoney,
  applyBasisPointsRounded,
  multiplyMoney,
  type Currency,
  type Money,
  type MoneyFailure,
} from './money';

export const MAX_ORDER_LINES = 3;
export const MAX_LINE_QUANTITY = 99;
export const TAX_BASIS_POINTS = 825;

export type OrderQuoteLineInput = Readonly<{
  readonly productId: ProductId;
  readonly quantity: number;
}>;

export type OrderQuoteInput = Readonly<{
  readonly lines: readonly OrderQuoteLineInput[];
}>;

export type QuoteContext = Readonly<{
  readonly orderId: OrderId;
  readonly now: Date;
}>;

export type QuoteLine = Readonly<{
  readonly product: Product;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}>;

export type Quote = Readonly<{
  readonly orderId: OrderId;
  readonly quotedAt: string;
  readonly currency: Currency;
  readonly lines: readonly QuoteLine[];
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
}>;

export type QuoteRejection =
  | 'no-lines'
  | 'too-many-lines'
  | 'unknown-product'
  | 'invalid-quantity'
  | 'currency-mismatch'
  | 'amount-overflow'
  | 'catalog-error';

export type QuoteOutcome =
  | Readonly<{ kind: 'quoted'; quote: Quote }>
  | Readonly<{ kind: 'rejected'; reason: QuoteRejection }>;

function reject(reason: QuoteRejection): QuoteOutcome {
  return { kind: 'rejected', reason };
}

function rejectMoney(failure: MoneyFailure): QuoteOutcome {
  switch (failure) {
    case 'currency-mismatch':
      return reject('currency-mismatch');
    case 'invalid-quantity':
      return reject('invalid-quantity');
    case 'amount-overflow':
    case 'unsafe-minor-units':
      return reject('amount-overflow');
    case 'invalid-currency':
    case 'invalid-amount':
    case 'invalid-basis-points':
      return reject('catalog-error');
    default: {
      const unreachable: never = failure;
      return unreachable;
    }
  }
}

/**
 * Pure quote calculation. The clock, random source, and identity allocation
 * happen at the server boundary and arrive through QuoteContext.
 */
export function quoteOrder(input: OrderQuoteInput, context: QuoteContext): QuoteOutcome {
  if (input.lines.length === 0) {
    return reject('no-lines');
  }
  if (input.lines.length > MAX_ORDER_LINES) {
    return reject('too-many-lines');
  }

  const quoteLines: QuoteLine[] = [];
  let subtotal: Money | undefined;

  for (const requestedLine of input.lines) {
    if (
      !Number.isInteger(requestedLine.quantity) ||
      requestedLine.quantity < 1 ||
      requestedLine.quantity > MAX_LINE_QUANTITY
    ) {
      return reject('invalid-quantity');
    }
    const product = findProduct({ productId: requestedLine.productId });
    if (product === undefined) {
      return reject('unknown-product');
    }
    const lineTotal = multiplyMoney(product.unitPrice, requestedLine.quantity);
    if (lineTotal.kind === 'error') {
      return rejectMoney(lineTotal.reason);
    }
    if (subtotal === undefined) {
      subtotal = lineTotal.value;
    } else {
      const nextSubtotal = addMoney(subtotal, lineTotal.value);
      if (nextSubtotal.kind === 'error') {
        return rejectMoney(nextSubtotal.reason);
      }
      subtotal = nextSubtotal.value;
    }
    quoteLines.push({
      product,
      quantity: requestedLine.quantity,
      unitPrice: product.unitPrice,
      lineTotal: lineTotal.value,
    });
  }

  if (subtotal === undefined) {
    return reject('no-lines');
  }

  const tax = applyBasisPointsRounded(subtotal, TAX_BASIS_POINTS);
  if (tax.kind === 'error') {
    return rejectMoney(tax.reason);
  }
  const total = addMoney(subtotal, tax.value);
  if (total.kind === 'error') {
    return rejectMoney(total.reason);
  }

  return {
    kind: 'quoted',
    quote: {
      orderId: context.orderId,
      quotedAt: context.now.toISOString(),
      currency: subtotal.currency,
      lines: quoteLines,
      subtotal,
      tax: tax.value,
      total: total.value,
    },
  };
}
