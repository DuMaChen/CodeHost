CREATE TYPE "public"."cleanup_status" AS ENUM('NOT_SCHEDULED', 'PENDING', 'CLEANED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."k8s_resource_phase" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DELETING', 'DELETED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."pull_request_state" AS ENUM('OPEN', 'CLOSED', 'MERGED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('RECEIVED', 'QUEUED', 'PLANNING', 'EXECUTING', 'ANALYZING', 'REPORTING', 'PASSED', 'FAILED', 'INCOMPLETE', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED_BY_CAPACITY');--> statement-breakpoint
CREATE TYPE "public"."run_step_status" AS ENUM('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED', 'INCOMPLETE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."run_verdict" AS ENUM('PASSED', 'FAILED', 'INCOMPLETE');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'FAILED', 'REPLAY_REJECTED');--> statement-breakpoint

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gitea_user_id" bigint,
	"action" varchar(128) NOT NULL,
	"entity_type" varchar(128) NOT NULL,
	"entity_id" varchar(255),
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_gitea_user_id_positive_ck" CHECK ("audit_events"."gitea_user_id" is null or "audit_events"."gitea_user_id" > 0),
	CONSTRAINT "audit_events_expiry_after_creation_ck" CHECK ("audit_events"."expires_at" > "audit_events"."created_at")
);--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"category" varchar(128) NOT NULL,
	"file_path" varchar(1024) NOT NULL,
	"line_start" integer NOT NULL,
	"line_end" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"evidence" text NOT NULL,
	"fingerprint" varchar(128),
	"source" varchar(128) NOT NULL,
	"confidence" real NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "findings_report_fingerprint_uid" UNIQUE("report_id","fingerprint"),
	CONSTRAINT "findings_line_start_positive_ck" CHECK ("findings"."line_start" >= 1),
	CONSTRAINT "findings_line_end_positive_ck" CHECK ("findings"."line_end" >= 1),
	CONSTRAINT "findings_line_range_ck" CHECK ("findings"."line_start" <= "findings"."line_end"),
	CONSTRAINT "findings_confidence_range_ck" CHECK ("findings"."confidence" >= 0 and "findings"."confidence" <= 1)
);--> statement-breakpoint
CREATE TABLE "gitea_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"head_sha" varchar(128) NOT NULL,
	"context" varchar(255) NOT NULL,
	"external_status_id" bigint,
	"comment_id" bigint,
	"last_sync_error" text,
	"synced_at" timestamp with time zone,
	CONSTRAINT "gitea_syncs_run_context_uid" UNIQUE("run_id","context"),
	CONSTRAINT "gitea_syncs_attempt_positive_ck" CHECK ("gitea_syncs"."attempt" >= 1),
	CONSTRAINT "gitea_syncs_external_status_positive_ck" CHECK ("gitea_syncs"."external_status_id" is null or "gitea_syncs"."external_status_id" > 0),
	CONSTRAINT "gitea_syncs_comment_positive_ck" CHECK ("gitea_syncs"."comment_id" is null or "gitea_syncs"."comment_id" > 0)
);--> statement-breakpoint
CREATE TABLE "k8s_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"step_key" varchar(128) NOT NULL,
	"namespace" varchar(253) NOT NULL,
	"kind" varchar(128) NOT NULL,
	"name" varchar(253) NOT NULL,
	"uid" varchar(128),
	"phase" "k8s_resource_phase" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "k8s_resources_run_attempt_step_kind_name_uid" UNIQUE("run_id","attempt","step_key","kind","name"),
	CONSTRAINT "k8s_resources_attempt_positive_ck" CHECK ("k8s_resources"."attempt" >= 1)
);--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"external_number" integer NOT NULL,
	"head_sha" varchar(128) NOT NULL,
	"base_sha" varchar(128) NOT NULL,
	"source_branch" varchar(512) NOT NULL,
	"title" text NOT NULL,
	"author" varchar(255) NOT NULL,
	"state" "pull_request_state" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_repository_number_uid" UNIQUE("repository_id","external_number"),
	CONSTRAINT "pull_requests_id_repository_uid" UNIQUE("id","repository_id"),
	CONSTRAINT "pull_requests_external_number_positive_ck" CHECK ("pull_requests"."external_number" > 0)
);--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"head_sha" varchar(128) NOT NULL,
	"provider" varchar(128) NOT NULL,
	"model" varchar(255) NOT NULL,
	"input_hash" char(64) NOT NULL,
	"verdict" "run_verdict" NOT NULL,
	"summary" text NOT NULL,
	"report_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "reports_run_attempt_uid" UNIQUE("run_id","attempt"),
	CONSTRAINT "reports_attempt_positive_ck" CHECK ("reports"."attempt" >= 1)
);--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_repo_id" bigint NOT NULL,
	"owner" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"full_name" varchar(512) NOT NULL,
	"default_branch" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_provider_repo_id_positive_ck" CHECK ("repositories"."provider_repo_id" > 0)
);--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"step_key" varchar(128) NOT NULL,
	"status" "run_step_status" DEFAULT 'PENDING' NOT NULL,
	"k8s_kind" varchar(128),
	"k8s_name" varchar(253),
	"exit_code" integer,
	"log_path" varchar(1024),
	"artifact_digest" varchar(512),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" varchar(128),
	"expires_at" timestamp with time zone,
	CONSTRAINT "run_steps_run_attempt_step_uid" UNIQUE("run_id","attempt","step_key"),
	CONSTRAINT "run_steps_attempt_positive_ck" CHECK ("run_steps"."attempt" >= 1),
	CONSTRAINT "run_steps_exit_code_nonnegative_ck" CHECK ("run_steps"."exit_code" is null or "run_steps"."exit_code" >= 0)
);--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"head_sha" varchar(128) NOT NULL,
	"trigger" varchar(64) NOT NULL,
	"status" "run_status" DEFAULT 'RECEIVED' NOT NULL,
	"verdict" "run_verdict",
	"namespace" varchar(253),
	"preview_host" varchar(512),
	"execution_plan_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_version" varchar(64) NOT NULL,
	"current_attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cleanup_at" timestamp with time zone,
	"cleanup_status" "cleanup_status" DEFAULT 'NOT_SCHEDULED' NOT NULL,
	"cleanup_error" text,
	"preview_expires_at" timestamp with time zone,
	"logs_expires_at" timestamp with time zone,
	"reports_expires_at" timestamp with time zone,
	"registry_ref" varchar(1024),
	"registry_expires_at" timestamp with time zone,
	"error_code" varchar(128),
	CONSTRAINT "runs_repository_pull_request_head_uid" UNIQUE("repository_id","pull_request_id","head_sha"),
	CONSTRAINT "runs_current_attempt_positive_ck" CHECK ("runs"."current_attempt" >= 1)
);--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gitea_user_id" bigint NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_gitea_user_id_positive_ck" CHECK ("sessions"."gitea_user_id" > 0),
	CONSTRAINT "sessions_expiry_after_creation_ck" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_delivery_id" varchar(255) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"repository_id" uuid,
	"payload_hash" char(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" text,
	"status" "webhook_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "webhook_events_retry_count_nonnegative_ck" CHECK ("webhook_events"."retry_count" >= 0)
);--> statement-breakpoint
CREATE TABLE "workflow_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"step_key" varchar(128) NOT NULL,
	"queue_name" varchar(128) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"dedupe_key" varchar(512) NOT NULL,
	"last_error" text,
	CONSTRAINT "workflow_outbox_run_attempt_step_queue_uid" UNIQUE("run_id","attempt","step_key","queue_name"),
	CONSTRAINT "workflow_outbox_attempt_positive_ck" CHECK ("workflow_outbox"."attempt" >= 1),
	CONSTRAINT "workflow_outbox_attempts_nonnegative_ck" CHECK ("workflow_outbox"."attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD CONSTRAINT "gitea_syncs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "k8s_resources" ADD CONSTRAINT "k8s_resources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_pull_request_repository_fk" FOREIGN KEY ("pull_request_id","repository_id") REFERENCES "public"."pull_requests"("id","repository_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_outbox" ADD CONSTRAINT "workflow_outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_expiry_idx" ON "audit_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "findings_report_severity_idx" ON "findings" USING btree ("report_id","severity");--> statement-breakpoint
CREATE INDEX "findings_expires_idx" ON "findings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "gitea_syncs_run_attempt_idx" ON "gitea_syncs" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX "k8s_resources_run_phase_idx" ON "k8s_resources" USING btree ("run_id","phase");--> statement-breakpoint
CREATE INDEX "pull_requests_repository_updated_idx" ON "pull_requests" USING btree ("repository_id","updated_at");--> statement-breakpoint
CREATE INDEX "reports_expires_idx" ON "reports" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_repo_id_uidx" ON "repositories" USING btree ("provider_repo_id");--> statement-breakpoint
CREATE INDEX "repositories_enabled_idx" ON "repositories" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "run_steps_run_status_idx" ON "run_steps" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_pull_request_uidx" ON "runs" USING btree ("repository_id","pull_request_id") WHERE "runs"."status" in ('PLANNING', 'EXECUTING', 'ANALYZING', 'REPORTING', 'CANCEL_REQUESTED');--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_cleanup_idx" ON "runs" USING btree ("cleanup_status","cleanup_at");--> statement-breakpoint
CREATE INDEX "runs_repository_pull_request_idx" ON "runs" USING btree ("repository_id","pull_request_id");--> statement-breakpoint
CREATE INDEX "sessions_gitea_user_idx" ON "sessions" USING btree ("gitea_user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_delivery_id_uidx" ON "webhook_events" USING btree ("provider_delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_idx" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_repository_idx" ON "webhook_events" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_outbox_dedupe_key_uidx" ON "workflow_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "workflow_outbox_available_idx" ON "workflow_outbox" USING btree ("status","available_at","lease_until");
