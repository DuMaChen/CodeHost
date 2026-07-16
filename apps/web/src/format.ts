export function formatDate(value: string | undefined): string {
  if (!value) return "时间未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间无效";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return "时间未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间无效";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 7) : sha;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs < 0 || !Number.isFinite(durationMs)) return "时长未提供";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
