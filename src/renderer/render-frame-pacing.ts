const DEADLINE_TOLERANCE_MS = 0.5;

export function nextRenderDeadline(timestamp: number, deadline: number, maxFps: number): number | null {
  const frameIntervalMs = 1000 / Math.max(1, maxFps);
  if (timestamp + DEADLINE_TOLERANCE_MS < deadline) return null;
  const next = deadline + frameIntervalMs;
  return timestamp - next >= frameIntervalMs ? timestamp + frameIntervalMs : next;
}
