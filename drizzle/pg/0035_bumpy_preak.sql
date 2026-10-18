CREATE TABLE "workflow_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow" text NOT NULL,
	"instance_id" text NOT NULL,
	"params" text NOT NULL,
	"status" text NOT NULL,
	"error_name" text,
	"error_message" text,
	"output" text,
	"wake_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_pk" text NOT NULL,
	"name" text NOT NULL,
	"result" text,
	"wake_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_instance_pk_workflow_instances_id_fk" FOREIGN KEY ("instance_pk") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_instances_workflow_instance_idx" ON "workflow_instances" USING btree ("workflow","instance_id");--> statement-breakpoint
CREATE INDEX "workflow_instances_status_idx" ON "workflow_instances" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_instance_name_idx" ON "workflow_steps" USING btree ("instance_pk","name");