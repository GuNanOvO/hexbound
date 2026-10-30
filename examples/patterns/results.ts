import type { OrderId, UserId } from './identity.js';

/**
 * Business operations with expected outcomes return a discriminated union.
 * Each variant carries only the payload that is valid for it; callers must
 * handle every variant (the switch below is exhaustive).
 */
export interface OrderAccepted {
  readonly kind: 'accepted';
  readonly orderId: OrderId;
  readonly userId: UserId;
}

export interface OrderRejected {
  readonly kind: 'rejected';
  readonly reason: 'invalid-input' | 'out-of-stock';
}

export type PlaceOrderResult = OrderAccepted | OrderRejected;

export interface PlaceOrderInput {
  readonly orderId: OrderId;
  readonly userId: UserId;
  readonly available: boolean;
}

export function placeOrder(input: PlaceOrderInput): PlaceOrderResult {
  if (!input.available) return { kind: 'rejected', reason: 'out-of-stock' };
  return { kind: 'accepted', orderId: input.orderId, userId: input.userId };
}

export type ShipmentResult =
  | { readonly success: true; readonly tracking: string }
  | { readonly success: false; readonly reason: 'not-ready' | 'address-invalid' };

export function ship(result: PlaceOrderResult, tracking: string | undefined): ShipmentResult {
  if (result.kind === 'rejected') return { success: false, reason: 'not-ready' };
  if (tracking === undefined || tracking.length === 0) return { success: false, reason: 'address-invalid' };
  return { success: true, tracking };
}

export interface OrderSummary {
  readonly kind: 'accepted';
  readonly orderId: OrderId;
  readonly userId: UserId;
}

export interface RejectedSummary {
  readonly kind: 'rejected';
  readonly reason: 'invalid-input' | 'out-of-stock';
}

export type Summary = OrderSummary | RejectedSummary;

export function summarize(result: PlaceOrderResult): Summary {
  switch (result.kind) {
    case 'accepted':
      return { kind: 'accepted', orderId: result.orderId, userId: result.userId };
    case 'rejected':
      return { kind: 'rejected', reason: result.reason };
    default:
      return assertNever(result);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected business result: ${String(value)}`);
}
