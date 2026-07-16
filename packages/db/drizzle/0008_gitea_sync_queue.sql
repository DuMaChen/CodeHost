CREATE TYPE "public"."gitea_sync_status" AS ENUM('PENDING', 'SYNCED', 'FAILED');--> statement-breakpoint
ALTER TABLE "gitea_syncs" DROP CONSTRAINT "gitea_syncs_run_context_uid";--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "artifact_type" varchar(32) DEFAULT 'status' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "desired_hash" char(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "desired_state" varchar(32) DEFAULT 'failure' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "desired_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "desired_target_url" varchar(1024);--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "desired_body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "sync_status" "gitea_sync_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD CONSTRAINT "gitea_syncs_run_attempt_context_head_uid" UNIQUE("run_id","attempt","context","head_sha");--> statement-breakpoint
ALTER TABLE "gitea_syncs" ADD CONSTRAINT "gitea_syncs_attempts_nonnegative_ck" CHECK ("gitea_syncs"."attempts" >= 0);