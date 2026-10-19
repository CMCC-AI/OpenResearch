export interface NativeProjectSnapshot {
  version: 1;
  projectId: string;
  sessionId: string;
  responses: Record<string, unknown>;
  assets: Record<string, string>;
}
