import {
  DemoSessionIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  SYNTHETIC_DEMO_SESSION_ID,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

export const SYNTHETIC_DEMO_PURPOSE = "synthetic_demo";
export const DEMO_SESSION_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEMO_SESSION_EXPIRY_MS = 15_000;

const printableOwner = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "Web owner must contain printable ASCII without spaces");

export const DemoSessionPurposeSchema = z.literal(SYNTHETIC_DEMO_PURPOSE);
export type DemoSessionPurpose = z.infer<typeof DemoSessionPurposeSchema>;

export const DemoSessionWebOwnerSchema = printableOwner;
export type DemoSessionWebOwner = z.infer<typeof DemoSessionWebOwnerSchema>;

export function demoSessionExpiryAt(heartbeatAt: number): number | null {
  const expiresAt = heartbeatAt + DEMO_SESSION_EXPIRY_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return null;
  }
  return expiresAt;
}

const demoSessionShape = {
  demoSessionId: DemoSessionIdSchema,
  purpose: DemoSessionPurposeSchema,
  generation: PositiveIntegerSchema,
  webOwner: DemoSessionWebOwnerSchema.nullable(),
  heartbeatAt: NonnegativeIntegerSchema.nullable(),
  expiresAt: NonnegativeIntegerSchema.nullable(),
  seedHash: Sha256HexSchema,
  version: PositiveIntegerSchema,
  createdAt: NonnegativeIntegerSchema,
  updatedAt: NonnegativeIntegerSchema
};

export function isDemoSessionOwnershipShape(data: {
  webOwner: string | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}): boolean {
  if (data.updatedAt < data.createdAt) {
    return false;
  }
  const idle =
    data.webOwner === null && data.heartbeatAt === null && data.expiresAt === null;
  if (idle) {
    return true;
  }
  if (data.webOwner === null || data.heartbeatAt === null || data.expiresAt === null) {
    return false;
  }
  return data.expiresAt === demoSessionExpiryAt(data.heartbeatAt);
}

export const DemoSessionDraftSchema = z.object(demoSessionShape).strict();
export type DemoSessionDraft = z.infer<typeof DemoSessionDraftSchema>;

export const DemoSessionSchema = z.object(demoSessionShape).strict();
export type DemoSession = z.infer<typeof DemoSessionSchema>;

export const RefreshDemoSessionHeartbeatInputSchema = z
  .object({
    expectedVersion: PositiveIntegerSchema,
    webOwner: DemoSessionWebOwnerSchema,
    heartbeatAt: NonnegativeIntegerSchema
  })
  .strict();
export type RefreshDemoSessionHeartbeatInput = z.infer<
  typeof RefreshDemoSessionHeartbeatInputSchema
>;

export const SYNTHETIC_DEMO_SESSION = SYNTHETIC_DEMO_SESSION_ID;
