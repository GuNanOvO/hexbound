import { ProductIdSchema, type ProductId } from './identity';
import { parseMoney, type Money } from './money';

export type Product = Readonly<{
  readonly id: ProductId;
  readonly name: string;
  readonly unitPrice: Money;
}>;

function price(amount: string): Money {
  const parsed = parseMoney('USD', amount);
  if (parsed.kind === 'error') {
    throw new Error(`Catalog price ${amount} is invalid: ${parsed.reason}`);
  }
  return parsed.value;
}

export const defaultProductId: ProductId = ProductIdSchema.parse('prd-notebook');

export const products: readonly Product[] = [
  {
    id: ProductIdSchema.parse('prd-notebook'),
    name: 'Notebook',
    unitPrice: price('12.50'),
  },
  {
    id: ProductIdSchema.parse('prd-pen'),
    name: 'Pen',
    unitPrice: price('3.25'),
  },
  {
    id: ProductIdSchema.parse('prd-desk-lamp'),
    name: 'Desk lamp',
    unitPrice: price('49.00'),
  },
];

export function findProduct(request: {
  readonly productId: ProductId;
}): Product | undefined {
  return products.find(product => product.id === request.productId);
}
