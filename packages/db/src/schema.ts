import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** pg-boss owns this schema and its migrations; Drizzle never manages it. */
export const PG_BOSS_SCHEMA = 'pgboss' as const;

export const pullRequestStateEnum = pgEnum('pull_request_state', [
  'OPEN',
  'CLOSED',
  'MERGED',
]);

export const webhookEventStatusEnum = pgEnum('webhook_event_status', [
  'RECEIVED',
  'PROCESSED',
  'FAILED',
  'REPLAY_REJECTED',
]);

export const outboxStatusEnum = pgEnum('outbox_status', [
  'PENDING',
  'PUBLISHED',
  'FAILED',
]);

export const giteaSyncStatusEnum = pgEnum('gitea_sync_status', [
  'PENDING',
  'SYNCED',
  'FAILED',
]);

export const runStatusEnum = pgEnum('run_status', [
  'RECEIVED',
  'QUEUED',
  'PLANNING',
  'EXECUTING',
  'ANALYZING',
  'REPORTING',
  'PASSED',
  'FAILED',
  'INCOMPLETE',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'REJECTED_BY_CAPACITY',
]);

export const runVerdictEnum = pgEnum('run_verdict', [
  'PASSED',
  'FAILED',
  'INCOMPLETE',
]);

export const cleanupStatusEnum = pgEnum('cleanup_status', [
  'NOT_SCHEDULED',
  'PENDING',
  'CLEANED',
  'FAILED',
]);

export const runStepStatusEnum = pgEnum('run_step_status', [
  'PENDING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'SKIPPED',
  'INCOMPLETE',
  'CANCELLED',
]);

export const k8sResourcePhaseEnum = pgEnum('k8s_resource_phase', [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'DELETING',
  'DELETED',
  'UNKNOWN',
]);

