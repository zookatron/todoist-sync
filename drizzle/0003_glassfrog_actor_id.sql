ALTER TABLE "glassfrog_integration" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "glassfrog_integration" DROP COLUMN "v3_api_key";--> statement-breakpoint
ALTER TABLE "glassfrog_integration" DROP COLUMN "v3_person_id";