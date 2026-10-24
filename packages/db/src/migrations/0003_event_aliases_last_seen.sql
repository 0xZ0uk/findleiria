CREATE TABLE `event_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_event_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_aliases_source_item_event_unique` ON `event_aliases` (`source`,`source_event_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `event_aliases_event_id_idx` ON `event_aliases` (`event_id`);--> statement-breakpoint
ALTER TABLE `event_sources` ADD `last_seen_at` integer;--> statement-breakpoint
UPDATE `event_sources` SET `last_seen_at` = CAST(strftime('%s', 'now') AS integer) WHERE `last_seen_at` IS NULL;
