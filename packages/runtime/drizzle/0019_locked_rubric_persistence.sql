-- Locked rubric persistence. SQLite cannot ALTER `version` from TEXT to
-- INTEGER, so `rubric` and `rubric_dimension` are rebuilt. Tests migrate
-- empty databases. Legacy `draft-v1` version strings map to 1, legacy
-- dimensions copy `definition` into each missing anchor, and legacy headers
-- are product-authored. Increment-1 writers insert the full locked shape.
DROP TRIGGER IF EXISTS `rubric_reject_replace`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rubric_reject_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rubric_reject_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rubric_dimension_reject_replace`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rubric_dimension_reject_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rubric_dimension_reject_delete`;
--> statement-breakpoint
CREATE TABLE `rubric__new` (
	`rubric_id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`version` integer NOT NULL,
	`provenance_authorship` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rubric_version" CHECK("rubric__new"."version" > 0),
	CONSTRAINT "rubric_provenance_authorship" CHECK("rubric__new"."provenance_authorship" IN ('product-authored', 'recruiter-validated')),
	CONSTRAINT "rubric_created_at" CHECK("rubric__new"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `rubric__new` (
	`rubric_id`,
	`role_id`,
	`version`,
	`provenance_authorship`,
	`created_at`
)
SELECT
	`rubric_id`,
	`role_id`,
	CASE
		WHEN `version` = 'draft-v1' THEN 1
		WHEN `version` GLOB '[1-9]*' AND `version` NOT GLOB '*[^0-9]*' THEN CAST(`version` AS INTEGER)
		ELSE 1
	END,
	'product-authored',
	`created_at`
FROM `rubric`;
--> statement-breakpoint
CREATE TABLE `rubric_dimension__new` (
	`rubric_dimension_id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`weight` integer NOT NULL,
	`required` integer NOT NULL,
	`definition` text NOT NULL,
	`job_related_justification` text NOT NULL,
	`level_anchor_none` text NOT NULL,
	`level_anchor_weak` text NOT NULL,
	`level_anchor_partial` text NOT NULL,
	`level_anchor_strong` text NOT NULL,
	`ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubric__new`(`rubric_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rubric_dimension_weight" CHECK("rubric_dimension__new"."weight" > 0),
	CONSTRAINT "rubric_dimension_required" CHECK("rubric_dimension__new"."required" IN (0, 1)),
	CONSTRAINT "rubric_dimension_definition" CHECK(length("rubric_dimension__new"."definition") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_job_related_justification" CHECK(length("rubric_dimension__new"."job_related_justification") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_none" CHECK(length("rubric_dimension__new"."level_anchor_none") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_weak" CHECK(length("rubric_dimension__new"."level_anchor_weak") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_partial" CHECK(length("rubric_dimension__new"."level_anchor_partial") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_strong" CHECK(length("rubric_dimension__new"."level_anchor_strong") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_ordinal" CHECK("rubric_dimension__new"."ordinal" >= 0),
	CONSTRAINT "rubric_dimension_created_at" CHECK("rubric_dimension__new"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `rubric_dimension__new` (
	`rubric_dimension_id`,
	`rubric_id`,
	`dimension_id`,
	`weight`,
	`required`,
	`definition`,
	`job_related_justification`,
	`level_anchor_none`,
	`level_anchor_weak`,
	`level_anchor_partial`,
	`level_anchor_strong`,
	`ordinal`,
	`created_at`
)
SELECT
	`rubric_dimension_id`,
	`rubric_id`,
	`dimension_id`,
	`weight`,
	`required`,
	`definition`,
	`job_related_justification`,
	`definition`,
	`definition`,
	`definition`,
	`definition`,
	`ordinal`,
	`created_at`
FROM `rubric_dimension`;
--> statement-breakpoint
DROP TABLE `rubric_dimension`;
--> statement-breakpoint
DROP TABLE `rubric`;
--> statement-breakpoint
ALTER TABLE `rubric__new` RENAME TO `rubric`;
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_role_version_unique` ON `rubric` (`role_id`,`version`);
--> statement-breakpoint
CREATE TABLE `rubric_dimension` (
	`rubric_dimension_id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`weight` integer NOT NULL,
	`required` integer NOT NULL,
	`definition` text NOT NULL,
	`job_related_justification` text NOT NULL,
	`level_anchor_none` text NOT NULL,
	`level_anchor_weak` text NOT NULL,
	`level_anchor_partial` text NOT NULL,
	`level_anchor_strong` text NOT NULL,
	`ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubric`(`rubric_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rubric_dimension_weight" CHECK("rubric_dimension"."weight" > 0),
	CONSTRAINT "rubric_dimension_required" CHECK("rubric_dimension"."required" IN (0, 1)),
	CONSTRAINT "rubric_dimension_definition" CHECK(length("rubric_dimension"."definition") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_job_related_justification" CHECK(length("rubric_dimension"."job_related_justification") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_none" CHECK(length("rubric_dimension"."level_anchor_none") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_weak" CHECK(length("rubric_dimension"."level_anchor_weak") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_partial" CHECK(length("rubric_dimension"."level_anchor_partial") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_level_anchor_strong" CHECK(length("rubric_dimension"."level_anchor_strong") BETWEEN 1 AND 2000),
	CONSTRAINT "rubric_dimension_ordinal" CHECK("rubric_dimension"."ordinal" >= 0),
	CONSTRAINT "rubric_dimension_created_at" CHECK("rubric_dimension"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `rubric_dimension` (
	`rubric_dimension_id`,
	`rubric_id`,
	`dimension_id`,
	`weight`,
	`required`,
	`definition`,
	`job_related_justification`,
	`level_anchor_none`,
	`level_anchor_weak`,
	`level_anchor_partial`,
	`level_anchor_strong`,
	`ordinal`,
	`created_at`
)
SELECT
	`rubric_dimension_id`,
	`rubric_id`,
	`dimension_id`,
	`weight`,
	`required`,
	`definition`,
	`job_related_justification`,
	`level_anchor_none`,
	`level_anchor_weak`,
	`level_anchor_partial`,
	`level_anchor_strong`,
	`ordinal`,
	`created_at`
FROM `rubric_dimension__new`;
--> statement-breakpoint
DROP TABLE `rubric_dimension__new`;
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_dimension_rubric_ordinal_unique` ON `rubric_dimension` (`rubric_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_dimension_rubric_dimension_id_unique` ON `rubric_dimension` (`rubric_id`,`dimension_id`);
--> statement-breakpoint
CREATE TABLE `rubric_provenance_assumption` (
	`rubric_provenance_assumption_id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`workflow_assumption_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubric`(`rubric_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rubric_provenance_assumption_workflow_assumption_id" CHECK(length("rubric_provenance_assumption"."workflow_assumption_id") = 5
        AND "rubric_provenance_assumption"."workflow_assumption_id" GLOB 'WA-[0-9][0-9]'),
	CONSTRAINT "rubric_provenance_assumption_ordinal" CHECK("rubric_provenance_assumption"."ordinal" >= 0),
	CONSTRAINT "rubric_provenance_assumption_created_at" CHECK("rubric_provenance_assumption"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_provenance_assumption_rubric_ordinal_unique` ON `rubric_provenance_assumption` (`rubric_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_provenance_assumption_rubric_assumption_unique` ON `rubric_provenance_assumption` (`rubric_id`,`workflow_assumption_id`);
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
--> statement-breakpoint
CREATE TRIGGER `rubric_provenance_assumption_reject_replace`
BEFORE INSERT ON `rubric_provenance_assumption`
WHEN EXISTS (
	SELECT 1
	FROM `rubric_provenance_assumption`
	WHERE `rubric_provenance_assumption_id` = NEW.`rubric_provenance_assumption_id`
		OR (`rubric_id` = NEW.`rubric_id` AND `ordinal` = NEW.`ordinal`)
		OR (`rubric_id` = NEW.`rubric_id` AND `workflow_assumption_id` = NEW.`workflow_assumption_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'rubric_provenance_assumption is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_provenance_assumption_reject_update`
BEFORE UPDATE ON `rubric_provenance_assumption`
BEGIN
	SELECT RAISE(ABORT, 'rubric_provenance_assumption is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `rubric_provenance_assumption_reject_delete`
BEFORE DELETE ON `rubric_provenance_assumption`
BEGIN
	SELECT RAISE(ABORT, 'rubric_provenance_assumption is immutable');
END;
