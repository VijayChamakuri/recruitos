CREATE TABLE `run_input_snapshot` (
	`run_input_snapshot_id` text PRIMARY KEY NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`frozen_date` text NOT NULL,
	`rubric_version` text NOT NULL,
	`role_id` text NOT NULL,
	`extractor_version` text NOT NULL,
	`prompt_template_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_input_snapshot_content_json" CHECK(json_valid("run_input_snapshot"."content_json") AND json_type("run_input_snapshot"."content_json") = 'object'),
	CONSTRAINT "run_input_snapshot_content_hash" CHECK(length("run_input_snapshot"."content_hash") = 64 AND "run_input_snapshot"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "run_input_snapshot_frozen_date" CHECK(length("run_input_snapshot"."frozen_date") = 10
        AND "run_input_snapshot"."frozen_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "run_input_snapshot_rubric_version" CHECK(length("run_input_snapshot"."rubric_version") BETWEEN 1 AND 64),
	CONSTRAINT "run_input_snapshot_extractor_version" CHECK(length("run_input_snapshot"."extractor_version") BETWEEN 1 AND 64),
	CONSTRAINT "run_input_snapshot_prompt_template_version" CHECK(length("run_input_snapshot"."prompt_template_version") BETWEEN 1 AND 64),
	CONSTRAINT "run_input_snapshot_created_at" CHECK("run_input_snapshot"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `run_input_snapshot_content_hash_unique` ON `run_input_snapshot` (`content_hash`);--> statement-breakpoint
CREATE INDEX `run_input_snapshot_role` ON `run_input_snapshot` (`role_id`);--> statement-breakpoint
CREATE INDEX `run_input_snapshot_frozen_date` ON `run_input_snapshot` (`frozen_date`);--> statement-breakpoint
CREATE TRIGGER `run_input_snapshot_reject_replace`
BEFORE INSERT ON `run_input_snapshot`
WHEN EXISTS (
	SELECT 1
	FROM `run_input_snapshot`
	WHERE `run_input_snapshot_id` = NEW.`run_input_snapshot_id`
		OR `content_hash` = NEW.`content_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'run_input_snapshot is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `run_input_snapshot_reject_update`
BEFORE UPDATE ON `run_input_snapshot`
BEGIN
	SELECT RAISE(ABORT, 'run_input_snapshot is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `run_input_snapshot_reject_delete`
BEFORE DELETE ON `run_input_snapshot`
BEGIN
	SELECT RAISE(ABORT, 'run_input_snapshot is immutable');
END;
