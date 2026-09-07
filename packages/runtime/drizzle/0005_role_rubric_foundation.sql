CREATE TABLE `role` (
	`role_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "role_title" CHECK(length("role"."title") BETWEEN 1 AND 200),
	CONSTRAINT "role_created_at" CHECK("role"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `requirement` (
	`requirement_id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "requirement_kind" CHECK("requirement"."kind" IN ('hard', 'scored')),
	CONSTRAINT "requirement_description" CHECK(length("requirement"."description") BETWEEN 1 AND 2000),
	CONSTRAINT "requirement_created_at" CHECK("requirement"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `rubric` (
	`rubric_id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rubric_version" CHECK(length("rubric"."version") BETWEEN 1 AND 64),
	CONSTRAINT "rubric_created_at" CHECK("rubric"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `rubric_dimension` (
	`rubric_dimension_id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`weight` integer NOT NULL,
	`required` integer NOT NULL,
	`definition` text NOT NULL,
	`job_related_justification` text NOT NULL,
	`ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubric`(`rubric_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rubric_dimension_weight" CHECK("rubric_dimension"."weight" > 0),
	CONSTRAINT "rubric_dimension_required" CHECK("rubric_dimension"."required" IN (0, 1)),
	CONSTRAINT "rubric_dimension_definition" CHECK(length("rubric_dimension"."definition") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_job_related_justification" CHECK(length("rubric_dimension"."job_related_justification") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_ordinal" CHECK("rubric_dimension"."ordinal" >= 0),
	CONSTRAINT "rubric_dimension_created_at" CHECK("rubric_dimension"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_role_version_unique` ON `rubric` (`role_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_dimension_rubric_ordinal_unique` ON `rubric_dimension` (`rubric_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_dimension_rubric_dimension_id_unique` ON `rubric_dimension` (`rubric_id`,`dimension_id`);
--> statement-breakpoint
CREATE TRIGGER `role_reject_replace`
BEFORE INSERT ON `role`
WHEN EXISTS (
	SELECT 1
	FROM `role`
	WHERE `role_id` = NEW.`role_id`
)
BEGIN
	SELECT RAISE(ABORT, 'role is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `role_reject_update`
BEFORE UPDATE ON `role`
BEGIN
	SELECT RAISE(ABORT, 'role is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `role_reject_delete`
BEFORE DELETE ON `role`
BEGIN
	SELECT RAISE(ABORT, 'role is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `requirement_reject_replace`
BEFORE INSERT ON `requirement`
WHEN EXISTS (
	SELECT 1
	FROM `requirement`
	WHERE `requirement_id` = NEW.`requirement_id`
)
BEGIN
	SELECT RAISE(ABORT, 'requirement is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `requirement_reject_update`
BEFORE UPDATE ON `requirement`
BEGIN
	SELECT RAISE(ABORT, 'requirement is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `requirement_reject_delete`
BEFORE DELETE ON `requirement`
BEGIN
	SELECT RAISE(ABORT, 'requirement is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_reject_replace`
BEFORE INSERT ON `rubric`
WHEN EXISTS (
	SELECT 1
	FROM `rubric`
	WHERE `rubric_id` = NEW.`rubric_id`
		OR (`role_id` = NEW.`role_id` AND `version` = NEW.`version`)
)
BEGIN
	SELECT RAISE(ABORT, 'rubric is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_reject_update`
BEFORE UPDATE ON `rubric`
BEGIN
	SELECT RAISE(ABORT, 'rubric is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_reject_delete`
BEFORE DELETE ON `rubric`
BEGIN
	SELECT RAISE(ABORT, 'rubric is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_dimension_reject_replace`
BEFORE INSERT ON `rubric_dimension`
WHEN EXISTS (
	SELECT 1
	FROM `rubric_dimension`
	WHERE `rubric_dimension_id` = NEW.`rubric_dimension_id`
		OR (`rubric_id` = NEW.`rubric_id` AND `ordinal` = NEW.`ordinal`)
		OR (`rubric_id` = NEW.`rubric_id` AND `dimension_id` = NEW.`dimension_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'rubric_dimension is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_dimension_reject_update`
BEFORE UPDATE ON `rubric_dimension`
BEGIN
	SELECT RAISE(ABORT, 'rubric_dimension is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_dimension_reject_delete`
BEFORE DELETE ON `rubric_dimension`
BEGIN
	SELECT RAISE(ABORT, 'rubric_dimension is immutable');
END;
