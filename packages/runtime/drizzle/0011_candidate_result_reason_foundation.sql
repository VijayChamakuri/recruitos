CREATE TABLE `candidate_result_reason` (
	`candidate_result_reason_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`reason_kind` text NOT NULL,
	`subject_id` text,
	`reason_code` text NOT NULL,
	`reason_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_reason_kind" CHECK("candidate_result_reason"."reason_kind" IN (
        'missing_evidence',
        'contradiction',
        'ambiguous',
        'assessment_unavailable',
        'parse_failure',
        'possible_duplicate',
        'prompt_injection_flagged',
        'low_confidence'
      )),
	CONSTRAINT "candidate_result_reason_subject" CHECK((
        "candidate_result_reason"."reason_kind" IN ('missing_evidence', 'contradiction', 'ambiguous')
        AND "candidate_result_reason"."subject_id" IS NOT NULL
        AND length("candidate_result_reason"."subject_id") BETWEEN 1 AND 128
        AND "candidate_result_reason"."subject_id" NOT GLOB '*[^!-~]*'
        AND "candidate_result_reason"."reason_code" = "candidate_result_reason"."reason_kind" || ':' || "candidate_result_reason"."subject_id"
      ) OR (
        "candidate_result_reason"."reason_kind" IN (
          'assessment_unavailable',
          'parse_failure',
          'possible_duplicate',
          'prompt_injection_flagged',
          'low_confidence'
        )
        AND "candidate_result_reason"."subject_id" IS NULL
        AND "candidate_result_reason"."reason_code" = "candidate_result_reason"."reason_kind"
      )),
	CONSTRAINT "candidate_result_reason_reason_code" CHECK(length("candidate_result_reason"."reason_code") BETWEEN 1 AND 256
        AND "candidate_result_reason"."reason_code" NOT GLOB '*[^!-~]*'),
	CONSTRAINT "candidate_result_reason_ordinal" CHECK("candidate_result_reason"."reason_ordinal" >= 0),
	CONSTRAINT "candidate_result_reason_created_at" CHECK("candidate_result_reason"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_reason_ordinal_unique` ON `candidate_result_reason` (`candidate_result_id`,`reason_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_reason_kind_unique` ON `candidate_result_reason` (`candidate_result_id`,`reason_kind`) WHERE "candidate_result_reason"."subject_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_reason_kind_subject_unique` ON `candidate_result_reason` (`candidate_result_id`,`reason_kind`,`subject_id`) WHERE "candidate_result_reason"."subject_id" is not null;--> statement-breakpoint
CREATE INDEX `candidate_result_reason_result_created` ON `candidate_result_reason` (`candidate_result_id`,`created_at`,`candidate_result_reason_id`);--> statement-breakpoint
CREATE TRIGGER `candidate_result_reason_reject_replace`
BEFORE INSERT ON `candidate_result_reason`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_reason`
	WHERE `candidate_result_reason_id` = NEW.`candidate_result_reason_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `reason_ordinal` = NEW.`reason_ordinal`)
		OR (
			`candidate_result_id` = NEW.`candidate_result_id`
			AND `reason_kind` = NEW.`reason_kind`
			AND (
				(`subject_id` IS NULL AND NEW.`subject_id` IS NULL)
				OR (`subject_id` = NEW.`subject_id`)
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_reason is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_reason_reject_update`
BEFORE UPDATE ON `candidate_result_reason`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_reason is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_reason_reject_delete`
BEFORE DELETE ON `candidate_result_reason`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_reason is immutable');
END;
