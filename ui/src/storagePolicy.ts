export type StoragePolicy = {
  managed: boolean;
  canInspect: boolean;
  readOnly: true;
  current?: string;
  source?: string;
};

export function storageMode(policy: StoragePolicy | null | undefined, hosted: boolean, loading: boolean) {
  if (loading) return "loading";
  return policy?.managed || hosted ? "managed" : "local";
}
