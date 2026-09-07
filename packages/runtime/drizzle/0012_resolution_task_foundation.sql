CREATE TABLE `resolution_task` (
	`resolution_task_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`candidate_result_reason_id` text NOT NULL,
	`task_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_result_reason_id`) REFERENCES `candidate_result_reason`(`candidate_result_reason_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "resolution_task_ordinal" CHECK("resolution_task"."task_ordinal" >= 0),
	CONSTRAINT "resolution_task_created_at" CHECK("resolution_task"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `resolution_action` (
	`resolution_action_id` text PRIMARY KEY NOT NULL,
	`resolution_task_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action_kind` text NOT NULL,
	`action_ordinal` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`evidence_span_id` text,
	`dimension_assessment_id` text,
	`resulting_result_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`resolution_task_id`) REFERENCES `resolution_task`(`resolution_task_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`actor_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_span_id`) REFERENCES `evidence_span`(`evidence_span_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dimension_assessment_id`) REFERENCES `dimension_assessment`(`dimension_assessment_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resulting_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "resolution_action_kind" CHECK("resolution_action"."action_kind" IN (
        'supply_evidence_and_set_level',
        'correct_parse',
        'confirm_judgment',
        'block',
        'dismiss',
        'request_re_extraction',
        'reextraction_completed'
      )),
	CONSTRAINT "resolution_action_shape" CHECK((
        "resolution_action"."action_kind" = 'supply_evidence_and_set_level'
        AND "resolution_action"."evidence_span_id" IS NOT NULL
        AND "resolution_action"."dimension_assessment_id" IS NOT NULL
        AND "resolution_action"."resulting_result_id" IS NULL
        AND "resolution_action"."actor_id" != 'system:runtime'
      ) OR (
        "resolution_action"."action_kind" = 'confirm_judgment'
        AND "resolution_action"."evidence_span_id" IS NULL
        AND "resolution_action"."dimension_assessment_id" IS NOT NULL
        AND "resolution_action"."resulting_result_id" IS NULL
        AND "resolution_action"."actor_id" != 'system:runtime'
      ) OR (
        "resolution_action"."action_kind" IN ('correct_parse', 'block', 'dismiss', 'request_re_extraction')
        AND "resolution_action"."evidence_span_id" IS NULL
        AND "resolution_action"."dimension_assessment_id" IS NULL
        AND "resolution_action"."resulting_result_id" IS NULL
        AND "resolution_action"."actor_id" != 'system:runtime'
      ) OR (
        "resolution_action"."action_kind" = 'reextraction_completed'
        AND "resolution_action"."evidence_span_id" IS NULL
        AND "resolution_action"."dimension_assessment_id" IS NULL
        AND "resolution_action"."resulting_result_id" IS NOT NULL
        AND "resolution_action"."actor_id" = 'system:runtime'
      )),
	CONSTRAINT "resolution_action_payload_json" CHECK(json_valid("resolution_action"."payload_json") AND json_type("resolution_action"."payload_json") = 'object'),
	CONSTRAINT "resolution_action_payload_hash" CHECK(length("resolution_action"."payload_hash") = 64 AND "resolution_action"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "resolution_action_ordinal" CHECK("resolution_action"."action_ordinal" >= 0),
	CONSTRAINT "resolution_action_created_at" CHECK("resolution_action"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `resolution_task_head` (
	`resolution_task_id` text PRIMARY KEY NOT NULL,
	`current_action_id` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`resolution_task_id`) REFERENCES `resolution_task`(`resolution_task_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_action_id`) REFERENCES `resolution_action`(`resolution_action_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "resolution_task_head_version" CHECK("resolution_task_head"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `resolution_task_reason_unique` ON `resolution_task` (`candidate_result_reason_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resolution_task_ordinal_unique` ON `resolution_task` (`candidate_result_id`,`task_ordinal`);--> statement-breakpoint
CREATE INDEX `resolution_task_result_created` ON `resolution_task` (`candidate_result_id`,`created_at`,`resolution_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resolution_action_ordinal_unique` ON `resolution_action` (`resolution_task_id`,`action_ordinal`);--> statement-breakpoint
CREATE INDEX `resolution_action_task_created` ON `resolution_action` (`resolution_task_id`,`created_at`,`resolution_action_id`);--> statement-breakpoint
CREATE TRIGGER `resolution_task_reject_replace`
BEFORE INSERT ON `resolution_task`
WHEN EXISTS (
	SELECT 1
	FROM `resolution_task`
	WHERE `resolution_task_id` = NEW.`resolution_task_id`
		OR `candidate_result_reason_id` = NEW.`candidate_result_reason_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `task_ordinal` = NEW.`task_ordinal`)
)
BEGIN
	SELECT RAISE(ABORT, 'resolution_task is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_reject_update`
BEFORE UPDATE ON `resolution_task`
BEGIN
	SELECT RAISE(ABORT, 'resolution_task is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_reject_delete`
BEFORE DELETE ON `resolution_task`
BEGIN
	SELECT RAISE(ABORT, 'resolution_task is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_action_reject_replace`
BEFORE INSERT ON `resolution_action`
WHEN EXISTS (
	SELECT 1
	FROM `resolution_action`
	WHERE `resolution_action_id` = NEW.`resolution_action_id`
		OR (`resolution_task_id` = NEW.`resolution_task_id` AND `action_ordinal` = NEW.`action_ordinal`)
)
BEGIN
	SELECT RAISE(ABORT, 'resolution_action is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_action_reject_update`
BEFORE UPDATE ON `resolution_action`
BEGIN
	SELECT RAISE(ABORT, 'resolution_action is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_action_reject_delete`
BEFORE DELETE ON `resolution_action`
BEGIN
	SELECT RAISE(ABORT, 'resolution_action is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_reject_replace`
BEFORE INSERT ON `resolution_task_head`
WHEN EXISTS (
	SELECT 1
	FROM `resolution_task_head`
	WHERE `resolution_task_id` = NEW.`resolution_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head cannot be replaced');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_insert_version`
BEFORE INSERT ON `resolution_task_head`
WHEN NEW.`version` != 1
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head insert version must be 1');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_insert_action_owner`
BEFORE INSERT ON `resolution_task_head`
WHEN NOT EXISTS (
	SELECT 1
	FROM `resolution_action`
	WHERE `resolution_action_id` = NEW.`current_action_id`
		AND `resolution_task_id` = NEW.`resolution_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head current_action_id must belong to the task');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_reject_delete`
BEFORE DELETE ON `resolution_task_head`
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_update_identity`
BEFORE UPDATE OF `resolution_task_id` ON `resolution_task_head`
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_update_version`
BEFORE UPDATE ON `resolution_task_head`
WHEN NEW.`version` != OLD.`version` + 1
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head version must increment by 1');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_task_head_update_action_owner`
BEFORE UPDATE ON `resolution_task_head`
WHEN NOT EXISTS (
	SELECT 1
	FROM `resolution_action`
	WHERE `resolution_action_id` = NEW.`current_action_id`
		AND `resolution_task_id` = NEW.`resolution_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'resolution_task_head current_action_id must belong to the task');
END;
