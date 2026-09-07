CREATE TABLE `candidate_head` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`current_result_id` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_head_version" CHECK("candidate_head"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_reject_replace`
BEFORE INSERT ON `candidate_head`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_head`
	WHERE `candidate_id` = NEW.`candidate_id`
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_head cannot be replaced');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_insert_version`
BEFORE INSERT ON `candidate_head`
WHEN NEW.`version` != 1
BEGIN
	SELECT RAISE(ABORT, 'candidate_head insert version must be 1');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_insert_result_owner`
BEFORE INSERT ON `candidate_head`
WHEN NOT EXISTS (
	SELECT 1
	FROM `candidate_triage_result`
	WHERE `candidate_triage_result_id` = NEW.`current_result_id`
		AND `candidate_id` = NEW.`candidate_id`
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_head current_result_id must belong to the candidate');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_reject_delete`
BEFORE DELETE ON `candidate_head`
BEGIN
	SELECT RAISE(ABORT, 'candidate_head cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_update_identity`
BEFORE UPDATE OF `candidate_id` ON `candidate_head`
BEGIN
	SELECT RAISE(ABORT, 'candidate_head identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_update_version`
BEFORE UPDATE ON `candidate_head`
WHEN NEW.`version` != OLD.`version` + 1
BEGIN
	SELECT RAISE(ABORT, 'candidate_head version must increment by 1');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_head_update_result_owner`
BEFORE UPDATE ON `candidate_head`
WHEN NOT EXISTS (
	SELECT 1
	FROM `candidate_triage_result`
	WHERE `candidate_triage_result_id` = NEW.`current_result_id`
		AND `candidate_id` = NEW.`candidate_id`
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_head current_result_id must belong to the candidate');
END;
