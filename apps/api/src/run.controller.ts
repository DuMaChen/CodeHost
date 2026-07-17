import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  createWorkflowOutboxDedupeKey,
  reports,
  repositories,
  runSteps,
  runs,
  pullRequests,
  workflowOutbox,
} from '@platform/db';
import type { RunStatus } from '@platform/contracts';
import { hasRetryCapacity, isCancellableRunStatus, isRetryEligible } from './run-operations.js';
import { PLATFORM_CONFIG } from './tokens.js';
import {
  buildPreviewPortForwardCommand,
  buildPreviewSshTunnelCommand,
  parsePreviewServiceReference,
  type AppConfig,
} from '@platform/config';
import { DatabaseHandle, PLATFORM_DB } from './database.provider.js';
import { AuthService, type AuthenticatedSession } from './auth.service.js';
import { Inject } from '@nestjs/common';

const STEP_LABELS: Record<string, string> = {
  detect: '识别项目 Profile',
  fetch: '获取 Pull Request 源码',
  analyze: '静态分析与密钥扫描',
  test: '固定测试',
  build: '受控构建',
  preview: '创建 Preview',
  health: 'Preview 健康检查',
  'assemble-review-input': '组装审查输入',
  'agent-review': 'Agent 代码审查',
  report: '持久化质量报告',
  cleanup: '清理临时资源',
};

const WORKFLOW_QUEUE = 'platform.workflow';
const MAX_LOG_BYTES = 64 * 1024;

function validRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function truncateUtf8(value: string, maximumBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maximumBytes).toString('utf8'), truncated: true };
}

