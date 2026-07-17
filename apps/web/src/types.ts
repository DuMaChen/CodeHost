import type {
  CleanupStatus,
  FindingCategory,
  FindingSeverity,
  RunStatus,
  StepStatus,
} from "./status";

export type User = {
  id?: string;
  username?: string;
  displayName?: string;
  csrfToken?: string;
};

export type RunSummary = {
  id: string;
  repository: string;
  pullRequestNumber?: number;
  title: string;
  author?: string;
  headSha: string;
  status: RunStatus;
  verdict?: "PASSED" | "FAILED" | "INCOMPLETE";
  cleanupStatus: CleanupStatus;
  createdAt: string;
  updatedAt: string;
};

export type RunDetail = RunSummary & {
  currentAttempt: number;
  executionPlan?: Record<string, unknown>;
  namespace?: string;
  previewHost?: string;
  cleanupAt?: string;
  cleanupError?: string;
};

export type RunStep = {
  key: string;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  failureReason?: string;
};

export type RunLog = {
  stepKey: string;
  label: string;
  content: string;
  truncated: boolean;
  expiresAt?: string;
};

export type Finding = {
  severity: FindingSeverity;
  category: FindingCategory;
  file: string;
  lineStart: number;
  lineEnd: number;
  title: string;
  description: string;
  evidence: string;
  recommendation: string;
};

export type Report = {
  summary: string;
  riskLevel: FindingSeverity;
  confidence: number;
  findings: Finding[];
};

export type Preview = {
  accessMode: string;
  status: string;
  url?: string;
  expiresAt?: string;
  portForwardCommand?: string;
  sshTunnelCommand?: string;
};
