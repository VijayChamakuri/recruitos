CREATE TABLE `candidate_result_seal` (
	`candidate_result_seal_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_seal_created_at" CHECK("candidate_result_seal"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_seal_result_unique` ON `candidate_result_seal` (`candidate_result_id`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `candidate_triage_result_reject_replace`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `candidate_triage_result_reject_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `candidate_triage_result_reject_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `candidate_head_insert_result_owner`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `candidate_head_update_result_owner`;
--> statement-breakpoint
CREATE TABLE `candidate_triage_result__new` (
	`candidate_triage_result_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`kind` text NOT NULL,
	`availability` text NOT NULL,
	`status` text NOT NULL,
	`supersedes_result_id` text,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`seal_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`seal_id`) REFERENCES `candidate_result_seal`(`candidate_result_seal_id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "candidate_triage_result_kind" CHECK("candidate_triage_result__new"."kind" IN ('initial', 'correction')),
	CONSTRAINT "candidate_triage_result_availability" CHECK("candidate_triage_result__new"."availability" IN ('complete', 'unavailable')),
	CONSTRAINT "candidate_triage_result_status" CHECK("candidate_triage_result__new"."status" IN ('scored', 'rejected_hard_requirement', 'escalated')),
	CONSTRAINT "candidate_triage_result_lineage" CHECK((
        "candidate_triage_result__new"."kind" = 'initial' AND "candidate_triage_result__new"."supersedes_result_id" IS NULL
      ) OR (
        "candidate_triage_result__new"."kind" = 'correction' AND "candidate_triage_result__new"."supersedes_result_id" IS NOT NULL
      )),
	CONSTRAINT "candidate_triage_result_availability_status" CHECK((
        "candidate_triage_result__new"."availability" = 'unavailable' AND "candidate_triage_result__new"."status" = 'escalated'
      ) OR (
        "candidate_triage_result__new"."availability" = 'complete'
        AND "candidate_triage_result__new"."status" IN ('scored', 'escalated', 'rejected_hard_requirement')
      )),
	CONSTRAINT "candidate_triage_result_content_json" CHECK(json_valid("candidate_triage_result__new"."content_json") AND json_type("candidate_triage_result__new"."content_json") = 'object'),
	CONSTRAINT "candidate_triage_result_content_hash" CHECK(length("candidate_triage_result__new"."content_hash") = 64 AND "candidate_triage_result__new"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "candidate_triage_result_created_at" CHECK("candidate_triage_result__new"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
-- The rebuild copies existing rows with seal_id = 'unsealed'. That placeholder
-- plus candidate_triage_result_seal_id_unique is valid only for 0 or 1 source
-- rows. Increment-1 always inserts results already sealed, so 0015 runs against
-- an empty candidate_triage_result.
INSERT INTO `candidate_triage_result__new` (
	`candidate_triage_result_id`,
	`candidate_id`,
	`kind`,
	`availability`,
	`status`,
	`supersedes_result_id`,
	`content_json`,
	`content_hash`,
	`seal_id`,
	`created_at`
)
SELECT
	`candidate_triage_result_id`,
	`candidate_id`,
	`kind`,
	`availability`,
	`status`,
	`supersedes_result_id`,
	`content_json`,
	`content_hash`,
	'unsealed',
	`created_at`
FROM `candidate_triage_result`;
--> statement-breakpoint
DROP TABLE `candidate_triage_result`;
--> statement-breakpoint
ALTER TABLE `candidate_triage_result__new` RENAME TO `candidate_triage_result`;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_triage_result_content_hash_unique` ON `candidate_triage_result` (`content_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_triage_result_seal_id_unique` ON `candidate_triage_result` (`seal_id`);
--> statement-breakpoint
CREATE INDEX `candidate_triage_result_candidate_created` ON `candidate_triage_result` (`candidate_id`,`created_at`,`candidate_triage_result_id`);
--> statement-breakpoint
CREATE TRIGGER `candidate_triage_result_reject_replace`
BEFORE INSERT ON `candidate_triage_result`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_triage_result`
	WHERE `candidate_triage_result_id` = NEW.`candidate_triage_result_id`
		OR `content_hash` = NEW.`content_hash`
		OR `seal_id` = NEW.`seal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_triage_result is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_triage_result_reject_update`
BEFORE UPDATE ON `candidate_triage_result`
BEGIN
	SELECT RAISE(ABORT, 'candidate_triage_result is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_triage_result_reject_delete`
BEFORE DELETE ON `candidate_triage_result`
BEGIN
	SELECT RAISE(ABORT, 'candidate_triage_result is immutable');
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
--> statement-breakpoint
CREATE TRIGGER `candidate_result_seal_reject_incomplete`
BEFORE INSERT ON `candidate_result_seal`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_triage_result` WHERE `candidate_triage_result_id` = NEW.`candidate_result_id`) <> 1
		OR (SELECT `seal_id` FROM `candidate_triage_result` WHERE `candidate_triage_result_id` = NEW.`candidate_result_id`) IS NOT NEW.`candidate_result_seal_id`;
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT `kind` FROM `candidate_triage_result` WHERE `candidate_triage_result_id` = NEW.`candidate_result_id`) = 'correction'
		AND (
			(SELECT `supersedes_result_id` FROM `candidate_triage_result` WHERE `candidate_triage_result_id` = NEW.`candidate_result_id`) IS NULL
			OR NOT EXISTS (
				SELECT 1
				FROM `candidate_triage_result` AS prior_result
				JOIN `candidate_triage_result` AS current_result
					ON current_result.`candidate_triage_result_id` = NEW.`candidate_result_id`
				WHERE prior_result.`candidate_triage_result_id` = current_result.`supersedes_result_id`
					AND prior_result.`candidate_id` = current_result.`candidate_id`
			)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT `availability` FROM `candidate_triage_result` WHERE `candidate_triage_result_id` = NEW.`candidate_result_id`) = 'complete'
		AND (
			(SELECT COUNT(*) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 6
			OR (SELECT COUNT(DISTINCT `dimension_id`) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 6
			OR (SELECT COUNT(*) FROM `score_result` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 1
			OR EXISTS (
				SELECT 1
				FROM `candidate_result_reason`
				WHERE `candidate_result_id` = NEW.`candidate_result_id`
					AND `reason_kind` = 'assessment_unavailable'
			)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT `availability` FROM `candidate_triage_result` WHERE `candidate_triage_result_id` = NEW.`candidate_result_id`) = 'unavailable'
		AND (
			(SELECT COUNT(*) FROM `score_result` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT COUNT(*) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 1
			OR (SELECT COUNT(*) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id` AND `reason_kind` = 'assessment_unavailable') <> 1
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_structured_fact` AS assoc
		JOIN `structured_fact` AS fact ON fact.`structured_fact_id` = assoc.`structured_fact_id`
		JOIN `candidate_triage_result` AS result ON result.`candidate_triage_result_id` = NEW.`candidate_result_id`
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND fact.`candidate_id` IS NOT result.`candidate_id`
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_hard_requirement_assessment` AS assoc
		JOIN `hard_requirement_assessment` AS assessment
			ON assessment.`hard_requirement_assessment_id` = assoc.`hard_requirement_assessment_id`
		JOIN `candidate_triage_result` AS result ON result.`candidate_triage_result_id` = NEW.`candidate_result_id`
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND assessment.`candidate_id` IS NOT result.`candidate_id`
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_fact_conflict` AS assoc
		JOIN `fact_conflict_member` AS member ON member.`fact_conflict_id` = assoc.`fact_conflict_id`
		JOIN `structured_fact` AS fact ON fact.`structured_fact_id` = member.`structured_fact_id`
		JOIN `candidate_triage_result` AS result ON result.`candidate_triage_result_id` = NEW.`candidate_result_id`
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND fact.`candidate_id` IS NOT result.`candidate_id`
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_evidence_span` AS assoc
		JOIN `evidence_span` AS span ON span.`evidence_span_id` = assoc.`evidence_span_id`
		JOIN `candidate_triage_result` AS result ON result.`candidate_triage_result_id` = NEW.`candidate_result_id`
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND NOT EXISTS (
				SELECT 1
				FROM `candidate_document` AS document
				WHERE document.`candidate_id` = result.`candidate_id`
					AND document.`source_document_id` = span.`document_id`
			)
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_structured_fact` AS assoc
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND (
				SELECT COUNT(*)
				FROM `structured_fact_provenance` AS provenance
				WHERE provenance.`structured_fact_id` = assoc.`structured_fact_id`
			) = 0
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_fact_conflict` AS assoc
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND (
				SELECT COUNT(*)
				FROM `fact_conflict_member` AS member
				WHERE member.`fact_conflict_id` = assoc.`fact_conflict_id`
			) < 2
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_hard_requirement_assessment` AS assoc
		JOIN `hard_requirement_assessment` AS assessment
			ON assessment.`hard_requirement_assessment_id` = assoc.`hard_requirement_assessment_id`
		WHERE assoc.`candidate_result_id` = NEW.`candidate_result_id`
			AND assessment.`outcome` IN ('pass', 'fail')
			AND (
				SELECT COUNT(*)
				FROM `hard_requirement_assessment_fact` AS support
				WHERE support.`hard_requirement_assessment_id` = assessment.`hard_requirement_assessment_id`
			) = 0
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (
		SELECT COUNT(*)
		FROM `candidate_result_reason`
		WHERE `candidate_result_id` = NEW.`candidate_result_id`
	) <> (
		SELECT COUNT(*)
		FROM (
			SELECT `reason_kind`, `subject_id`
			FROM `candidate_result_reason`
			WHERE `candidate_result_id` = NEW.`candidate_result_id`
			GROUP BY `reason_kind`, `subject_id`
		) AS unique_reasons
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `candidate_result_reason` AS reason
		WHERE reason.`candidate_result_id` = NEW.`candidate_result_id`
			AND (
				SELECT COUNT(*)
				FROM `resolution_task` AS task
				WHERE task.`candidate_result_reason_id` = reason.`candidate_result_reason_id`
					AND task.`candidate_result_id` = NEW.`candidate_result_id`
			) <> 1
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `resolution_task` AS task
		WHERE task.`candidate_result_id` = NEW.`candidate_result_id`
			AND NOT EXISTS (
				SELECT 1
				FROM `candidate_result_reason` AS reason
				WHERE reason.`candidate_result_reason_id` = task.`candidate_result_reason_id`
					AND reason.`candidate_result_id` = NEW.`candidate_result_id`
			)
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE EXISTS (
		SELECT 1
		FROM `proposal` AS proposal_row
		JOIN `candidate_triage_result` AS result ON result.`candidate_triage_result_id` = NEW.`candidate_result_id`
		WHERE proposal_row.`candidate_result_id` = NEW.`candidate_result_id`
			AND proposal_row.`proposal_kind` = 'shortlist_inclusion'
			AND (
				result.`availability` = 'unavailable'
				OR result.`status` <> 'scored'
				OR (SELECT COUNT(*) FROM `score_result` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 1
			)
	);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_evidence_span` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`span_ordinal`) FROM `candidate_result_evidence_span` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`span_ordinal`) FROM `candidate_result_evidence_span` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_evidence_span` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_evidence_span` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `span_ordinal`) FROM `candidate_result_evidence_span` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_evidence_gap` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`gap_ordinal`) FROM `candidate_result_evidence_gap` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`gap_ordinal`) FROM `candidate_result_evidence_gap` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_evidence_gap` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_evidence_gap` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `gap_ordinal`) FROM `candidate_result_evidence_gap` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`assessment_ordinal`) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`assessment_ordinal`) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `assessment_ordinal`) FROM `candidate_result_dimension_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_structured_fact` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`fact_ordinal`) FROM `candidate_result_structured_fact` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`fact_ordinal`) FROM `candidate_result_structured_fact` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_structured_fact` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_structured_fact` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `fact_ordinal`) FROM `candidate_result_structured_fact` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_fact_conflict` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`conflict_ordinal`) FROM `candidate_result_fact_conflict` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`conflict_ordinal`) FROM `candidate_result_fact_conflict` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_fact_conflict` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_fact_conflict` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `conflict_ordinal`) FROM `candidate_result_fact_conflict` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_hard_requirement_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`requirement_ordinal`) FROM `candidate_result_hard_requirement_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`requirement_ordinal`) FROM `candidate_result_hard_requirement_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_hard_requirement_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_hard_requirement_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `requirement_ordinal`) FROM `candidate_result_hard_requirement_assessment` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`reason_ordinal`) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`reason_ordinal`) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `reason_ordinal`) FROM `candidate_result_reason` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `resolution_task` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`task_ordinal`) FROM `resolution_task` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`task_ordinal`) FROM `resolution_task` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `resolution_task` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `resolution_task` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `task_ordinal`) FROM `resolution_task` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
	SELECT RAISE(ABORT, 'candidate_result_seal requires a complete result')
	WHERE (SELECT COUNT(*) FROM `proposal` WHERE `candidate_result_id` = NEW.`candidate_result_id`) > 0
		AND (
			(SELECT MIN(`proposal_ordinal`) FROM `proposal` WHERE `candidate_result_id` = NEW.`candidate_result_id`) <> 0
			OR (SELECT MAX(`proposal_ordinal`) FROM `proposal` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(*) FROM `proposal` WHERE `candidate_result_id` = NEW.`candidate_result_id`) - 1
			OR (SELECT COUNT(*) FROM `proposal` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
				<> (SELECT COUNT(DISTINCT `proposal_ordinal`) FROM `proposal` WHERE `candidate_result_id` = NEW.`candidate_result_id`)
		);
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_seal_reject_replace`
BEFORE INSERT ON `candidate_result_seal`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_seal`
	WHERE `candidate_result_seal_id` = NEW.`candidate_result_seal_id`
		OR `candidate_result_id` = NEW.`candidate_result_id`
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_seal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_seal_reject_update`
BEFORE UPDATE ON `candidate_result_seal`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_seal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_seal_reject_delete`
BEFORE DELETE ON `candidate_result_seal`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_seal is immutable');
END;
