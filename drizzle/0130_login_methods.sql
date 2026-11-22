CREATE TABLE "passkey_recovery_permits" (
	"user_id" text PRIMARY KEY NOT NULL,
	"recovery_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "passkey_recovery_permits_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "passkey_recoveries" ADD COLUMN "identity_verification" text;--> statement-breakpoint
ALTER TABLE "passkey_recoveries" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "passkey_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "login_method" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "reauthenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "reauthentication_method" text;--> statement-breakpoint
ALTER TABLE "passkey_recovery_permits" ADD CONSTRAINT "passkey_recovery_permits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_recovery_permits" ADD CONSTRAINT "passkey_recovery_permits_recovery_id_passkey_recoveries_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."passkey_recoveries"("id") ON DELETE cascade ON UPDATE no action;