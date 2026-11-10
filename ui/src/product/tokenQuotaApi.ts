import { caseRequest, caseWrite } from "./featuredCasesApi";

export interface QuotaBalance {
  enabled?: boolean;
  period: string;
  timezone: string;
  monthlyLimit: number;
  used: number;
  reserved: number;
  available: number;
}
export interface ManagedQuota extends QuotaBalance {
  user: { id: string; name: string; email: string };
  requests: {
    id: string;
    period: string;
    model: string;
    state: string;
    reserved: number;
    upstream_request_id: string | null;
  }[];
}
export function quotaRequestKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const ownQuota = (base: string) =>
  caseRequest<QuotaBalance>(base, "token-quota");
export const userQuota = (base: string, email: string) =>
  caseRequest<ManagedQuota>(
    base,
    `admin/token-quotas?email=${encodeURIComponent(email)}`,
  );
export const saveQuota = (
  base: string,
  data: {
    email: string;
    monthlyLimit: number;
    reason: string;
    idempotencyKey: string;
  },
) => caseWrite<ManagedQuota>(base, "admin/token-quotas", data);
export const reconcileQuota = (
  base: string,
  data: {
    email: string;
    requestId: string;
    actualTokens: number;
    reason: string;
  },
) => caseWrite<ManagedQuota>(base, "admin/token-quotas/reconcile", data);
