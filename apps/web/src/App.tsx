import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, authLoginUrl, cancelRun, getLogs, getPreview, getReport, getRun, getRuns, getSession, getSteps, retryRun } from "./api";
import { formatConfidence, formatDate, formatDuration, formatTimestamp, shortSha } from "./format";
import {
  categoryLabel,
  cleanupStatusLabel,
  runStatusLabel,
  runStatusTone,
  severityLabel,
  stepStatusLabel,
} from "./status";
import type { Preview, Report, RunDetail, RunLog, RunStep, RunSummary, User } from "./types";

type SessionState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: User }
  | { status: "error"; error: ApiError };

type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError };

type RunsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: RunSummary[] }
  | { status: "error"; error: ApiError };

type DetailState =
  | { status: "idle" | "loading" }
  | {
      status: "ready";
      run: RunDetail;
      steps: ResourceState<RunStep[]>;
      logs: ResourceState<RunLog[]>;
      report: ResourceState<Report | null>;
      preview: ResourceState<Preview | null>;
    }
  | { status: "error"; error: ApiError };

function errorMessage(error: ApiError): string {
  if (error.code === "AUTH_REQUIRED") return "登录状态已失效，请重新登录。";
  if (error.code === "FORBIDDEN") return "当前账号没有访问这些运行记录的权限。";
  if (error.code === "NOT_FOUND") return "这条运行记录已不存在，或暂时不可见。";
  if (error.code === "NETWORK_ERROR") return "无法连接运行台 API，请确认服务已启动。";
  if (error.code === "INVALID_RESPONSE") return "API 返回的数据不符合当前契约，页面没有采用该数据。";
  return "运行台 API 暂时不可用，请稍后重试。";
}

function normalizeError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("运行台请求失败", "HTTP_ERROR");
}

function StatusBadge({ status }: { status: RunDetail["status"] }) {
  return <span className={`status-badge status-badge--${runStatusTone(status)}`}>{runStatusLabel(status)}</span>;
}

function StepBadge({ status }: { status: RunStep["status"] }) {
  const tone = status === "PASSED" ? "success" : status === "FAILED" || status === "INCOMPLETE" ? "danger" : status === "RUNNING" ? "info" : "neutral";
  return <span className={`step-badge step-badge--${tone}`}>{stepStatusLabel(status)}</span>;
}

function LoadingScreen() {
  return (
    <main className="center-stage" aria-live="polite">
      <div className="loading-mark" aria-hidden="true" />
      <p>正在验证登录状态</p>
    </main>
  );
}

function LoginScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="login-stage">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">PR</span>
          <span>RUNWAY</span>
        </div>
        <p className="eyebrow">运行质量控制台</p>
        <h1 id="login-title">先登录，再查看运行</h1>
        <p className="login-copy">运行列表、报告和 Preview 只对已通过仓库权限校验的会话开放。</p>
        <a className="button button--primary button--wide" href={authLoginUrl()}>进入 Gitea 登录</a>
        <button className="text-button" type="button" onClick={onRetry}>重新检查登录状态</button>
        <p className="security-note"><span className="security-dot" aria-hidden="true" />会话由服务端管理，浏览器不保存访问令牌</p>
      </section>
    </main>
  );
}

function ErrorStage({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <main className="center-stage center-stage--error">
      <div className="state-icon state-icon--danger" aria-hidden="true">!</div>
      <p className="eyebrow">登录状态不可用</p>
      <h1>无法确认当前会话</h1>
      <p>{errorMessage(error)}</p>
      <button className="button button--secondary" type="button" onClick={onRetry}>重新连接</button>
    </main>
  );
}

