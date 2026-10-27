export type TranscriptScrollPosition = { offset: number; atBottom: boolean; width?: number };
const positions = new Map<string, TranscriptScrollPosition>();

export function readTranscriptScroll(key: string) {
  return positions.get(key);
}

export function rememberTranscriptScroll(key: string, position: TranscriptScrollPosition) {
  if (!Number.isFinite(position.offset) || position.offset < 0) return;
  positions.delete(key);
  positions.set(key, { ...position });
  if (positions.size > 200) positions.delete(positions.keys().next().value!);
}
