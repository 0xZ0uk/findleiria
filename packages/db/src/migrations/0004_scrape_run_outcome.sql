ALTER TABLE `scrape_runs` ADD `items_discovered` integer;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `pages_fetched` integer;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `items_updated` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `items_pruned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `warnings` text;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `postpass_error` text;