CREATE TABLE `sam_node_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sam_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sam_node_messages_session_position_idx` ON `sam_node_messages` (`session_id`,`position`);