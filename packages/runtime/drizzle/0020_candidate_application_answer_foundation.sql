CREATE TABLE `candidate_application_answer` (
	`candidate_application_answer_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`question_key` text NOT NULL,
	`selected_option_key` text NOT NULL,
	`free_text` text,
	`collected_by` text NOT NULL,
	`form_id` text NOT NULL,
	`question_id` text NOT NULL,
	`collected_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_application_answer_question_key" CHECK(length("candidate_application_answer"."question_key") BETWEEN 1 AND 200),
	CONSTRAINT "candidate_application_answer_selected_option_key" CHECK(length("candidate_application_answer"."selected_option_key") BETWEEN 1 AND 200),
	CONSTRAINT "candidate_application_answer_free_text" CHECK("candidate_application_answer"."free_text" IS NULL OR length("candidate_application_answer"."free_text") BETWEEN 1 AND 2000),
	CONSTRAINT "candidate_application_answer_collected_by" CHECK(length("candidate_application_answer"."collected_by") BETWEEN 1 AND 200),
	CONSTRAINT "candidate_application_answer_form_id" CHECK(length("candidate_application_answer"."form_id") BETWEEN 1 AND 128),
	CONSTRAINT "candidate_application_answer_question_id" CHECK(length("candidate_application_answer"."question_id") BETWEEN 1 AND 128),
	CONSTRAINT "candidate_application_answer_collected_at" CHECK("candidate_application_answer"."collected_at" >= 0),
	CONSTRAINT "candidate_application_answer_created_at" CHECK("candidate_application_answer"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_application_answer_candidate_question_unique` ON `candidate_application_answer` (`candidate_id`,`question_key`);
--> statement-breakpoint
CREATE INDEX `candidate_application_answer_candidate` ON `candidate_application_answer` (`candidate_id`);
--> statement-breakpoint
CREATE TRIGGER `candidate_application_answer_reject_replace`
BEFORE INSERT ON `candidate_application_answer`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_application_answer`
	WHERE `candidate_application_answer_id` = NEW.`candidate_application_answer_id`
		OR (`candidate_id` = NEW.`candidate_id` AND `question_key` = NEW.`question_key`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_application_answer is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_application_answer_reject_update`
BEFORE UPDATE ON `candidate_application_answer`
BEGIN
	SELECT RAISE(ABORT, 'candidate_application_answer is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_application_answer_reject_delete`
BEFORE DELETE ON `candidate_application_answer`
BEGIN
	SELECT RAISE(ABORT, 'candidate_application_answer is immutable');
END;
