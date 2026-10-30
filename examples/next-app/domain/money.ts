import { z } from 'zod';

export const CurrencySchema = z.enum(['USD', 'EUR']);
export type Currency = z.infer<typeof CurrencySchema>;

export const MinorUnitsSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .brand<'MinorUnits'>();
export type MinorUnits = z.infer<typeof MinorUnitsSchema>;

export const MoneySchema = z
  .object({
    currency: CurrencySchema,
    minorUnits: MinorUnitsSchema,
  })
  .readonly();
export type Money = Readonly<{
  readonly currency: Currency;
  readonly minorUnits: MinorUnits;
}>;

export type MoneyFailure =
  | 'invalid-currency'
  | 'invalid-amount'
  | 'unsafe-minor-units'
  | 'currency-mismatch'
  | 'amount-overflow'
  | 'invalid-quantity'
  | 'invalid-basis-points';

export type MoneyResult =
  | Readonly<{ kind: 'ok'; value: Money }>
  | Readonly<{ kind: 'error'; reason: MoneyFailure }>;

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;

export function moneyFromMinorUnits(currency: Currency, minorUnits: number): MoneyResult {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    return { kind: 'error', reason: 'unsafe-minor-units' };
  }
  const parsedCurrency = CurrencySchema.safeParse(currency);
  if (!parsedCurrency.success) {
    return { kind: 'error', reason: 'invalid-currency' };
  }
  const parsedUnits = MinorUnitsSchema.safeParse(minorUnits);
  if (!parsedUnits.success) {
    return { kind: 'error', reason: 'unsafe-minor-units' };
  }
  return {
    kind: 'ok',
    value: { currency: parsedCurrency.data, minorUnits: parsedUnits.data },
  };
}

/**
 * Parses an exact decimal string into minor units without floating point.
 * Every currency supported by this example has two minor digits.
 */
export function parseMoney(currencyRaw: string, amountRaw: string): MoneyResult {
  const parsedCurrency = CurrencySchema.safeParse(currencyRaw);
  if (!parsedCurrency.success) {
    return { kind: 'error', reason: 'invalid-currency' };
  }
  const match = AMOUNT_PATTERN.exec(amountRaw.trim());
  if (match === null) {
    return { kind: 'error', reason: 'invalid-amount' };
  }
  const wholeText = match[1] ?? '0';
  const fractionText = (match[2] ?? '').padEnd(2, '0');
  const wholeUnits = Number(wholeText);
  const minorUnits = wholeUnits * 100 + Number(fractionText);
  if (!Number.isSafeInteger(wholeUnits) || !Number.isSafeInteger(minorUnits)) {
    return { kind: 'error', reason: 'unsafe-minor-units' };
  }
  return moneyFromMinorUnits(parsedCurrency.data, minorUnits);
}

export function formatMoney(money: Money): string {
  const wholeUnits = Math.trunc(money.minorUnits / 100);
  const fractionUnits = money.minorUnits % 100;
  const fractionText = fractionUnits.toString().padStart(2, '0');
  return `${money.currency} ${wholeUnits.toString()}.${fractionText}`;
}

export function addMoney(left: Money, right: Money): MoneyResult {
  if (left.currency !== right.currency) {
    return { kind: 'error', reason: 'currency-mismatch' };
  }
  const totalMinorUnits = left.minorUnits + right.minorUnits;
  if (!Number.isSafeInteger(totalMinorUnits)) {
    return { kind: 'error', reason: 'amount-overflow' };
  }
  return moneyFromMinorUnits(left.currency, totalMinorUnits);
}

export function multiplyMoney(money: Money, quantity: number): MoneyResult {
  if (!Number.isInteger(quantity) || quantity < 0) {
    return { kind: 'error', reason: 'invalid-quantity' };
  }
  const totalMinorUnits = money.minorUnits * quantity;
  if (!Number.isSafeInteger(totalMinorUnits)) {
    return { kind: 'error', reason: 'amount-overflow' };
  }
  return moneyFromMinorUnits(money.currency, totalMinorUnits);
}

/**
 * Applies a basis-point rate with an explicit half-up rounding rule.
 * The product is checked before division so no intermediate value leaves
 * the safe integer range.
 */
export function applyBasisPointsRounded(money: Money, basisPoints: number): MoneyResult {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    return { kind: 'error', reason: 'invalid-basis-points' };
  }
  const numerator = money.minorUnits * basisPoints;
  if (!Number.isSafeInteger(numerator)) {
    return { kind: 'error', reason: 'amount-overflow' };
  }
  const denominator = 10_000;
  const base = Math.floor(numerator / denominator);
  const remainder = numerator - base * denominator;
  const roundedMinorUnits = remainder * 2 >= denominator ? base + 1 : base;
  return moneyFromMinorUnits(money.currency, roundedMinorUnits);
}
