CREATE TABLE `__new_attempt_work_item` (
	`attempt_work_item_id` text PRIMARY KEY NOT NULL,
	`triage_attempt_id` text NOT NULL,
	`work_item_key` text NOT NULL,
	`manifest_ordinal` integer NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_document_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`extraction_spec_id` text NOT NULL,
	`state` text NOT NULL,
	`claim_id` text,
	`claimed_at` integer,
	`claim_expires_at` integer,
	`attempt_count` integer NOT NULL,
	`extraction_artifact_id` text,
	`extraction_failure_id` text,
	`extraction_run_id` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`triage_attempt_id`) REFERENCES `triage_attempt`(`triage_attempt_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_document_id`) REFERENCES `candidate_document`(`candidate_document_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extraction_spec_id`) REFERENCES `extraction_spec`(`extraction_spec_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extraction_artifact_id`) REFERENCES `extraction_artifact`(`extraction_artifact_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extraction_failure_id`) REFERENCES `extraction_failure`(`extraction_failure_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_run`(`extraction_run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attempt_work_item_work_item_key" CHECK(length("__new_attempt_work_item"."work_item_key") BETWEEN 1 AND 200),
	CONSTRAINT "attempt_work_item_manifest_ordinal" CHECK("__new_attempt_work_item"."manifest_ordinal" >= 0),
	CONSTRAINT "attempt_work_item_dimension_id" CHECK(length("__new_attempt_work_item"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "attempt_work_item_state" CHECK("__new_attempt_work_item"."state" IN (
        'pending',
        'claimed',
        'succeeded',
        'reviewable_failure',
        'retryable_failure',
        'blocked_failure'
      )),
	CONSTRAINT "attempt_work_item_attempt_count" CHECK("__new_attempt_work_item"."attempt_count" >= 0),
	CONSTRAINT "attempt_work_item_version" CHECK("__new_attempt_work_item"."version" >= 1),
	CONSTRAINT "attempt_work_item_created_at" CHECK("__new_attempt_work_item"."created_at" >= 0),
	CONSTRAINT "attempt_work_item_updated_at" CHECK("__new_attempt_work_item"."updated_at" >= "__new_attempt_work_item"."created_at"),
	CONSTRAINT "attempt_work_item_state_shape" CHECK((
        "__new_attempt_work_item"."state" = 'pending'
        AND "__new_attempt_work_item"."claim_id" IS NULL
        AND "__new_attempt_work_item"."claimed_at" IS NULL
        AND "__new_attempt_work_item"."claim_expires_at" IS NULL
        AND "__new_attempt_work_item"."extraction_artifact_id" IS NULL
        AND "__new_attempt_work_item"."extraction_failure_id" IS NULL
        AND "__new_attempt_work_item"."extraction_run_id" IS NULL
      ) OR (
        "__new_attempt_work_item"."state" = 'claimed'
        AND "__new_attempt_work_item"."claim_id" IS NOT NULL
        AND "__new_attempt_work_item"."claimed_at" IS NOT NULL
        AND "__new_attempt_work_item"."claim_expires_at" IS NOT NULL
        AND "__new_attempt_work_item"."claim_expires_at" >= "__new_attempt_work_item"."claimed_at"
        AND "__new_attempt_work_item"."extraction_artifact_id" IS NULL
        AND "__new_attempt_work_item"."extraction_failure_id" IS NULL
        AND "__new_attempt_work_item"."extraction_run_id" IS NULL
      ) OR (
        "__new_attempt_work_item"."state" = 'succeeded'
        AND "__new_attempt_work_item"."extraction_artifact_id" IS NOT NULL
        AND "__new_attempt_work_item"."extraction_failure_id" IS NULL
      ) OR (
        "__new_attempt_work_item"."state" IN ('reviewable_failure', 'retryable_failure', 'blocked_failure')
        AND "__new_attempt_work_item"."extraction_failure_id" IS NOT NULL
        AND "__new_attempt_work_item"."extraction_artifact_id" IS NULL
      ))
) STRICT;
--> statement-breakpoint
-- Attach a nullable extraction_run_id to attempt_work_item so T10.5 can
-- read spans_returned, spans_located, and dropped quotes for the confidence
-- resolution term. SQLite cannot ADD a foreign key in place, so the work
-- item table is rebuilt. Existing rows get a null extraction_run_id.
-- DROP TABLE drops the 0017 work-item triggers and would leave
-- triage_run_seal_reject_incomplete pointing at a missing table, so this
-- file drops and recreates those triggers around the rebuild.
-- migrate() already sets foreign_keys=OFF around this file.
INSERT INTO `__new_attempt_work_item` (
	`attempt_work_item_id`,
	`triage_attempt_id`,
	`work_item_key`,
	`manifest_ordinal`,
	`candidate_id`,
	`candidate_document_id`,
	`dimension_id`,
	`extraction_spec_id`,
	`state`,
	`claim_id`,
	`claimed_at`,
	`claim_expires_at`,
	`attempt_count`,
	`extraction_artifact_id`,
	`extraction_failure_id`,
	`extraction_run_id`,
	`version`,
	`created_at`,
	`updated_at`
)
SELECT
	`attempt_work_item_id`,
	`triage_attempt_id`,
	`work_item_key`,
	`manifest_ordinal`,
	`candidate_id`,
	`candidate_document_id`,
	`dimension_id`,
	`extraction_spec_id`,
	`state`,
	`claim_id`,
	`claimed_at`,
	`claim_expires_at`,
	`attempt_count`,
	`extraction_artifact_id`,
	`extraction_failure_id`,
	NULL,
	`version`,
	`created_at`,
	`updated_at`
FROM `attempt_work_item`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_replace`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_owner`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_pinned_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_illegal_transition`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_terminal_reopen`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `attempt_work_item_reject_terminal_owner`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `triage_run_seal_reject_incomplete`;
--> statement-breakpoint
DROP TABLE `attempt_work_item`;
--> statement-breakpoint
ALTER TABLE `__new_attempt_work_item` RENAME TO `attempt_work_item`;
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_work_item_attempt_key_unique` ON `attempt_work_item` (`triage_attempt_id`,`work_item_key`);
--> statement-breakpoint
CREATE INDEX `attempt_work_item_attempt_state_ordinal` ON `attempt_work_item` (`triage_attempt_id`,`state`,`manifest_ordinal`,`work_item_key`);
--> statement-breakpoint
CREATE INDEX `attempt_work_item_active_claim_expiry` ON `attempt_work_item` (`claim_expires_at`,`attempt_work_item_id`) WHERE "attempt_work_item"."state" = 'claimed';
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_replace`
BEFORE INSERT ON `attempt_work_item`
WHEN EXISTS (
	SELECT 1
	FROM `attempt_work_item`
	WHERE `attempt_work_item_id` = NEW.`attempt_work_item_id`
		OR (`triage_attempt_id` = NEW.`triage_attempt_id` AND `work_item_key` = NEW.`work_item_key`)
)
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_owner`
BEFORE INSERT ON `attempt_work_item`
WHEN NOT EXISTS (
	SELECT 1
	FROM `candidate_document`
	WHERE `candidate_document_id` = NEW.`candidate_document_id`
		AND `candidate_id` = NEW.`candidate_id`
)
	OR NOT EXISTS (
		SELECT 1
		FROM `extraction_spec`
		WHERE `extraction_spec_id` = NEW.`extraction_spec_id`
			AND `dimension_id` = NEW.`dimension_id`
	)
	OR EXISTS (
		SELECT 1
		FROM `triage_attempt`
		WHERE `triage_attempt_id` = NEW.`triage_attempt_id`
			AND `kind` = 'candidate_correction'
			AND `scope_candidate_id` IS NOT NEW.`candidate_id`
	)
	OR (
		SELECT COUNT(DISTINCT `candidate_id`)
		FROM (
			SELECT `candidate_id` FROM `attempt_work_item` WHERE `triage_attempt_id` = NEW.`triage_attempt_id`
			UNION
			SELECT NEW.`candidate_id`
		)
	) > 200
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item must match its attempt, document, and spec');
END;
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_pinned_update`
BEFORE UPDATE ON `attempt_work_item`
WHEN NEW.`attempt_work_item_id` IS NOT OLD.`attempt_work_item_id`
	OR NEW.`triage_attempt_id` IS NOT OLD.`triage_attempt_id`
	OR NEW.`work_item_key` IS NOT OLD.`work_item_key`
	OR NEW.`manifest_ordinal` IS NOT OLD.`manifest_ordinal`
	OR NEW.`candidate_id` IS NOT OLD.`candidate_id`
	OR NEW.`candidate_document_id` IS NOT OLD.`candidate_document_id`
	OR NEW.`dimension_id` IS NOT OLD.`dimension_id`
	OR NEW.`extraction_spec_id` IS NOT OLD.`extraction_spec_id`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR NEW.`version` IS NOT OLD.`version` + 1
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item pinned fields are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_illegal_transition`
BEFORE UPDATE ON `attempt_work_item`
WHEN OLD.`state` IS NOT NEW.`state`
	AND NOT (
		(OLD.`state` = 'pending' AND NEW.`state` = 'claimed')
		OR (
			OLD.`state` = 'claimed'
			AND NEW.`state` IN ('succeeded', 'reviewable_failure', 'retryable_failure', 'blocked_failure')
		)
		OR (OLD.`state` = 'retryable_failure' AND NEW.`state` = 'claimed')
	)
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item state transition is illegal');
END;
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_terminal_reopen`
BEFORE UPDATE ON `attempt_work_item`
WHEN OLD.`state` IN ('succeeded', 'reviewable_failure', 'blocked_failure')
	AND (
		NEW.`state` IS NOT OLD.`state`
		OR NEW.`extraction_artifact_id` IS NOT OLD.`extraction_artifact_id`
		OR NEW.`extraction_failure_id` IS NOT OLD.`extraction_failure_id`
		OR NEW.`extraction_run_id` IS NOT OLD.`extraction_run_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item terminal state is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_delete`
BEFORE DELETE ON `attempt_work_item`
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item rows cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `attempt_work_item_reject_terminal_owner`
BEFORE UPDATE ON `attempt_work_item`
WHEN NEW.`state` = 'succeeded'
	AND NOT EXISTS (
		SELECT 1
		FROM `extraction_artifact` AS artifact_row
		JOIN `candidate_document` AS document_row
			ON document_row.`candidate_document_id` = NEW.`candidate_document_id`
		WHERE artifact_row.`extraction_artifact_id` = NEW.`extraction_artifact_id`
			AND artifact_row.`spec_id` = NEW.`extraction_spec_id`
			AND artifact_row.`source_document_id` = document_row.`source_document_id`
	)
	OR (
		NEW.`state` IN ('reviewable_failure', 'retryable_failure', 'blocked_failure')
		AND NOT EXISTS (
			SELECT 1
			FROM `extraction_failure` AS failure_row
			JOIN `candidate_document` AS document_row
				ON document_row.`candidate_document_id` = NEW.`candidate_document_id`
			WHERE failure_row.`extraction_failure_id` = NEW.`extraction_failure_id`
				AND failure_row.`spec_id` = NEW.`extraction_spec_id`
				AND failure_row.`source_document_id` = document_row.`source_document_id`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'attempt_work_item terminal fact must match the work item');
END;
--> statement-breakpoint
-- Official-run finalization requires one matching official attempt whose work
-- items are all succeeded or reviewable_failure. blocked_failure blocks the
-- seal. Candidate corrections create no run and are ignored here.
CREATE TRIGGER `triage_run_seal_reject_incomplete`
BEFORE INSERT ON `triage_run_seal`
BEGIN
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE (SELECT COUNT(*) FROM `triage_run` WHERE `triage_run_id` = NEW.`triage_run_id`) <> 1
		OR (SELECT `seal_id` FROM `triage_run` WHERE `triage_run_id` = NEW.`triage_run_id`) IS NOT NEW.`triage_run_seal_id`;
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `triage_run` AS run_row
		JOIN `run_input_snapshot` AS snapshot_row
			ON snapshot_row.`run_input_snapshot_id` = run_row.`snapshot_id`
		JOIN `corpus_manifest` AS manifest_row
			ON manifest_row.`corpus_manifest_id` = run_row.`corpus_manifest_id`
		JOIN `corpus_manifest_seal` AS manifest_seal
			ON manifest_seal.`manifest_id` = manifest_row.`corpus_manifest_id`
		WHERE run_row.`triage_run_id` = NEW.`triage_run_id`
			AND run_row.`kind` = manifest_row.`kind`
	);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE (SELECT COUNT(*) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`) = 0
		OR (SELECT COUNT(*) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`) > 200
		OR (
			(SELECT `kind` FROM `triage_run` WHERE `triage_run_id` = NEW.`triage_run_id`) = 'main'
			AND (SELECT COUNT(*) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`) <> 140
		);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE (SELECT COUNT(*) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`)
		<> (
			SELECT COUNT(*)
			FROM `corpus_member`
			WHERE `manifest_id` = (
				SELECT `corpus_manifest_id` FROM `triage_run` WHERE `triage_run_id` = NEW.`triage_run_id`
			)
		);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE (SELECT MIN(`import_ordinal`) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`) <> 0
		OR (SELECT MAX(`import_ordinal`) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`)
			<> (SELECT COUNT(*) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`) - 1
		OR (SELECT COUNT(*) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`)
			<> (SELECT COUNT(DISTINCT `import_ordinal`) FROM `triage_run_member` WHERE `triage_run_id` = NEW.`triage_run_id`);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE EXISTS (
		SELECT 1
		FROM `triage_run_member` AS member_row
		JOIN `triage_run` AS run_row ON run_row.`triage_run_id` = NEW.`triage_run_id`
		WHERE member_row.`triage_run_id` = NEW.`triage_run_id`
			AND NOT EXISTS (
				SELECT 1
				FROM `corpus_member` AS corpus_row
				WHERE corpus_row.`manifest_id` = run_row.`corpus_manifest_id`
					AND corpus_row.`candidate_id` = member_row.`candidate_id`
					AND corpus_row.`import_ordinal` = member_row.`import_ordinal`
			)
	);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE EXISTS (
		SELECT 1
		FROM `corpus_member` AS corpus_row
		JOIN `triage_run` AS run_row ON run_row.`triage_run_id` = NEW.`triage_run_id`
		WHERE corpus_row.`manifest_id` = run_row.`corpus_manifest_id`
			AND NOT EXISTS (
				SELECT 1
				FROM `triage_run_member` AS member_row
				WHERE member_row.`triage_run_id` = NEW.`triage_run_id`
					AND member_row.`candidate_id` = corpus_row.`candidate_id`
					AND member_row.`import_ordinal` = corpus_row.`import_ordinal`
			)
	);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE EXISTS (
		SELECT 1
		FROM `triage_run_member` AS member_row
		JOIN `candidate_triage_result` AS result_row
			ON result_row.`candidate_triage_result_id` = member_row.`initial_result_id`
		WHERE member_row.`triage_run_id` = NEW.`triage_run_id`
			AND (
				result_row.`kind` <> 'initial'
				OR result_row.`candidate_id` IS NOT member_row.`candidate_id`
				OR NOT EXISTS (
					SELECT 1
					FROM `candidate_result_seal` AS result_seal
					WHERE result_seal.`candidate_result_id` = member_row.`initial_result_id`
				)
			)
	);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE EXISTS (
		SELECT 1
		FROM `triage_run_member` AS member_row
		WHERE member_row.`triage_run_id` = NEW.`triage_run_id`
			AND (
				SELECT `current_result_id`
				FROM `candidate_head`
				WHERE `candidate_id` = member_row.`candidate_id`
			) IS NOT member_row.`initial_result_id`
	);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE (
		SELECT COUNT(*)
		FROM `triage_attempt` AS attempt_row
		JOIN `triage_run` AS run_row ON run_row.`triage_run_id` = NEW.`triage_run_id`
		WHERE attempt_row.`snapshot_id` = run_row.`snapshot_id`
			AND attempt_row.`corpus_manifest_id` = run_row.`corpus_manifest_id`
			AND attempt_row.`kind` = CASE run_row.`kind`
				WHEN 'main' THEN 'main_run'
				WHEN 'variant' THEN 'variant_run'
			END
	) <> 1;
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE (
		SELECT COUNT(*)
		FROM `attempt_work_item` AS item_row
		JOIN `triage_attempt` AS attempt_row
			ON attempt_row.`triage_attempt_id` = item_row.`triage_attempt_id`
		JOIN `triage_run` AS run_row ON run_row.`triage_run_id` = NEW.`triage_run_id`
		WHERE attempt_row.`snapshot_id` = run_row.`snapshot_id`
			AND attempt_row.`corpus_manifest_id` = run_row.`corpus_manifest_id`
			AND attempt_row.`kind` = CASE run_row.`kind`
				WHEN 'main' THEN 'main_run'
				WHEN 'variant' THEN 'variant_run'
			END
	) = 0;
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE EXISTS (
		SELECT 1
		FROM `attempt_work_item` AS item_row
		JOIN `triage_attempt` AS attempt_row
			ON attempt_row.`triage_attempt_id` = item_row.`triage_attempt_id`
		JOIN `triage_run` AS run_row ON run_row.`triage_run_id` = NEW.`triage_run_id`
		WHERE attempt_row.`snapshot_id` = run_row.`snapshot_id`
			AND attempt_row.`corpus_manifest_id` = run_row.`corpus_manifest_id`
			AND attempt_row.`kind` = CASE run_row.`kind`
				WHEN 'main' THEN 'main_run'
				WHEN 'variant' THEN 'variant_run'
			END
			AND item_row.`state` NOT IN ('succeeded', 'reviewable_failure')
	);
	SELECT RAISE(ABORT, 'triage_run_seal requires a complete official run')
	WHERE EXISTS (
		SELECT 1
		FROM `triage_run_member` AS member_row
		JOIN `triage_run` AS run_row ON run_row.`triage_run_id` = NEW.`triage_run_id`
		WHERE member_row.`triage_run_id` = NEW.`triage_run_id`
			AND NOT EXISTS (
				SELECT 1
				FROM `attempt_work_item` AS item_row
				JOIN `triage_attempt` AS attempt_row
					ON attempt_row.`triage_attempt_id` = item_row.`triage_attempt_id`
				WHERE attempt_row.`snapshot_id` = run_row.`snapshot_id`
					AND attempt_row.`corpus_manifest_id` = run_row.`corpus_manifest_id`
					AND attempt_row.`kind` = CASE run_row.`kind`
						WHEN 'main' THEN 'main_run'
						WHEN 'variant' THEN 'variant_run'
					END
					AND item_row.`candidate_id` = member_row.`candidate_id`
					AND item_row.`state` IN ('succeeded', 'reviewable_failure')
			)
	);
END;
