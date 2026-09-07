CREATE TABLE `triage_run` (
	`triage_run_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`corpus_manifest_id` text NOT NULL,
	`seal_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `run_input_snapshot`(`run_input_snapshot_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`corpus_manifest_id`) REFERENCES `corpus_manifest`(`corpus_manifest_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`seal_id`) REFERENCES `triage_run_seal`(`triage_run_seal_id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "triage_run_kind" CHECK("triage_run"."kind" IN ('main', 'variant')),
	CONSTRAINT "triage_run_created_at" CHECK("triage_run"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `triage_run_member` (
	`triage_run_member_id` text PRIMARY KEY NOT NULL,
	`triage_run_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`import_ordinal` integer NOT NULL,
	`initial_result_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`triage_run_id`) REFERENCES `triage_run`(`triage_run_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`initial_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "triage_run_member_import_ordinal" CHECK("triage_run_member"."import_ordinal" >= 0),
	CONSTRAINT "triage_run_member_created_at" CHECK("triage_run_member"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `triage_run_seal` (
	`triage_run_seal_id` text PRIMARY KEY NOT NULL,
	`triage_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`triage_run_id`) REFERENCES `triage_run`(`triage_run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "triage_run_seal_created_at" CHECK("triage_run_seal"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_run_seal_id_unique` ON `triage_run` (`seal_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_run_snapshot_manifest_unique` ON `triage_run` (`snapshot_id`,`corpus_manifest_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_run_member_run_candidate_unique` ON `triage_run_member` (`triage_run_id`,`candidate_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_run_member_run_ordinal_unique` ON `triage_run_member` (`triage_run_id`,`import_ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_run_member_result_unique` ON `triage_run_member` (`initial_result_id`);
--> statement-breakpoint
CREATE INDEX `triage_run_member_run_access` ON `triage_run_member` (`triage_run_id`,`candidate_id`,`import_ordinal`,`initial_result_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_run_seal_run_unique` ON `triage_run_seal` (`triage_run_id`);
--> statement-breakpoint
CREATE TRIGGER `triage_run_reject_replace`
BEFORE INSERT ON `triage_run`
WHEN EXISTS (
	SELECT 1
	FROM `triage_run`
	WHERE `triage_run_id` = NEW.`triage_run_id`
		OR `seal_id` = NEW.`seal_id`
		OR (
			`snapshot_id` = NEW.`snapshot_id`
			AND `corpus_manifest_id` = NEW.`corpus_manifest_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'triage_run is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_reject_update`
BEFORE UPDATE ON `triage_run`
BEGIN
	SELECT RAISE(ABORT, 'triage_run is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_reject_delete`
BEFORE DELETE ON `triage_run`
BEGIN
	SELECT RAISE(ABORT, 'triage_run is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_member_reject_result_owner`
BEFORE INSERT ON `triage_run_member`
WHEN NOT EXISTS (
	SELECT 1
	FROM `candidate_triage_result`
	WHERE `candidate_triage_result_id` = NEW.`initial_result_id`
		AND `candidate_id` = NEW.`candidate_id`
		AND `kind` = 'initial'
)
BEGIN
	SELECT RAISE(ABORT, 'triage_run_member initial result must be the candidate initial result');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_member_reject_replace`
BEFORE INSERT ON `triage_run_member`
WHEN EXISTS (
	SELECT 1
	FROM `triage_run_member`
	WHERE `triage_run_member_id` = NEW.`triage_run_member_id`
		OR (`triage_run_id` = NEW.`triage_run_id` AND `candidate_id` = NEW.`candidate_id`)
		OR (`triage_run_id` = NEW.`triage_run_id` AND `import_ordinal` = NEW.`import_ordinal`)
		OR `initial_result_id` = NEW.`initial_result_id`
)
BEGIN
	SELECT RAISE(ABORT, 'triage_run_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_member_reject_update`
BEFORE UPDATE ON `triage_run_member`
BEGIN
	SELECT RAISE(ABORT, 'triage_run_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_member_reject_delete`
BEFORE DELETE ON `triage_run_member`
BEGIN
	SELECT RAISE(ABORT, 'triage_run_member is immutable');
END;
--> statement-breakpoint
-- Attempt-readiness checks (every work item succeeded or reviewable_failure)
-- land with triage_attempt in the next migration. This seal still validates
-- snapshot alignment, exact corpus membership, sealed initial results,
-- candidate head pointers, and exclusion of correction results.
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
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_seal_reject_replace`
BEFORE INSERT ON `triage_run_seal`
WHEN EXISTS (
	SELECT 1
	FROM `triage_run_seal`
	WHERE `triage_run_seal_id` = NEW.`triage_run_seal_id`
		OR `triage_run_id` = NEW.`triage_run_id`
)
BEGIN
	SELECT RAISE(ABORT, 'triage_run_seal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_seal_reject_update`
BEFORE UPDATE ON `triage_run_seal`
BEGIN
	SELECT RAISE(ABORT, 'triage_run_seal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `triage_run_seal_reject_delete`
BEFORE DELETE ON `triage_run_seal`
BEGIN
	SELECT RAISE(ABORT, 'triage_run_seal is immutable');
END;
