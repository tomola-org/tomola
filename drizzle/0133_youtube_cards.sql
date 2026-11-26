CREATE TABLE "entry_youtube_videos" (
	"entry_id" bigint NOT NULL,
	"video_id" text NOT NULL,
	"body_hash" text NOT NULL,
	CONSTRAINT "entry_youtube_videos_entry_id_video_id_pk" PRIMARY KEY("entry_id","video_id"),
	CONSTRAINT "entry_youtube_videos_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "youtube_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"channel" text,
	"width" integer,
	"height" integer,
	"bytes" "bytea",
	"refresh_after" timestamp with time zone NOT NULL,
	CONSTRAINT "youtube_videos_id_check" CHECK ("youtube_videos"."id" ~ '^[A-Za-z0-9_-]{11}$'),
	CONSTRAINT "youtube_videos_artwork_check" CHECK (num_nonnulls("youtube_videos"."title", "youtube_videos"."channel", "youtube_videos"."width", "youtube_videos"."height", "youtube_videos"."bytes") in (0, 5))
);
--> statement-breakpoint
CREATE INDEX "entry_youtube_videos_video_idx" ON "entry_youtube_videos" USING btree ("video_id","entry_id");
