export function safeSyncTextSize(content: string): number {
  return new TextEncoder().encode(content).byteLength
}
