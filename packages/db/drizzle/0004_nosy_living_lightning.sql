UPDATE "findings" SET "expires_at" = now() + interval '7 days' WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "expires_at" DROP NOT NULL;
