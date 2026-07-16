CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" char(64) NOT NULL,
	"nonce_hash" char(64) NOT NULL,
	"browser_binding_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_states_expiry_after_creation_ck" CHECK ("oauth_states"."expires_at" > "oauth_states"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_hash_uidx" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_states_expiry_idx" ON "oauth_states" USING btree ("expires_at");