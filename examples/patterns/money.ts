import { z } from 'zod';

/**
 * Exact decimal money: a currency plus a branded safe-integer amount in minor
 * units. Strings are parsed with integer arithmetic (never parseFloat) and
 * every construction validates the safe-integer range. Serialized money is a
 * plain JSON object with a numeric minor-unit value, so JSON.stringify works
 * without a bigint trap.
 */
export const CurrencySchema = z.enum(['USD', 'EUR', 'JPY', 'KWD']);
export type Currency = z.infer<typeof CurrencySchema>;

const MinorUnitsSchema = z.number().int().safe().brand<'MinorUnits'>();
export type MinorUnits = z.infer<typeof MinorUnitsSchema>;

export interface Money {
  readonly currency: Currency;
  readonly minorUnits: MinorUnits;
}

export interface SerializedMoney {
  readonly currency: Currency;
  readonly minorUnits: number;
}

export type Rounding = 'down' | 'up' | 'half-up' | 'half-even';

const CURRENCY_EXPONENT: Readonly<Record<Currency, number>> = {
  USD: 2,
  EUR: 2,
  JPY: 0,
  KWD: 3,
};

const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const SerializedMoneySchema = z.object({
  currency: CurrencySchema,
  minorUnits: z.number().int().safe(),
});

function assertNever(value: never): never {
  throw new Error(`Unhandled money rounding mode: ${String(value)}`);
}

function moneyFromBigInt(value: bigint, currency: Currency): Money {
  if (value > SAFE_MAX || value < SAFE_MIN) {
    throw new RangeError('Monetary amount exceeds the safe integer range.');
  }
  return { currency, minorUnits: MinorUnitsSchema.parse(Number(value)) };
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new TypeError(`Currency mismatch: ${left.currency} and ${right.currency} cannot be combined.`);
  }
}

export function fromMinorUnits(value: number, currency: Currency): Money {
  return { currency, minorUnits: MinorUnitsSchema.parse(value) };
}

export function zeroMoney(currency: Currency): Money {
  return fromMinorUnits(0, currency);
}

/** Parses a base-10 string using the currency's declared exponent. */
export function parseMoney(text: string, currency: Currency): Money {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) throw new TypeError(`Invalid monetary string: ${text}`);
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2];
  if (whole === undefined) throw new TypeError(`Invalid monetary string: ${text}`);
  const fraction = match[3] ?? '';
  const exponent = CURRENCY_EXPONENT[currency];
  if (fraction.length > exponent) {
    throw new RangeError(`${currency} accepts at most ${exponent} fraction digits.`);
  }
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`;
  return moneyFromBigInt(sign * BigInt(digits), currency);
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return moneyFromBigInt(BigInt(left.minorUnits) + BigInt(right.minorUnits), left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return moneyFromBigInt(BigInt(left.minorUnits) - BigInt(right.minorUnits), left.currency);
}

export function multiplyMoney(money: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError('Money quantity must be a safe integer.');
  }
  return moneyFromBigInt(BigInt(money.minorUnits) * BigInt(quantity), money.currency);
}

/**
 * Applies a rational rate (numerator / denominator) with an explicit rounding
 * mode. The intermediate value is a bigint, so no floating-point error enters
 * the result; the final safe-integer check is shared with every constructor.
 */
export function applyRate(money: Money, numerator: number, denominator: number, rounding: Rounding): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError('Rate numerator and denominator must be safe integers.');
  }
  if (denominator <= 0) {
    throw new RangeError('Rate denominator must be positive.');
  }
  const product = BigInt(money.minorUnits) * BigInt(numerator);
  const divisor = BigInt(denominator);
  if (product === 0n) return moneyFromBigInt(0n, money.currency);

  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  let rounded: bigint;

  switch (rounding) {
    case 'down':
      rounded = quotient;
      break;
    case 'up':
      rounded = remainder === 0n ? quotient : quotient + 1n;
      break;
    case 'half-up':
      rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
      break;
    case 'half-even': {
      const doubled = remainder * 2n;
      if (doubled > divisor) rounded = quotient + 1n;
      else if (doubled < divisor) rounded = quotient;
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
    default:
      return assertNever(rounding);
  }

  return moneyFromBigInt(negative ? -rounded : rounded, money.currency);
}

export function toJSON(money: Money): SerializedMoney {
  if (!Number.isSafeInteger(money.minorUnits)) {
    throw new RangeError('Money minor units must be a safe integer.');
  }
  return { currency: money.currency, minorUnits: money.minorUnits };
}

export function fromJSON(value: unknown): Money {
  const parsed = SerializedMoneySchema.parse(value);
  return { currency: parsed.currency, minorUnits: MinorUnitsSchema.parse(parsed.minorUnits) };
}

export function formatMoney(money: Money): string {
  const exponent = CURRENCY_EXPONENT[money.currency];
  const negative = money.minorUnits < 0;
  const absolute = Math.abs(money.minorUnits);
  const digits = String(absolute).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
