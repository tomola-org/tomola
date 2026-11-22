ALTER TABLE "chat_message_translations" DROP CONSTRAINT "chat_message_translations_lang_check";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_lang_check";--> statement-breakpoint
ALTER TABLE "chat_report_snapshots" DROP CONSTRAINT "chat_report_snapshots_lang_check";--> statement-breakpoint
ALTER TABLE "chat_translation_reports" DROP CONSTRAINT "chat_translation_reports_lang_check";--> statement-breakpoint
ALTER TABLE "chat_translation_reports" DROP CONSTRAINT "chat_translation_reports_source_lang_check";--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entries_lang_check";--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entries_author_area_check";--> statement-breakpoint
ALTER TABLE "figure_translations" DROP CONSTRAINT "figure_translations_lang_check";--> statement-breakpoint
ALTER TABLE "invitation_note_translations" DROP CONSTRAINT "invitation_note_translations_lang_check";--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_note_lang_check";--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_home_area_check";--> statement-breakpoint
ALTER TABLE "reading_counts" DROP CONSTRAINT "reading_counts_source_lang_check";--> statement-breakpoint
ALTER TABLE "reading_counts" DROP CONSTRAINT "reading_counts_read_lang_check";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_chat_lang_check";--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_lang_check";--> statement-breakpoint
ALTER TABLE "stance_changes" DROP CONSTRAINT "stance_changes_trigger_area_check";--> statement-breakpoint
ALTER TABLE "stance_changes" DROP CONSTRAINT "stance_changes_area_check";--> statement-breakpoint
ALTER TABLE "stances" DROP CONSTRAINT "stances_area_check";--> statement-breakpoint
ALTER TABLE "translations" DROP CONSTRAINT "translations_lang_check";--> statement-breakpoint
ALTER TABLE "village_translations" DROP CONSTRAINT "village_translations_lang_check";--> statement-breakpoint
ALTER TABLE "villages" DROP CONSTRAINT "villages_language_check";--> statement-breakpoint
ALTER TABLE "villages" DROP CONSTRAINT "villages_source_lang_check";--> statement-breakpoint
ALTER TABLE "votes" DROP CONSTRAINT "votes_voter_area_check";--> statement-breakpoint
ALTER TABLE "chat_message_translations" ADD CONSTRAINT "chat_message_translations_lang_check" CHECK ("chat_message_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_lang_check" CHECK ("chat_messages"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "chat_report_snapshots" ADD CONSTRAINT "chat_report_snapshots_lang_check" CHECK ("chat_report_snapshots"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "chat_translation_reports" ADD CONSTRAINT "chat_translation_reports_lang_check" CHECK ("chat_translation_reports"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "chat_translation_reports" ADD CONSTRAINT "chat_translation_reports_source_lang_check" CHECK ("chat_translation_reports"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_lang_check" CHECK ("entries"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_author_area_check" CHECK ("entries"."author_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "figure_translations" ADD CONSTRAINT "figure_translations_lang_check" CHECK ("figure_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "invitation_note_translations" ADD CONSTRAINT "invitation_note_translations_lang_check" CHECK ("invitation_note_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_note_lang_check" CHECK ("invitations"."note_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_home_area_check" CHECK ("profiles"."home_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "reading_counts" ADD CONSTRAINT "reading_counts_source_lang_check" CHECK ("reading_counts"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "reading_counts" ADD CONSTRAINT "reading_counts_read_lang_check" CHECK ("reading_counts"."read_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_chat_lang_check" CHECK (("reports"."chat_message_id" IS NULL AND "reports"."chat_lang" IS NULL AND "reports"."chat_author_id" IS NULL) OR ("reports"."chat_message_id" IS NOT NULL AND "reports"."chat_lang" IS NOT NULL AND "reports"."chat_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es')));--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_lang_check" CHECK (("roles"."role" = 'operator' and "roles"."lang" is null) or ("roles"."role" = 'moderator' and "roles"."lang" is not null and "roles"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es')));--> statement-breakpoint
ALTER TABLE "stance_changes" ADD CONSTRAINT "stance_changes_trigger_area_check" CHECK ("stance_changes"."trigger_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "stance_changes" ADD CONSTRAINT "stance_changes_area_check" CHECK ("stance_changes"."area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "stances" ADD CONSTRAINT "stances_area_check" CHECK ("stances"."area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_lang_check" CHECK ("translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "village_translations" ADD CONSTRAINT "village_translations_lang_check" CHECK ("village_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_language_check" CHECK ("villages"."language" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_source_lang_check" CHECK ("villages"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es'));--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_area_check" CHECK ("votes"."voter_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'id', 'es', 'other'));