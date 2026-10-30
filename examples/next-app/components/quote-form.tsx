'use client';

import { useActionState, useReducer } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { quoteAction } from '@/app/actions';
import { defaultProductId, findProduct, products } from '@/domain/catalog';
import { parseProductId } from '@/domain/identity';
import { formatMoney } from '@/domain/money';
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES, type QuoteRejection } from '@/domain/quote';
import { initialQuoteActionState, type QuoteActionState } from '@/domain/quote-contract';
import { useConnectionStatus } from '@/hooks/effects/use-connection-status';
import {
  initialQuoteDraftState,
  quoteDraftReducer,
  type QuoteDraftLine,
} from './quote-draft';

type QuoteLineEditorProps = Readonly<{
  readonly line: QuoteDraftLine;
  readonly index: number;
  readonly onProductChange: (lineKey: number, event: ChangeEvent<HTMLSelectElement>) => void;
  readonly onQuantityChange: (lineKey: number, event: ChangeEvent<HTMLInputElement>) => void;
  readonly onRemove: () => void;
}>;

function QuoteLineEditor({
  line,
  index,
  onProductChange,
  onQuantityChange,
  onRemove,
}: QuoteLineEditorProps): ReactElement {
  const product = findProduct({ productId: line.productId });
  const unitPriceText = product === undefined ? 'Unknown catalog item' : formatMoney(product.unitPrice);
  return (
    <fieldset className="line-editor">
      <legend>Line {index + 1}</legend>
      <div className="field">
        <label htmlFor={`product-${line.key}`}>Product</label>
        <select
          id={`product-${line.key}`}
          name="productId"
          value={line.productId}
          onChange={event => {
            onProductChange(line.key, event);
          }}
        >
          {products.map(productOption => (
            <option key={productOption.id} value={productOption.id}>
              {productOption.name} ({formatMoney(productOption.unitPrice)})
            </option>
          ))}
        </select>
        <p className="hint" id={`unit-price-${line.key}`}>
          Unit price: {unitPriceText}
        </p>
      </div>
      <div className="field quantity-field">
        <label htmlFor={`quantity-${line.key}`}>Quantity</label>
        <input
          id={`quantity-${line.key}`}
          name="quantity"
          type="number"
          inputMode="numeric"
          min={1}
          max={9_999}
          step={1}
          required
          value={line.quantity}
          onChange={event => {
            onQuantityChange(line.key, event);
          }}
        />
      </div>
      <button
        type="button"
        className="secondary remove-button"
        aria-label={`Remove line ${index + 1}`}
        onClick={onRemove}
      >
        Remove line
      </button>
    </fieldset>
  );
}

