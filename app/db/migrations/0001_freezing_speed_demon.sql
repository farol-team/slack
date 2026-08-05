CREATE TABLE "runner_connect_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"label" varchar(255),
	"userId" integer,
	"workspaceId" integer,
	"memberId" integer,
	"token" varchar(128),
	"approvedAt" timestamp,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runner_connect_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_unionId_unique";--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ALTER COLUMN "workspaceId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ADD COLUMN "kind" varchar(16) DEFAULT 'install' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ADD COLUMN "next" varchar(512);--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ADD COLUMN "nonce" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "provider" varchar(32) DEFAULT 'slack' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subject" varchar(255);--> statement-breakpoint
ALTER TABLE "runner_connect_codes" ADD CONSTRAINT "runner_connect_codes_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_subject_idx" ON "users" USING btree ("provider","subject");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "unionId";