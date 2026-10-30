import { z } from 'zod';
import { ProductIdSchema } from '../domain/identity';

const quantitySchema = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/, 'Quantity must be a whole number from 1 to 9999.')
  .transform(value => Number(value))
  .pipe(z.number().int().min(1).max(9_999));

const quoteLineSchema = z
  .object({
    productId: ProductIdSchema,
    quantity: quantitySchema,
  })
  .readonly();

const quoteRequestSchema = z
  .object({
    lines: z.array(quoteLineSchema).min(1).max(8).readonly(),
  })
  .readonly();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export type QuoteRequestParseResult =
  | Readonly<{ kind: 'valid'; value: QuoteRequest }>
  | Readonly<{ kind: 'invalid'; issues: readonly string[] }>;

export function parseQuoteRequest(input: unknown): QuoteRequestParseResult {
  const result = quoteRequestSchema.safeParse(input);
  if (result.success) {
    return { kind: 'valid', value: result.data };
  }
  return {
    kind: 'invalid',
    issues: result.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    }),
  };
}
