export interface NativeProjectSnapshot {
  version: 1;
  projectId: string;
  sessionId: string;
  /** Present only for cases scoped to one source conversation. */
  sourceSessionId?: string;
  responses: Record<string, unknown>;
  assets: Record<string, string>;
}
