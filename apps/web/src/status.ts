export const RUN_STATUS_VALUES = [
  "RECEIVED",
  "QUEUED",
  "PLANNING",
  "EXECUTING",
  "ANALYZING",
  "REPORTING",
  "PASSED",
  "FAILED",
  "INCOMPLETE",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "REJECTED_BY_CAPACITY",
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export const CLEANUP_STATUS_VALUES = ["NOT_SCHEDULED", "PENDING", "CLEANED", "FAILED"] as const;
export type CleanupStatus = (typeof CLEANUP_STATUS_VALUES)[number];

export const STEP_STATUS_VALUES = [
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "SKIPPED",
  "INCOMPLETE",
  "CANCELLED",
] as const;
export type StepStatus = (typeof STEP_STATUS_VALUES)[number];

export const FINDING_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = ["bug", "security", "reliability", "maintainability"] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  RECEIVED: "已接收",
  QUEUED: "排队中",
  PLANNING: "规划中",
  EXECUTING: "执行中",
  ANALYZING: "分析中",
  REPORTING: "生成报告",
  PASSED: "通过",
  FAILED: "失败",
  INCOMPLETE: "未完成",
  CANCEL_REQUESTED: "取消中",
  CANCELLED: "已取消",
  REJECTED_BY_CAPACITY: "容量拒绝",
};

const RUN_STATUS_TONES: Record<RunStatus, "neutral" | "info" | "success" | "danger" | "warning"> = {
  RECEIVED: "neutral",
  QUEUED: "info",
  PLANNING: "info",
  EXECUTING: "info",
  ANALYZING: "info",
  REPORTING: "info",
  PASSED: "success",
  FAILED: "danger",
  INCOMPLETE: "warning",
  CANCEL_REQUESTED: "warning",
  CANCELLED: "neutral",
  REJECTED_BY_CAPACITY: "danger",
};

const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  PENDING: "等待",
  RUNNING: "运行中",
  PASSED: "通过",
  FAILED: "失败",
  SKIPPED: "已跳过",
  INCOMPLETE: "未完成",
  CANCELLED: "已取消",
};

const CLEANUP_STATUS_LABELS: Record<CleanupStatus, string> = {
  NOT_SCHEDULED: "未安排",
  PENDING: "清理中",
  CLEANED: "已清理",
  FAILED: "清理失败",
};

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUS_VALUES as readonly string[]).includes(value);
}

export function isCleanupStatus(value: unknown): value is CleanupStatus {
  return typeof value === "string" && (CLEANUP_STATUS_VALUES as readonly string[]).includes(value);
}

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === "string" && (STEP_STATUS_VALUES as readonly string[]).includes(value);
}

export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

export function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && (FINDING_CATEGORIES as readonly string[]).includes(value);
}

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status];
}

export function runStatusTone(status: RunStatus): (typeof RUN_STATUS_TONES)[RunStatus] {
  return RUN_STATUS_TONES[status];
}

export function stepStatusLabel(status: StepStatus): string {
  return STEP_STATUS_LABELS[status];
}

export function cleanupStatusLabel(status: CleanupStatus): string {
  return CLEANUP_STATUS_LABELS[status];
}

export function severityLabel(severity: FindingSeverity): string {
  return { LOW: "低", MEDIUM: "中", HIGH: "高", CRITICAL: "严重" }[severity];
}

export function categoryLabel(category: FindingCategory): string {
  return {
    bug: "缺陷",
    security: "安全",
    reliability: "可靠性",
    maintainability: "可维护性",
  }[category];
}
