// Three existing 30-second refresh periods; this is a UI threshold, not a service SLO.
export function governanceFreshness(generatedAt: string | undefined, now: number, readFailed: boolean) {
  const timestamp = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now + 30_000) return { current: false, label: "資料時間尚未確認", ageSeconds: null };
  const ageSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (readFailed || ageSeconds > 90) return { current: false, label: "資料過期／目前狀態未知", ageSeconds };
  return { current: true, label: "近期成功樣本", ageSeconds };
}

export function writerCompleteness(writer?: { failed: number; dropped: number; rejected?: number; consoleFailed?: number; stopped?: boolean } | null) {
  if (!writer) return "unknown";
  if (writer.failed > 0 || writer.dropped > 0 || (writer.rejected ?? 0) > 0 || (writer.consoleFailed ?? 0) > 0 || writer.stopped === true) return "degraded";
  if (writer.stopped !== false || writer.rejected === undefined || writer.consoleFailed === undefined) return "unknown";
  return "ready";
}