@Controller('/api/runs')
export class RunController {
  constructor(
    @Inject(PLATFORM_DB) private readonly database: DatabaseHandle,
    @Inject(PLATFORM_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  private async authorizedRepositories(cookie: string | undefined): Promise<{
    readonly session: AuthenticatedSession;
    readonly names: ReadonlySet<string>;
  }> {
    const session = await this.auth.require(cookie);
    const accessible = await this.auth.accessibleRepositories(session);
    const allowlist = new Set(this.config.giteaAllowedRepositories);
    const names = new Set<string>();
    for (const name of accessible) {
      if (allowlist.size === 0 || allowlist.has(name)) names.add(name);
    }
    if (names.size === 0) {
      await this.database.db.insert(auditEvents).values({
        giteaUserId: session.giteaUserId,
        action: 'RUN_READ_FORBIDDEN',
        entityType: 'runs',
        metadataJson: { reason: 'no-authorized-repositories' },
      });
      throw new ForbiddenException('repository read permission required');
    }
    return { session, names };
  }

  private async findRun(runId: string, cookie: string | undefined) {
    if (!validRunId(runId)) throw new NotFoundException('run not found');
    const { session, names } = await this.authorizedRepositories(cookie);
    if (names.size === 0) throw new NotFoundException('run not found');
    const rows = await this.database.db
      .select({
        id: runs.id,
        repositoryName: repositories.fullName,
        pullRequestNumber: pullRequests.externalNumber,
        title: pullRequests.title,
        author: pullRequests.author,
        headSha: runs.headSha,
        status: runs.status,
        verdict: runs.verdict,
        cleanupStatus: runs.cleanupStatus,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        currentAttempt: runs.currentAttempt,
        namespace: runs.namespace,
        previewHost: runs.previewHost,
        executionPlan: runs.executionPlanJson,
        cleanupAt: runs.cleanupAt,
        cleanupError: runs.cleanupError,
        previewExpiresAt: runs.previewExpiresAt,
      })
      .from(runs)
      .innerJoin(repositories, eq(runs.repositoryId, repositories.id))
      .innerJoin(pullRequests, eq(runs.pullRequestId, pullRequests.id))
      .where(and(eq(runs.id, runId), inArray(repositories.fullName, [...names])))
      .limit(1);
    const row = rows[0];
    if (!row) {
      try {
        const hidden = await this.findRunWithoutReadAuthorization(runId);
        await this.database.db.insert(auditEvents).values({
          giteaUserId: session.giteaUserId,
          action: 'RUN_READ_FORBIDDEN',
          entityType: 'run',
          entityId: hidden.id,
          metadataJson: { repository: hidden.repositoryName },
        });
        throw new ForbiddenException('repository read permission required');
      } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        if (!(error instanceof NotFoundException)) throw error;
      }
      throw new NotFoundException('run not found');
    }
    return row;
  }

  private async findRunWithoutReadAuthorization(runId: string) {
    if (!validRunId(runId)) throw new NotFoundException('run not found');
    const rows = await this.database.db
      .select({
        id: runs.id,
        repositoryName: repositories.fullName,
        pullRequestNumber: pullRequests.externalNumber,
        title: pullRequests.title,
        author: pullRequests.author,
        headSha: runs.headSha,
        status: runs.status,
        verdict: runs.verdict,
        cleanupStatus: runs.cleanupStatus,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        currentAttempt: runs.currentAttempt,
        namespace: runs.namespace,
        previewHost: runs.previewHost,
        cleanupAt: runs.cleanupAt,
        cleanupError: runs.cleanupError,
        previewExpiresAt: runs.previewExpiresAt,
      })
      .from(runs)
      .innerJoin(repositories, eq(runs.repositoryId, repositories.id))
      .innerJoin(pullRequests, eq(runs.pullRequestId, pullRequests.id))
      .where(eq(runs.id, runId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('run not found');
    return row;
  }

  private async requireMaintainer(
    runId: string,
    cookie: string | undefined,
    csrfToken: string | undefined,
  ) {
    const session = await this.auth.requireCsrf(cookie, csrfToken);
    const row = await this.findRunWithoutReadAuthorization(runId);
    const allowlist = new Set(this.config.giteaAllowedRepositories);
    const isAllowedRepository = allowlist.size === 0 || allowlist.has(row.repositoryName);
    const isMaintainer = isAllowedRepository && await this.auth.isRepositoryMaintainer(session, row.repositoryName);
    if (!isMaintainer) {
      await this.database.db.insert(auditEvents).values({
        giteaUserId: session.giteaUserId,
        action: 'RUN_MUTATION_FORBIDDEN',
        entityType: 'run',
        entityId: row.id,
        metadataJson: { repository: row.repositoryName },
      });
      throw new ForbiddenException('repository maintainer permission required');
    }
    return { session, row };
  }

  private summary(row: Awaited<ReturnType<RunController['findRun']>>) {
    return {
      id: row.id,
      repositoryName: row.repositoryName,
      pullRequestNumber: row.pullRequestNumber,
      title: row.title,
      author: row.author,
      headSha: row.headSha,
      status: row.status,
      verdict: row.verdict,
      executionPlan: row.executionPlan,
      cleanupStatus: row.cleanupStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  @Get()
  async list(@Headers('cookie') cookie: string | undefined) {
    const { names } = await this.authorizedRepositories(cookie);
    if (names.size === 0) return { runs: [] };
    const rows = await this.database.db
      .select({
        id: runs.id,
        repositoryName: repositories.fullName,
        pullRequestNumber: pullRequests.externalNumber,
        title: pullRequests.title,
        author: pullRequests.author,
        headSha: runs.headSha,
        status: runs.status,
        verdict: runs.verdict,
        cleanupStatus: runs.cleanupStatus,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .innerJoin(repositories, eq(runs.repositoryId, repositories.id))
      .innerJoin(pullRequests, eq(runs.pullRequestId, pullRequests.id))
      .where(inArray(repositories.fullName, [...names]))
      .orderBy(desc(runs.updatedAt))
      .limit(100);
    return {
      runs: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    };
  }

  @Get(':runId')
  async detail(@Param('runId') runId: string, @Headers('cookie') cookie: string | undefined) {
    const row = await this.findRun(runId, cookie);
    return {
      run: {
        ...this.summary(row),
        currentAttempt: row.currentAttempt,
        namespace: row.namespace,
        previewHost: row.previewHost,
        cleanupAt: row.cleanupAt?.toISOString(),
        cleanupError: row.cleanupError,
      },
    };
  }

  @Get(':runId/steps')
  async steps(@Param('runId') runId: string, @Headers('cookie') cookie: string | undefined) {
    const row = await this.findRun(runId, cookie);
    const records = await this.database.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, row.id), eq(runSteps.attempt, row.currentAttempt)))
      .orderBy(runSteps.id);
    return {
      steps: records.map((record) => ({
        stepKey: record.stepKey,
        label: STEP_LABELS[record.stepKey] ?? record.stepKey,
        status: record.status,
        startedAt: record.startedAt?.toISOString(),
        finishedAt: record.finishedAt?.toISOString(),
        durationMs: record.startedAt && record.finishedAt
          ? Math.max(0, record.finishedAt.getTime() - record.startedAt.getTime())
          : undefined,
        failureReason: record.errorCode ?? undefined,
      })),
    };
  }

  @Get(':runId/report')
  async report(@Param('runId') runId: string, @Headers('cookie') cookie: string | undefined) {
    const row = await this.findRun(runId, cookie);
    const records = await this.database.db
      .select({ report: reports.reportJson })
      .from(reports)
      .where(and(eq(reports.runId, row.id), eq(reports.attempt, row.currentAttempt), gt(reports.expiresAt, new Date())))
      .limit(1);
    return { report: records[0]?.report ?? null };
  }

  @Get(':runId/logs')
  async logs(@Param('runId') runId: string, @Headers('cookie') cookie: string | undefined) {
    const row = await this.findRun(runId, cookie);
    const records = await this.database.db
      .select({ stepKey: runSteps.stepKey, logPath: runSteps.logPath, expiresAt: runSteps.expiresAt })
      .from(runSteps)
      .where(and(
        eq(runSteps.runId, row.id),
        eq(runSteps.attempt, row.currentAttempt),
        gt(runSteps.expiresAt, new Date()),
      ))
      .orderBy(runSteps.id);

    const root = await realpath(resolve(this.config.logRoot)).catch(() => resolve(this.config.logRoot));
    const logs: Array<{ readonly stepKey: string; readonly label: string; readonly content: string; readonly truncated: boolean; readonly expiresAt?: string }> = [];
    for (const record of records) {
      if (record.logPath === null) continue;
      const candidate = resolve(record.logPath);
      try {
        const target = await realpath(candidate);
        const relativePath = relative(root, target);
        if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) continue;
        const content = truncateUtf8(await readFile(target, 'utf8'), MAX_LOG_BYTES);
        logs.push({
          stepKey: record.stepKey,
          label: STEP_LABELS[record.stepKey] ?? record.stepKey,
          content: content.value,
          truncated: content.truncated,
          ...(record.expiresAt === null ? {} : { expiresAt: record.expiresAt.toISOString() }),
        });
      } catch {
        logs.push({
          stepKey: record.stepKey,
          label: STEP_LABELS[record.stepKey] ?? record.stepKey,
          content: '[log unavailable]',
          truncated: false,
          ...(record.expiresAt === null ? {} : { expiresAt: record.expiresAt.toISOString() }),
        });
      }
    }
    return { logs };
  }

  @Post(':runId/retry')
  @HttpCode(202)
  async retry(
    @Param('runId') runId: string,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Headers('x-confirm-cleanup-failure') cleanupFailureConfirmation: string | undefined,
  ) {
    const { session, row } = await this.requireMaintainer(runId, cookie, csrfToken);
    const manuallyConfirmedCleanupFailure = cleanupFailureConfirmation === 'true';
    if (!isRetryEligible(row.status as RunStatus, row.cleanupStatus, manuallyConfirmedCleanupFailure)) {
      throw new ConflictException('run is not eligible for retry; cleanup must be confirmed');
    }

    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`platform:run:${row.id}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('platform:run-capacity', 0))`);
      const currentRows = await tx.select({
        id: runs.id,
        status: runs.status,
        cleanupStatus: runs.cleanupStatus,
        currentAttempt: runs.currentAttempt,
        headSha: runs.headSha,
      }).from(runs).where(eq(runs.id, row.id)).limit(1);
      const current = currentRows[0];
      if (!current || current.status !== row.status || current.cleanupStatus !== row.cleanupStatus || current.currentAttempt !== row.currentAttempt) {
        throw new ConflictException('run changed while retry was being requested');
      }
      if (!isRetryEligible(current.status as RunStatus, current.cleanupStatus, manuallyConfirmedCleanupFailure)) {
        throw new ConflictException('run is not eligible for retry; cleanup must be confirmed');
      }
      const activeRows = await tx.select({ count: sql<number>`count(*)` }).from(runs).where(inArray(runs.status, ['PLANNING', 'EXECUTING', 'ANALYZING', 'REPORTING', 'CANCEL_REQUESTED']));
      const active = Number(activeRows[0]?.count ?? 0);
      const queuedRows = await tx.select({ count: sql<number>`count(*)` }).from(runs).where(eq(runs.status, 'QUEUED'));
      const queued = Number(queuedRows[0]?.count ?? 0);
      if (!hasRetryCapacity(active, queued, this.config.maxQueuedRuns)) {
        throw new ConflictException('run queue is full');
      }
      const attempt = current.currentAttempt + 1;
      const updated = await tx.update(runs).set({
        status: 'QUEUED',
        verdict: null,
        currentAttempt: attempt,
        startedAt: null,
        finishedAt: null,
        cleanupAt: null,
        cleanupStatus: 'NOT_SCHEDULED',
        cleanupError: null,
        previewHost: null,
        previewExpiresAt: null,
        updatedAt: new Date(),
        errorCode: null,
      }).where(and(
        eq(runs.id, current.id),
        eq(runs.status, current.status),
        eq(runs.currentAttempt, current.currentAttempt),
        eq(runs.headSha, current.headSha),
      )).returning({ id: runs.id });
      if (updated.length !== 1) throw new ConflictException('run changed while retry was being requested');

      const stepKey = 'detect';
      await tx.insert(workflowOutbox).values({
        runId: current.id,
        attempt,
        stepKey,
        queueName: WORKFLOW_QUEUE,
        payloadJson: { runId: current.id, attempt, headSha: current.headSha, stepKey },
        dedupeKey: createWorkflowOutboxDedupeKey(current.id, stepKey, attempt),
      });
      await tx.insert(auditEvents).values({
        giteaUserId: session.giteaUserId,
        action: 'RUN_RETRIED',
        entityType: 'run',
        entityId: current.id,
        metadataJson: { previousAttempt: current.currentAttempt, attempt, headSha: current.headSha },
      });
      return { run: { id: current.id, status: 'QUEUED', currentAttempt: attempt, cleanupStatus: 'NOT_SCHEDULED' } };
    });
  }

