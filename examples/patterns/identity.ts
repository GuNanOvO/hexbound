import { z } from 'zod';

/**
 * Business identities are branded from one centralized Zod schema. The brand
 * exists only in the type system; a value leaving the process is an ordinary
 * JSON string and must be parsed again when it re-enters.
 */
const IdText = z.string().min(1).max(128);

const UserIdSchema = IdText.brand<'UserId'>();
const OrderIdSchema = IdText.brand<'OrderId'>();
const ProjectIdSchema = IdText.brand<'ProjectId'>();
const TenantIdSchema = IdText.brand<'TenantId'>();

export type UserId = z.infer<typeof UserIdSchema>;
export type OrderId = z.infer<typeof OrderIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type TenantId = z.infer<typeof TenantIdSchema>;

export const identitySchemas = {
  userId: UserIdSchema,
  orderId: OrderIdSchema,
  projectId: ProjectIdSchema,
  tenantId: TenantIdSchema,
};

export function parseUserId(value: unknown): UserId {
  return UserIdSchema.parse(value);
}

export function parseOrderId(value: unknown): OrderId {
  return OrderIdSchema.parse(value);
}

export function parseProjectId(value: unknown): ProjectId {
  return ProjectIdSchema.parse(value);
}

export function parseTenantId(value: unknown): TenantId {
  return TenantIdSchema.parse(value);
}

export interface IdentityJson<Kind extends string> {
  readonly kind: Kind;
  readonly value: string;
}

export function serializeUserId(value: UserId): IdentityJson<'userId'> {
  return { kind: 'userId', value };
}

export function serializeOrderId(value: OrderId): IdentityJson<'orderId'> {
  return { kind: 'orderId', value };
}

export interface OrderReference {
  readonly orderId: OrderId;
  readonly userId: UserId;
  readonly projectId: ProjectId;
  readonly tenantId: TenantId;
}

export function referenceOrder(orderId: OrderId, userId: UserId, projectId: ProjectId, tenantId: TenantId): OrderReference {
  return { orderId, userId, projectId, tenantId };
}
