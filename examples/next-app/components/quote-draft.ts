import { defaultProductId } from '@/domain/catalog';
import type { ProductId } from '@/domain/identity';


function assertNever(value: never): never {
  throw new Error(`Unhandled quote draft action: ${String(value)}`);
}

export type QuoteDraftLine = Readonly<{
  readonly key: number;
  readonly productId: ProductId;
  readonly quantity: string;
}>;

export type QuoteDraftState = Readonly<{
  readonly lines: readonly QuoteDraftLine[];
  readonly nextLineKey: number;
}>;

export type QuoteDraftAction =
  | Readonly<{ type: 'add-line'; productId: ProductId }>
  | Readonly<{ type: 'remove-line'; lineKey: number }>
  | Readonly<{ type: 'select-product'; lineKey: number; productId: ProductId }>
  | Readonly<{ type: 'quantity-edited'; lineKey: number; quantity: string }>;

export const initialQuoteDraftState: QuoteDraftState = {
  lines: [{ key: 1, productId: defaultProductId, quantity: '1' }],
  nextLineKey: 2,
};

export function quoteDraftReducer(
  state: QuoteDraftState,
  action: QuoteDraftAction,
): QuoteDraftState {
  switch (action.type) {
    case 'add-line':
      return {
        lines: [...state.lines, { key: state.nextLineKey, productId: action.productId, quantity: '1' }],
        nextLineKey: state.nextLineKey + 1,
      };
    case 'remove-line':
      return {
        lines: state.lines.filter(line => line.key !== action.lineKey),
        nextLineKey: state.nextLineKey,
      };
    case 'select-product':
      return {
        lines: state.lines.map(line =>
          line.key === action.lineKey ? { ...line, productId: action.productId } : line,
        ),
        nextLineKey: state.nextLineKey,
      };
    case 'quantity-edited': {
      return {
        lines: state.lines.map(line =>
          line.key === action.lineKey ? { ...line, quantity: action.quantity } : line,
        ),
        nextLineKey: state.nextLineKey,
      };
    }
    default:
      return assertNever(action);
  }
}
