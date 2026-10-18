CREATE TABLE "sam_node_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"position" integer NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sam_node_messages" ADD CONSTRAINT "sam_node_messages_session_id_sam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sam_node_messages_session_position_idx" ON "sam_node_messages" USING btree ("session_id","position");