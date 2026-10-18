CREATE TABLE `workflow_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow` text NOT NULL,
	`instance_id` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`error_name` text,
	`error_message` text,
	`output` text,
	`wake_at` integer,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_instances_workflow_instance_idx` ON `workflow_instances` (`workflow`,`instance_id`);--> statement-breakpoint
CREATE INDEX `workflow_instances_status_idx` ON `workflow_instances` (`status`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_pk` text NOT NULL,
	`name` text NOT NULL,
	`result` text,
	`wake_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`instance_pk`) REFERENCES `workflow_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_steps_instance_name_idx` ON `workflow_steps` (`instance_pk`,`name`);