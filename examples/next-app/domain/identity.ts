import { z } from 'zod';

export const OrderIdSchema = z.uuid().brand<'OrderId'>();
export type OrderId = z.infer<typeof OrderIdSchema>;

export const ProductIdSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^prd-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Product IDs use the prd- prefix and lowercase words.')
  .brand<'ProductId'>();
export type ProductId = z.infer<typeof ProductIdSchema>;

export function parseProductId(raw: string): ProductId | undefined {
  const result = ProductIdSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