function describeRejection(reason: QuoteRejection): string {
  switch (reason) {
    case 'no-lines':
      return 'Add at least one line item before requesting a quote.';
    case 'too-many-lines':
      return `A quote accepts at most ${MAX_ORDER_LINES} line items.`;
    case 'unknown-product':
      return 'One line references a product that is not in the current catalog.';
    case 'invalid-quantity':
      return `Each quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}.`;
    case 'currency-mismatch':
      return 'The lines use different currencies, so they cannot be combined.';
    case 'amount-overflow':
      return 'The order total is outside the supported safe integer range.';
    case 'catalog-error':
      return 'The server-side catalog is misconfigured, so the quote cannot be calculated.';
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

function QuoteResultPanel({ state }: Readonly<{ state: QuoteActionState }>): ReactElement {
  switch (state.kind) {
    case 'idle':
      return (
        <section className="result result-idle" aria-labelledby="result-heading">
          <h2 id="result-heading">Quote result</h2>
          <p>Submit the form to validate the draft and calculate totals on the server.</p>
        </section>
      );
    case 'invalid-input':
      return (
        <section className="result result-error" role="alert">
          <h2>Quote result</h2>
          <p>The form data did not pass validation.</p>
          <ul>
            {state.issues.map((issue, index) => (
              <li key={`${index}-${issue}`}>{issue}</li>
            ))}
          </ul>
        </section>
      );
    case 'rejected':
      return (
        <section className="result result-error" role="alert">
          <h2>Quote result</h2>
          <p>No quote was produced.</p>
          <p>{describeRejection(state.reason)}</p>
        </section>
      );
    case 'quoted':
      return (
        <section className="result result-success" role="status">
          <h2>Quoted order</h2>
          <p>
            Order <code>{state.dto.orderId}</code>
          </p>
          <p>
            Quoted at <time dateTime={state.dto.quotedAt}>{state.dto.quotedAt}</time>
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Quantity</th>
                <th scope="col">Unit price</th>
                <th scope="col">Line total</th>
              </tr>
            </thead>
            <tbody>
              {state.dto.lines.map((line, index) => (
                <tr key={`${line.productId}-${index}`}>
                  <td>{line.productName}</td>
                  <td>{line.quantity}</td>
                  <td>{line.unitPrice}</td>
                  <td>{line.lineTotal}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{state.dto.subtotal}</dd>
            </div>
            <div>
              <dt>Tax</dt>
              <dd>{state.dto.tax}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{state.dto.total}</dd>
            </div>
          </dl>
        </section>
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function QuoteForm(): ReactElement {
  const [actionState, submitAction, isPending] = useActionState(
    quoteAction,
    initialQuoteActionState,
  );
  const [draft, dispatch] = useReducer(quoteDraftReducer, initialQuoteDraftState);
  const connection = useConnectionStatus();
  const isOffline = connection === 'offline';

  const handleProductChange = (
    lineKey: number,
    event: ChangeEvent<HTMLSelectElement>,
  ): void => {
    const productId = parseProductId(event.currentTarget.value);
    if (productId === undefined) {
      return;
    }
    dispatch({ type: 'select-product', lineKey, productId });
  };

  const handleQuantityChange = (
    lineKey: number,
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    dispatch({ type: 'quantity-edited', lineKey, quantity: event.currentTarget.value });
  };

  const handleAddLine = (): void => {
    dispatch({ type: 'add-line', productId: defaultProductId });
  };

  return (
    <section className="quote-card" aria-labelledby="quote-form-heading">
      <div className="form-header">
        <div>
          <h2 id="quote-form-heading">Build a quote</h2>
          <p className="muted">
            The catalog and tax rate stay on the server. The action validates raw FormData before
            any business calculation.
          </p>
        </div>
        <p className="connection" role="status">
          Connection: <strong>{isOffline ? 'Offline' : 'Online'}</strong>
        </p>
      </div>

      {isOffline ? (
        <p className="notice" role="status">
          A quote cannot be submitted while this browser reports offline. Reconnect to enable the
          submit button.
        </p>
      ) : null}

      <form
        action={submitAction}
        className="quote-form"
        onReset={event => {
          // The reducer owns the draft; an action reset must not rewrite DOM values independently.
          event.preventDefault();
        }}
        onSubmit={event => {
          if (isOffline) {
            event.preventDefault();
          }
        }}
      >
        <div className="lines">
          {draft.lines.map((line, index) => (
            <QuoteLineEditor
              key={line.key}
              line={line}
              index={index}
              onProductChange={handleProductChange}
              onQuantityChange={handleQuantityChange}
              onRemove={() => {
                dispatch({ type: 'remove-line', lineKey: line.key });
              }}
            />
          ))}
        </div>

        {draft.lines.length === 0 ? (
          <p className="hint">No line items yet. Add at least one before submitting.</p>
        ) : null}

        <div className="form-actions">
          <button type="button" className="secondary" onClick={handleAddLine}>
            Add line
          </button>
          <button type="submit" disabled={isPending || isOffline}>
            {isPending ? 'Calculating...' : 'Calculate quote'}
          </button>
        </div>
        <p className="hint">
          A quote accepts at most {MAX_ORDER_LINES} line items; each quantity must be 1 to{' '}
          {MAX_LINE_QUANTITY}.
        </p>
      </form>

      <QuoteResultPanel state={actionState} />
    </section>
  );
}
