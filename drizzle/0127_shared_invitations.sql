CREATE TABLE "shared_invitation_uses" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"used_by" text,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_by" text,
	"village_id" text,
	"max_uses" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "shared_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "shared_invitations_label_check" CHECK (char_length("shared_invitations"."label") BETWEEN 1 AND 80),
	CONSTRAINT "shared_invitations_max_uses_check" CHECK ("shared_invitations"."max_uses" BETWEEN 1 AND 100),
	CONSTRAINT "shared_invitations_used_count_check" CHECK ("shared_invitations"."used_count" BETWEEN 0 AND "shared_invitations"."max_uses")
);
--> statement-breakpoint
ALTER TABLE "shared_invitation_uses" ADD CONSTRAINT "shared_invitation_uses_link_id_shared_invitations_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."shared_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_invitations" ADD CONSTRAINT "shared_invitations_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_invitation_uses_link_user_idx" ON "shared_invitation_uses" USING btree ("link_id","used_by") WHERE "shared_invitation_uses"."used_by" is not null;--> statement-breakpoint
CREATE INDEX "shared_invitation_uses_used_by_idx" ON "shared_invitation_uses" USING btree ("used_by") WHERE "shared_invitation_uses"."used_by" is not null;--> statement-breakpoint
CREATE INDEX "shared_invitation_uses_link_used_at_idx" ON "shared_invitation_uses" USING btree ("link_id","used_at");--> statement-breakpoint
CREATE INDEX "shared_invitations_created_by_idx" ON "shared_invitations" USING btree ("created_by","created_at");