function RunList({
  state,
  selectedRunId,
  onSelect,
}: {
  state: RunsState;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <aside className="run-list-pane" aria-labelledby="run-list-title">
      <div className="pane-heading">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h2 id="run-list-title">运行列表</h2>
        </div>
        {state.status === "ready" ? <span className="count-chip">{state.data.length}</span> : null}
      </div>
      {state.status === "loading" || state.status === "idle" ? (
        <div className="inline-state" aria-live="polite"><div className="mini-loader" />正在加载运行</div>
      ) : null}
      {state.status === "error" ? (
        <div className="inline-state inline-state--error" role="alert">
          <strong>运行列表不可用</strong>
          <span>{errorMessage(state.error)}</span>
        </div>
      ) : null}
      {state.status === "ready" && state.data.length === 0 ? (
        <div className="empty-list">
          <div className="empty-icon" aria-hidden="true">—</div>
          <strong>还没有运行记录</strong>
          <span>收到新的 Pull Request Webhook 后，运行会出现在这里。</span>
        </div>
      ) : null}
      {state.status === "ready" && state.data.length > 0 ? (
        <div className="run-list" role="list">
          {state.data.map((run) => (
            <button
              className={`run-row ${selectedRunId === run.id ? "run-row--selected" : ""}`}
              key={run.id}
              type="button"
              onClick={() => onSelect(run.id)}
              role="listitem"
              aria-current={selectedRunId === run.id ? "true" : undefined}
            >
              <div className="run-row__topline">
                <span className="run-repo">{run.repository}</span>
                <StatusBadge status={run.status} />
              </div>
              <strong>{run.title}</strong>
              <div className="run-row__meta">
                <span>{run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "PR 编号未提供"}</span>
                <span>{formatDate(run.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function ResourceStateView({ resource, emptyLabel }: { resource: ResourceState<unknown>; emptyLabel: string }) {
  if (resource.status === "loading") return <div className="panel-state"><div className="mini-loader" />正在加载</div>;
  if (resource.status === "error") return <div className="panel-state panel-state--error" role="alert">{errorMessage(resource.error)}</div>;
  if (resource.data === null) return <div className="panel-state">{emptyLabel}</div>;
  return null;
}

function RunHeader({ run }: { run: RunDetail }) {
  const profile = typeof run.executionPlan?.profile === "string" ? run.executionPlan.profile : undefined;
  return (
    <section className="run-header">
      <div>
        <div className="breadcrumb">{run.repository} <span>/</span> {run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "Pull Request"}</div>
        <div className="title-line">
          <h1>{run.title}</h1>
          <StatusBadge status={run.status} />
        </div>
        <div className="run-facts">
          <span>提交 <code>{shortSha(run.headSha)}</code></span>
          <span>尝试 #{run.currentAttempt}</span>
          {profile ? <span>Profile <code>{profile}</code></span> : null}
          <span>更新于 {formatTimestamp(run.updatedAt)}</span>
        </div>
      </div>
      <div className="run-id">RUN <code>{shortSha(run.id)}</code></div>
    </section>
  );
}

function TimelinePanel({ resource }: { resource: ResourceState<RunStep[]> }) {
  return (
    <section className="panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div><p className="eyebrow">EXECUTION</p><h2 id="timeline-title">运行时间线</h2></div>
        {resource.status === "ready" && resource.data.length > 0 ? <span className="panel-count">{resource.data.length} steps</span> : null}
      </div>
      {resource.status === "error" ? <div className="panel-state panel-state--error" role="alert">{errorMessage(resource.error)}</div> : null}
      {resource.status === "loading" ? <div className="panel-state"><div className="mini-loader" />正在加载步骤状态</div> : null}
      {resource.status === "ready" && resource.data.length === 0 ? <div className="panel-state">API 未返回步骤，当前不展示推测状态。</div> : null}
      {resource.status === "ready" && resource.data.length > 0 ? (
        <ol className="timeline">
          {resource.data.map((step) => (
            <li className="timeline-item" key={step.key}>
              <span className={`timeline-dot timeline-dot--${step.status.toLowerCase()}`} aria-hidden="true" />
              <div className="timeline-content">
                <div className="timeline-title"><strong>{step.label}</strong><StepBadge status={step.status} /></div>
                <div className="timeline-meta">
                  <span>{step.startedAt ? formatTimestamp(step.startedAt) : "尚未开始"}</span>
                  {step.durationMs !== undefined ? <span>{formatDuration(step.durationMs)}</span> : null}
                </div>
                {step.failureReason ? <p className="failure-copy">{step.failureReason}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function LogsPanel({ resource }: { resource: ResourceState<RunLog[]> }) {
  return (
    <section className="panel" aria-labelledby="logs-title">
      <div className="panel-heading">
        <div><p className="eyebrow">EVIDENCE</p><h2 id="logs-title">执行日志</h2></div>
        {resource.status === "ready" ? <span className="panel-count">{resource.data.length} logs</span> : null}
      </div>
      {resource.status === "error" ? <div className="panel-state panel-state--error" role="alert">{errorMessage(resource.error)}</div> : null}
      {resource.status === "loading" ? <div className="panel-state"><div className="mini-loader" />正在加载日志</div> : null}
      {resource.status === "ready" && resource.data.length === 0 ? <div className="panel-state">暂无可读取的脱敏日志。</div> : null}
      {resource.status === "ready" && resource.data.length > 0 ? (
        <div className="logs-list">
          {resource.data.map((log) => (
            <details className="log-entry" key={log.stepKey}>
              <summary>{log.label}</summary>
              <pre>{log.content}</pre>
            </details>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ReportPanel({ resource }: { resource: ResourceState<Report | null> }) {
  return (
    <section className="panel" aria-labelledby="report-title">
      <div className="panel-heading">
        <div><p className="eyebrow">AGENT REVIEW</p><h2 id="report-title">报告摘要</h2></div>
        {resource.status === "ready" && resource.data ? <span className={`risk-label risk-label--${resource.data.riskLevel.toLowerCase()}`}>{severityLabel(resource.data.riskLevel)}风险</span> : null}
      </div>
      {resource.status !== "ready" ? <ResourceStateView resource={resource} emptyLabel="尚无报告" /> : null}
      {resource.status === "ready" && resource.data === null ? <div className="panel-state">报告尚未生成，当前不推断审查结论。</div> : null}
      {resource.status === "ready" && resource.data ? (
        <>
          <div className="report-summary">{resource.data.summary}</div>
          <div className="report-metrics">
            <div><span>置信度</span><strong>{formatConfidence(resource.data.confidence)}</strong></div>
            <div><span>Findings</span><strong>{resource.data.findings.length}</strong></div>
          </div>
          {resource.data.findings.length > 0 ? (
            <div className="findings-list">
              <div className="findings-heading"><h3>Findings</h3><span>按严重级别展示</span></div>
              {resource.data.findings.map((finding) => (
                <article className="finding" key={`${finding.file}:${finding.lineStart}:${finding.title}`}>
                  <div className="finding-topline">
                    <span className={`severity-dot severity-dot--${finding.severity.toLowerCase()}`} aria-hidden="true" />
                    <strong>{finding.title}</strong>
                    <span className={`severity-label severity-label--${finding.severity.toLowerCase()}`}>{severityLabel(finding.severity)}</span>
                  </div>
                  <div className="finding-location"><code>{finding.file}:{finding.lineStart}{finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}</code><span>{categoryLabel(finding.category)}</span></div>
                  <p>{finding.description}</p>
                  <div className="finding-detail"><span>证据</span><p>{finding.evidence}</p></div>
                  <div className="finding-detail"><span>建议</span><p>{finding.recommendation}</p></div>
                </article>
              ))}
            </div>
          ) : <div className="quiet-success">报告未返回 Finding。</div>}
        </>
      ) : null}
    </section>
  );
}

function PreviewPanel({ resource }: { resource: ResourceState<Preview | null> }) {
  return (
    <section className="panel preview-panel" aria-labelledby="preview-title">
      <div className="panel-heading">
        <div><p className="eyebrow">ACCESS</p><h2 id="preview-title">Preview</h2></div>
        {resource.status === "ready" && resource.data ? <span className="access-mode">{resource.data.accessMode}</span> : null}
      </div>
      {resource.status === "loading" ? <div className="panel-state"><div className="mini-loader" />正在加载 Preview 信息</div> : null}
      {resource.status === "error" ? <div className="panel-state panel-state--error" role="alert">{errorMessage(resource.error)}</div> : null}
      {resource.status === "ready" && resource.data === null ? <div className="panel-state">暂无 Preview。只有 API 明确返回入口后才会显示访问按钮。</div> : null}
      {resource.status === "ready" && resource.data ? (
        <div className="preview-body">
          <div className="preview-status"><span className={`preview-indicator preview-indicator--${resource.data.status.toLowerCase()}`} aria-hidden="true" /><strong>{resource.data.status}</strong></div>
          {resource.data.url ? <a className="button button--primary" href={resource.data.url} target="_blank" rel="noreferrer">打开 Preview <span aria-hidden="true">↗</span></a> : <span className="disabled-action">API 未提供可打开的 URL</span>}
          {resource.data.expiresAt ? <p className="muted-copy">有效期至 {formatTimestamp(resource.data.expiresAt)}</p> : null}
          {(resource.data.portForwardCommand ?? resource.data.sshTunnelCommand) ? <div className="tunnel-command"><span>本地访问命令</span><code>{resource.data.portForwardCommand ?? resource.data.sshTunnelCommand}</code></div> : null}
        </div>
      ) : null}
    </section>
  );
}

type RunAction = "retry" | "retry-after-cleanup-failure" | "cancel";

function OperationsPanel({
  run,
  action,
  actionError,
  onAction,
}: {
  run: RunDetail;
  action: RunAction | undefined;
  actionError: string | undefined;
  onAction: (action: RunAction) => void;
}) {
  const cleanupTone = run.cleanupStatus === "CLEANED" ? "success" : run.cleanupStatus === "FAILED" ? "danger" : run.cleanupStatus === "PENDING" ? "warning" : "neutral";
  const isFailure = run.status === "FAILED" || run.status === "INCOMPLETE" || run.status === "REJECTED_BY_CAPACITY";
  const canRetry = run.status === "FAILED" || run.status === "INCOMPLETE";
  const retryNeedsConfirmation = run.cleanupStatus === "FAILED";
  const canCancel = run.status === "QUEUED" || run.status === "PLANNING" || run.status === "EXECUTING" || run.status === "ANALYZING" || run.status === "REPORTING";
  return (
    <section className="panel operations-panel" aria-labelledby="operations-title">
      <div className="panel-heading"><div><p className="eyebrow">OPERATIONS</p><h2 id="operations-title">失败与清理</h2></div></div>
      <div className="operation-row">
        <span className="operation-label">运行结果</span>
        <span className={`operation-value operation-value--${isFailure ? "danger" : run.status === "PASSED" ? "success" : "neutral"}`}>{run.verdict ? run.verdict : runStatusLabel(run.status)}</span>
      </div>
      <div className="operation-row">
        <span className="operation-label">资源清理</span>
        <span className={`operation-value operation-value--${cleanupTone}`}>{cleanupStatusLabel(run.cleanupStatus)}</span>
      </div>
      {run.namespace ? <div className="operation-row"><span className="operation-label">Namespace</span><code className="operation-code">{run.namespace}</code></div> : null}
      {run.cleanupAt ? <div className="operation-row"><span className="operation-label">清理时间</span><span className="operation-text">{formatTimestamp(run.cleanupAt)}</span></div> : null}
      {run.cleanupError ? <div className="failure-box"><strong>清理错误</strong><p>{run.cleanupError}</p></div> : null}
      {isFailure && !run.cleanupError ? <div className="failure-box"><strong>此运行未通过</strong><p>页面只展示 API 已确认的状态，不把失败或未完成解释为通过。</p></div> : null}
      {actionError ? <div className="failure-box" role="alert"><strong>操作失败</strong><p>{actionError}</p></div> : null}
      {canRetry || canCancel ? (
        <div className="operation-actions">
          {canRetry && run.cleanupStatus === "CLEANED" ? <button className="button button--secondary" type="button" disabled={action !== undefined} onClick={() => onAction("retry")}>{action === "retry" ? "正在重新排队" : "重新运行"}</button> : null}
          {canRetry && retryNeedsConfirmation ? <button className="button button--secondary" type="button" disabled={action !== undefined} onClick={() => onAction("retry-after-cleanup-failure")}>{action === "retry-after-cleanup-failure" ? "正在重新排队" : "确认清理后重试"}</button> : null}
          {canCancel ? <button className="button button--danger" type="button" disabled={action !== undefined} onClick={() => onAction("cancel")}>{action === "cancel" ? "正在请求取消" : "取消运行"}</button> : null}
        </div>
      ) : null}
    </section>
  );
}

function DetailView({ state, action, actionError, onAction }: { state: DetailState; action: RunAction | undefined; actionError: string | undefined; onAction: (action: RunAction) => void }) {
  if (state.status !== "ready") {
    if (state.status === "error") {
      return <div className="detail-empty detail-empty--error" role="alert"><div className="state-icon state-icon--danger" aria-hidden="true">!</div><strong>运行详情不可用</strong><p>{errorMessage(state.error)}</p></div>;
    }
    return <div className="detail-empty"><div className="loading-mark" aria-hidden="true" /><p>正在加载运行详情</p></div>;
  }
  return (
    <div className="detail-content">
      <RunHeader run={state.run} />
      <div className="detail-grid">
        <div className="detail-main"><TimelinePanel resource={state.steps} /><LogsPanel resource={state.logs} /><ReportPanel resource={state.report} /></div>
        <div className="detail-side"><PreviewPanel resource={state.preview} /><OperationsPanel run={state.run} action={action} actionError={actionError} onAction={onAction} /></div>
      </div>
    </div>
  );
}

function Workbench({ user, runsState, detailState, selectedRunId, onSelect, onRefresh, onRetry, action, actionError, onAction }: {
  user: User;
  runsState: RunsState;
  detailState: DetailState;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRefresh: () => void;
  onRetry: () => void;
  action: RunAction | undefined;
  actionError: string | undefined;
  onAction: (action: RunAction) => void;
}) {
  const userLabel = user.displayName ?? user.username ?? "已登录用户";
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">PR</span><span>RUNWAY</span></div>
        <div className="topbar-actions"><span className="user-label">{userLabel}</span><button className="icon-button" type="button" onClick={onRefresh} aria-label="刷新运行列表" title="刷新运行列表">↻</button></div>
      </header>
      <div className="workspace-grid">
        <RunList state={runsState} selectedRunId={selectedRunId} onSelect={onSelect} />
        <section className="detail-pane" aria-label="运行详情"><DetailView state={detailState} action={action} actionError={actionError} onAction={onAction} /></section>
      </div>
      {runsState.status === "error" ? <div className="bottom-notice" role="alert"><span>{errorMessage(runsState.error)}</span><button className="text-button" type="button" onClick={onRetry}>重试</button></div> : null}
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [runsState, setRunsState] = useState<RunsState>({ status: "idle" });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle" });
  const [runAction, setRunAction] = useState<{ runId: string; action: RunAction } | null>(null);
  const [runActionError, setRunActionError] = useState<string | undefined>();
  const runsRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadSession = useCallback(async () => {
    setSession({ status: "loading" });
    try {
      const user = await getSession();
      if (user === null) {
        setSession({ status: "unauthenticated" });
        return;
      }
      setSession({ status: "authenticated", user });
    } catch (error) {
      const apiError = normalizeError(error);
      if (apiError.code === "AUTH_REQUIRED") setSession({ status: "unauthenticated" });
      else setSession({ status: "error", error: apiError });
    }
  }, []);

  const loadRuns = useCallback(async () => {
    const requestId = ++runsRequestId.current;
    setRunsState({ status: "loading" });
    try {
      const runs = await getRuns();
      if (requestId !== runsRequestId.current) return;
      setRunsState({ status: "ready", data: runs });
      setSelectedRunId((current) => (current && runs.some((run) => run.id === current) ? current : runs[0]?.id ?? null));
      if (runs.length === 0) setDetailState({ status: "idle" });
    } catch (error) {
      if (requestId !== runsRequestId.current) return;
      const apiError = normalizeError(error);
      if (apiError.code === "AUTH_REQUIRED") {
        setSession({ status: "unauthenticated" });
        setRunsState({ status: "idle" });
        setDetailState({ status: "idle" });
      } else setRunsState({ status: "error", error: apiError });
    }
  }, []);

  const loadDetail = useCallback(async (runId: string) => {
    const requestId = ++detailRequestId.current;
    setDetailState({ status: "loading" });
    try {
      const run = await getRun(runId);
      if (requestId !== detailRequestId.current) return;
      setDetailState({
        status: "ready",
        run,
        steps: { status: "loading" },
        logs: { status: "loading" },
        report: { status: "loading" },
        preview: { status: "loading" },
      });
      const results = await Promise.allSettled([getSteps(runId), getLogs(runId), getReport(runId), getPreview(runId, run.previewHost)]);
      if (requestId !== detailRequestId.current) return;
      const toResource = <T,>(result: PromiseSettledResult<T>): ResourceState<T> => result.status === "fulfilled" ? { status: "ready", data: result.value } : { status: "error", error: normalizeError(result.reason) };
      setDetailState({ status: "ready", run, steps: toResource(results[0]), logs: toResource(results[1]), report: toResource(results[2]), preview: toResource(results[3]) });
    } catch (error) {
      if (requestId === detailRequestId.current) setDetailState({ status: "error", error: normalizeError(error) });
    }
  }, []);

  const performRunAction = useCallback(async (runId: string, action: RunAction) => {
    const csrfToken = session.status === "authenticated" ? session.user.csrfToken : undefined;
    if (!csrfToken) {
      setRunActionError("当前会话没有可用的 CSRF 凭证，请刷新登录状态。");
      return;
    }
    if (action === "cancel" && !window.confirm("确认取消这次运行吗？平台仍会执行资源清理。")) return;
    if (action === "retry-after-cleanup-failure" && !window.confirm("清理上一次运行失败，残留资源可能仍存在。确认由人工承担风险并重试吗？")) return;
    setRunAction({ runId, action });
    setRunActionError(undefined);
    try {
      if (action === "retry" || action === "retry-after-cleanup-failure") await retryRun(runId, csrfToken, action === "retry-after-cleanup-failure");
      else await cancelRun(runId, csrfToken);
      await Promise.all([loadRuns(), loadDetail(runId)]);
    } catch (error) {
      const apiError = normalizeError(error);
      setRunActionError(errorMessage(apiError));
    } finally {
      setRunAction(null);
    }
  }, [loadDetail, loadRuns, session]);

  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => { if (session.status === "authenticated") void loadRuns(); }, [loadRuns, session.status]);
  useEffect(() => { if (session.status === "authenticated" && selectedRunId) void loadDetail(selectedRunId); }, [loadDetail, selectedRunId, session.status]);

  if (session.status === "loading") return <LoadingScreen />;
  if (session.status === "unauthenticated") return <LoginScreen onRetry={loadSession} />;
  if (session.status === "error") return <ErrorStage error={session.error} onRetry={loadSession} />;
  const selectedAction = runAction && selectedRunId === runAction.runId ? runAction.action : undefined;
  return <Workbench user={session.user} runsState={runsState} detailState={detailState} selectedRunId={selectedRunId} onSelect={setSelectedRunId} onRefresh={loadRuns} onRetry={loadRuns} action={selectedAction} actionError={runActionError} onAction={(action) => { if (selectedRunId) void performRunAction(selectedRunId, action); }} />;
}