export const findingSeverityEnum = pgEnum('finding_severity', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull();

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull();

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerRepoId: bigint('provider_repo_id', { mode: 'number' }).notNull(),
    owner: varchar('owner', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 512 }).notNull(),
    defaultBranch: varchar('default_branch', { length: 255 }).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('repositories_provider_repo_id_uidx').on(table.providerRepoId),
    index('repositories_enabled_idx').on(table.enabled),
    check(
      'repositories_provider_repo_id_positive_ck',
      sql`${table.providerRepoId} > 0`,
    ),
  ],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    externalNumber: integer('external_number').notNull(),
    headSha: varchar('head_sha', { length: 128 }).notNull(),
    baseSha: varchar('base_sha', { length: 128 }).notNull(),
    sourceBranch: varchar('source_branch', { length: 512 }).notNull(),
    title: text('title').notNull(),
    author: varchar('author', { length: 255 }).notNull(),
    state: pullRequestStateEnum('state').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('pull_requests_repository_number_uid').on(
      table.repositoryId,
      table.externalNumber,
    ),
    unique('pull_requests_id_repository_uid').on(table.id, table.repositoryId),
    index('pull_requests_repository_updated_idx').on(
      table.repositoryId,
      table.updatedAt,
    ),
    check(
      'pull_requests_external_number_positive_ck',
      sql`${table.externalNumber} > 0`,
    ),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerDeliveryId: varchar('provider_delivery_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    externalNumber: integer('external_number').notNull(),
    headSha: varchar('head_sha', { length: 128 }).notNull(),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    errorMessage: text('error_message'),
    status: webhookEventStatusEnum('status').default('RECEIVED').notNull(),
    retryCount: integer('retry_count').default(0).notNull(),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_delivery_id_uidx').on(
      table.providerDeliveryId,
    ),
    index('webhook_events_status_received_idx').on(table.status, table.receivedAt),
    index('webhook_events_repository_idx').on(table.repositoryId),
    check(
      'webhook_events_retry_count_nonnegative_ck',
      sql`${table.retryCount} >= 0`,
    ),
    check(
      'webhook_events_external_number_positive_ck',
      sql`${table.externalNumber} > 0`,
    ),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    pullRequestId: uuid('pull_request_id').notNull(),
    headSha: varchar('head_sha', { length: 128 }).notNull(),
    trigger: varchar('trigger', { length: 64 }).notNull(),
    status: runStatusEnum('status').default('RECEIVED').notNull(),
    verdict: runVerdictEnum('verdict'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    namespace: varchar('namespace', { length: 253 }),
    previewHost: varchar('preview_host', { length: 512 }),
    executionPlanJson: jsonb('execution_plan_json')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    workflowVersion: varchar('workflow_version', { length: 64 }).notNull(),
    currentAttempt: integer('current_attempt').default(1).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    cleanupAt: timestamp('cleanup_at', { withTimezone: true, mode: 'date' }),
    cleanupStatus: cleanupStatusEnum('cleanup_status')
      .default('NOT_SCHEDULED')
      .notNull(),
    cleanupError: text('cleanup_error'),
    previewExpiresAt: timestamp('preview_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    logsExpiresAt: timestamp('logs_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    reportsExpiresAt: timestamp('reports_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    registryRef: varchar('registry_ref', { length: 1024 }),
    registryExpiresAt: timestamp('registry_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    errorCode: varchar('error_code', { length: 128 }),
  },
  (table) => [
    unique('runs_repository_pull_request_head_uid').on(
      table.repositoryId,
      table.pullRequestId,
      table.headSha,
    ),
    uniqueIndex('runs_one_active_per_pull_request_uidx')
      .on(table.repositoryId, table.pullRequestId)
      .where(
        sql`${table.status} in ('PLANNING', 'EXECUTING', 'ANALYZING', 'REPORTING', 'CANCEL_REQUESTED')`,
      ),
    index('runs_status_idx').on(table.status),
    index('runs_cleanup_idx').on(table.cleanupStatus, table.cleanupAt),
    index('runs_repository_pull_request_idx').on(
      table.repositoryId,
      table.pullRequestId,
    ),
    check(
      'runs_current_attempt_positive_ck',
      sql`${table.currentAttempt} >= 1`,
    ),
    foreignKey({
      name: 'runs_pull_request_repository_fk',
      columns: [table.pullRequestId, table.repositoryId],
      foreignColumns: [pullRequests.id, pullRequests.repositoryId],
    }).onDelete('restrict'),
  ],
);

export const workflowOutbox = pgTable(
  'workflow_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    stepKey: varchar('step_key', { length: 128 }).notNull(),
    queueName: varchar('queue_name', { length: 128 }).notNull(),
    payloadJson: jsonb('payload_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    status: outboxStatusEnum('status').default('PENDING').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').default(0).notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    dedupeKey: varchar('dedupe_key', { length: 512 }).notNull(),
    lastError: text('last_error'),
  },
  (table) => [
    unique('workflow_outbox_run_attempt_step_queue_uid').on(
      table.runId,
      table.attempt,
      table.stepKey,
      table.queueName,
    ),
    uniqueIndex('workflow_outbox_dedupe_key_uidx').on(table.dedupeKey),
    index('workflow_outbox_available_idx').on(
      table.status,
      table.availableAt,
      table.leaseUntil,
    ),
    check(
      'workflow_outbox_attempt_positive_ck',
      sql`${table.attempt} >= 1`,
    ),
    check(
      'workflow_outbox_attempts_nonnegative_ck',
      sql`${table.attempts} >= 0`,
    ),
    check(
      'workflow_outbox_dedupe_key_format_ck',
      sql`${table.dedupeKey} = ${table.runId}::text || ':' || ${table.stepKey} || ':' || ${table.attempt}::text`,
    ),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    stepKey: varchar('step_key', { length: 128 }).notNull(),
    status: runStepStatusEnum('status').default('PENDING').notNull(),
    k8sKind: varchar('k8s_kind', { length: 128 }),
    k8sName: varchar('k8s_name', { length: 253 }),
    exitCode: integer('exit_code'),
    logPath: varchar('log_path', { length: 1024 }),
    artifactDigest: varchar('artifact_digest', { length: 512 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    leaseToken: varchar('lease_token', { length: 64 }),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    failureKind: varchar('failure_kind', { length: 64 }),
    errorCode: varchar('error_code', { length: 128 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('run_steps_run_attempt_step_uid').on(
      table.runId,
      table.attempt,
      table.stepKey,
    ),
    index('run_steps_run_status_idx').on(table.runId, table.status),
    check(
      'run_steps_attempt_positive_ck',
      sql`${table.attempt} >= 1`,
    ),
    check(
      'run_steps_exit_code_nonnegative_ck',
      sql`${table.exitCode} is null or ${table.exitCode} >= 0`,
    ),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    headSha: varchar('head_sha', { length: 128 }).notNull(),
    provider: varchar('provider', { length: 128 }).notNull(),
    model: varchar('model', { length: 255 }).notNull(),
    inputHash: char('input_hash', { length: 64 }).notNull(),
    verdict: runVerdictEnum('verdict').notNull(),
    summary: text('summary').notNull(),
    reportJson: jsonb('report_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`now() + interval '7 days'`)
      .notNull(),
  },
  (table) => [
    unique('reports_run_attempt_uid').on(table.runId, table.attempt),
    index('reports_expires_idx').on(table.expiresAt),
    check(
      'reports_attempt_positive_ck',
      sql`${table.attempt} >= 1`,
    ),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    severity: findingSeverityEnum('severity').notNull(),
    category: varchar('category', { length: 128 }).notNull(),
    filePath: varchar('file_path', { length: 1024 }).notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    evidence: text('evidence').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }),
    source: varchar('source', { length: 128 }).notNull(),
    confidence: real('confidence').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`now() + interval '7 days'`)
      .notNull(),
  },
  (table) => [
    unique('findings_report_fingerprint_uid').on(table.reportId, table.fingerprint),
    index('findings_report_severity_idx').on(table.reportId, table.severity),
    index('findings_expires_idx').on(table.expiresAt),
    check(
      'findings_line_start_positive_ck',
      sql`${table.lineStart} >= 1`,
    ),
    check(
      'findings_line_end_positive_ck',
      sql`${table.lineEnd} >= 1`,
    ),
    check(
      'findings_line_range_ck',
      sql`${table.lineStart} <= ${table.lineEnd}`,
    ),
    check(
      'findings_confidence_range_ck',
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
  ],
);

export const giteaSyncs = pgTable(
  'gitea_syncs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    headSha: varchar('head_sha', { length: 128 }).notNull(),
    context: varchar('context', { length: 255 }).notNull(),
    artifactType: varchar('artifact_type', { length: 32 }).default('status').notNull(),
    desiredHash: char('desired_hash', { length: 64 }).default('').notNull(),
    desiredState: varchar('desired_state', { length: 32 }).default('failure').notNull(),
    desiredDescription: text('desired_description').default('').notNull(),
    desiredTargetUrl: varchar('desired_target_url', { length: 1024 }),
    desiredBody: text('desired_body').default('').notNull(),
    syncStatus: giteaSyncStatusEnum('sync_status').default('PENDING').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    externalStatusId: bigint('external_status_id', { mode: 'number' }),
    commentId: bigint('comment_id', { mode: 'number' }),
    lastSyncError: text('last_sync_error'),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('gitea_syncs_run_attempt_context_head_uid').on(table.runId, table.attempt, table.context, table.headSha),
    index('gitea_syncs_run_attempt_idx').on(table.runId, table.attempt),
    check(
      'gitea_syncs_attempt_positive_ck',
      sql`${table.attempt} >= 1`,
    ),
    check(
      'gitea_syncs_external_status_positive_ck',
      sql`${table.externalStatusId} is null or ${table.externalStatusId} > 0`,
    ),
    check(
      'gitea_syncs_comment_positive_ck',
      sql`${table.commentId} is null or ${table.commentId} > 0`,
    ),
    check(
      'gitea_syncs_attempts_nonnegative_ck',
      sql`${table.attempts} >= 0`,
    ),
  ],
);

export const k8sResources = pgTable(
  'k8s_resources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    stepKey: varchar('step_key', { length: 128 }).notNull(),
    namespace: varchar('namespace', { length: 253 }).notNull(),
    kind: varchar('kind', { length: 128 }).notNull(),
    name: varchar('name', { length: 253 }).notNull(),
    uid: varchar('uid', { length: 128 }),
    phase: k8sResourcePhaseEnum('phase').default('PENDING').notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('k8s_resources_run_attempt_step_kind_name_uid').on(
      table.runId,
      table.attempt,
      table.stepKey,
      table.kind,
      table.name,
    ),
    index('k8s_resources_run_phase_idx').on(table.runId, table.phase),
    check(
      'k8s_resources_attempt_positive_ck',
      sql`${table.attempt} >= 1`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    giteaUserId: bigint('gitea_user_id', { mode: 'number' }).notNull(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('sessions_gitea_user_idx').on(table.giteaUserId),
    index('sessions_expiry_idx').on(table.expiresAt),
    check(
      'sessions_gitea_user_id_positive_ck',
      sql`${table.giteaUserId} > 0`,
    ),
    check(
      'sessions_expiry_after_creation_ck',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const oauthStates = pgTable(
  'oauth_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    stateHash: char('state_hash', { length: 64 }).notNull(),
    nonceHash: char('nonce_hash', { length: 64 }).notNull(),
    browserBindingHash: char('browser_binding_hash', { length: 64 }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('oauth_states_state_hash_uidx').on(table.stateHash),
    index('oauth_states_expiry_idx').on(table.expiresAt),
    check(
      'oauth_states_expiry_after_creation_ck',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    giteaUserId: bigint('gitea_user_id', { mode: 'number' }),
    action: varchar('action', { length: 128 }).notNull(),
    entityType: varchar('entity_type', { length: 128 }).notNull(),
    entityId: varchar('entity_id', { length: 255 }),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`now() + interval '30 days'`)
      .notNull(),
  },
  (table) => [
    index('audit_events_created_idx').on(table.createdAt),
    index('audit_events_entity_idx').on(table.entityType, table.entityId),
    index('audit_events_expiry_idx').on(table.expiresAt),
    check(
      'audit_events_gitea_user_id_positive_ck',
      sql`${table.giteaUserId} is null or ${table.giteaUserId} > 0`,
    ),
    check(
      'audit_events_expiry_after_creation_ck',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const schema = {
  repositories,
  pullRequests,
  webhookEvents,
  workflowOutbox,
  runs,
  runSteps,
  reports,
  findings,
  giteaSyncs,
  k8sResources,
  sessions,
  oauthStates,
  auditEvents,
};

export function createWorkflowOutboxDedupeKey(
  runId: string,
  stepKey: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('workflow outbox attempt must be a positive integer');
  }
  return `${runId}:${stepKey}:${attempt}`;
}

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type PullRequest = typeof pullRequests.$inferSelect;
export type NewPullRequest = typeof pullRequests.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type WorkflowOutbox = typeof workflowOutbox.$inferSelect;
export type NewWorkflowOutbox = typeof workflowOutbox.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStep = typeof runSteps.$inferSelect;
export type NewRunStep = typeof runSteps.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type GiteaSync = typeof giteaSyncs.$inferSelect;
export type NewGiteaSync = typeof giteaSyncs.$inferInsert;
export type K8sResource = typeof k8sResources.$inferSelect;
export type NewK8sResource = typeof k8sResources.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
