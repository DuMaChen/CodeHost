UPDATE "reports" SET "expires_at" = "created_at" + interval '7 days' WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
UPDATE "run_steps" SET "expires_at" = now() + interval '7 days' WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "external_number" integer;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "head_sha" varchar(128);--> statement-breakpoint
UPDATE "webhook_events" SET "external_number" = 1 WHERE "external_number" IS NULL;--> statement-breakpoint
UPDATE "webhook_events" SET "head_sha" = repeat('0', 40) WHERE "head_sha" IS NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "external_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "head_sha" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_external_number_positive_ck" CHECK ("webhook_events"."external_number" > 0);
