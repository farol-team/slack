-- Idempotent on purpose. `memory_files` and `workspaces.storeFiles` were
-- applied to production by hand before a migration existed for them, so a
-- plain CREATE/ADD would fail there while still being needed for a fresh
-- database. This migration only catches the schema up with what shipped.
CREATE TABLE IF NOT EXISTS "memory_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspaceId" integer NOT NULL,
	"slackChannelId" varchar(64) NOT NULL,
	"slackFileId" varchar(64) NOT NULL,
	"name" varchar(512) NOT NULL,
	"mime" varchar(128),
	"bytes" integer DEFAULT 0 NOT NULL,
	"uri" varchar(1024) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_files_slackFileId_unique" UNIQUE("slackFileId")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "storeFiles" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_files" ADD CONSTRAINT "memory_files_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
