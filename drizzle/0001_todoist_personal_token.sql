DELETE FROM "todoist_integration";--> statement-breakpoint
ALTER TABLE "todoist_integration" DROP COLUMN "access_token";--> statement-breakpoint
ALTER TABLE "todoist_integration" DROP COLUMN "refresh_token";--> statement-breakpoint
ALTER TABLE "todoist_integration" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "todoist_integration" DROP COLUMN "needs_reauth_at";--> statement-breakpoint
ALTER TABLE "todoist_integration" ADD COLUMN "api_key" text NOT NULL;
