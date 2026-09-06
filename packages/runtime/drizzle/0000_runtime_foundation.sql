CREATE TABLE `runtime_migration_smoke` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`applied` integer DEFAULT 1 NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO `runtime_migration_smoke` (`singleton`, `applied`) VALUES (1, 1);