  @Post(':runId/cancel')
  @HttpCode(202)
  async cancel(
    @Param('runId') runId: string,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
  ) {
    const { session, row } = await this.requireMaintainer(runId, cookie, csrfToken);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`platform:run:${row.id}`}, 0))`);
      const currentRows = await tx.select({
        id: runs.id,
        status: runs.status,
        cleanupStatus: runs.cleanupStatus,
        currentAttempt: runs.currentAttempt,
        headSha: runs.headSha,
      }).from(runs).where(eq(runs.id, row.id)).limit(1);
      const current = currentRows[0];
      if (!current) throw new NotFoundException('run not found');
      const enqueueCleanup = async (): Promise<void> => {
        const stepKey = 'cleanup';
        await tx.insert(workflowOutbox).values({
          runId: current.id,
          attempt: current.currentAttempt,
          stepKey,
          queueName: WORKFLOW_QUEUE,
          payloadJson: { runId: current.id, attempt: current.currentAttempt, headSha: current.headSha, stepKey },
          dedupeKey: createWorkflowOutboxDedupeKey(current.id, stepKey, current.currentAttempt),
        }).onConflictDoUpdate({
          target: workflowOutbox.dedupeKey,
          set: { status: 'PENDING', availableAt: new Date(), publishedAt: null, leaseUntil: null, lastError: null },
        });
      };
      if (current.status === 'CANCELLED') {
        return { run: { id: current.id, status: current.status, currentAttempt: current.currentAttempt, cleanupStatus: current.cleanupStatus } };
      }
      if (current.status === 'CANCEL_REQUESTED') {
        await enqueueCleanup();
        return { run: { id: current.id, status: current.status, currentAttempt: current.currentAttempt, cleanupStatus: current.cleanupStatus } };
      }
      if (!isCancellableRunStatus(current.status as RunStatus)) {
        throw new ConflictException('run cannot be cancelled in its current state');
      }
      await tx.update(runs).set({
        status: 'CANCEL_REQUESTED',
        cleanupStatus: 'PENDING',
        cleanupAt: null,
        cleanupError: null,
        updatedAt: new Date(),
      }).where(and(eq(runs.id, current.id), eq(runs.status, current.status), eq(runs.currentAttempt, current.currentAttempt), eq(runs.headSha, current.headSha)));
      await enqueueCleanup();
      await tx.insert(auditEvents).values({
        giteaUserId: session.giteaUserId,
        action: 'RUN_CANCEL_REQUESTED',
        entityType: 'run',
        entityId: current.id,
        metadataJson: { attempt: current.currentAttempt, headSha: current.headSha, previousStatus: current.status },
      });
      return { run: { id: current.id, status: 'CANCEL_REQUESTED', currentAttempt: current.currentAttempt, cleanupStatus: 'PENDING' } };
    });
  }

  @Get(':runId/preview')
  async preview(@Param('runId') runId: string, @Headers('cookie') cookie: string | undefined) {
    const row = await this.findRun(runId, cookie);
    if (!row.previewHost || !row.previewExpiresAt) return { preview: null };
    const expired = row.previewExpiresAt.getTime() <= Date.now();
    if (this.config.previewMode === 'ingress') {
      let url: URL;
      try {
        url = new URL(row.previewHost);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
      } catch {
        return { preview: null };
      }
      return {
        preview: {
          accessMode: this.config.previewMode,
          status: expired ? 'EXPIRED' : 'READY',
          url: expired ? undefined : url.toString(),
          expiresAt: row.previewExpiresAt.toISOString(),
        },
      };
    }

    const reference = parsePreviewServiceReference(row.previewHost);
    if (reference === undefined) {
      throw new ConflictException('stored Preview Service reference is invalid');
    }
    if (expired) {
      return {
        preview: {
          accessMode: this.config.previewMode,
          status: 'EXPIRED',
          expiresAt: row.previewExpiresAt.toISOString(),
        },
      };
    }

    try {
      if (this.config.previewMode === 'local') {
        return {
          preview: {
            accessMode: this.config.previewMode,
            status: 'READY',
            portForwardCommand: buildPreviewPortForwardCommand(reference),
            expiresAt: row.previewExpiresAt.toISOString(),
          },
        };
      }
      if (!this.config.previewSshHost || !this.config.previewSshUser) {
        throw new Error('SSH Preview is not configured; set PREVIEW_SSH_HOST and PREVIEW_SSH_USER');
      }
      return {
        preview: {
          accessMode: this.config.previewMode,
          status: 'READY',
          sshTunnelCommand: buildPreviewSshTunnelCommand(reference, {
            host: this.config.previewSshHost,
            user: this.config.previewSshUser,
            ...(this.config.previewSshPort === undefined ? {} : { port: this.config.previewSshPort }),
          }),
          expiresAt: row.previewExpiresAt.toISOString(),
        },
      };
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : 'Preview access configuration is invalid');
    }
  }
}
