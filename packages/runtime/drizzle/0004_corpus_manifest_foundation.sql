CREATE TABLE `corpus_manifest` (
	`corpus_manifest_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content_hash` text NOT NULL,
	`seal_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`seal_id`) REFERENCES `corpus_manifest_seal`(`corpus_manifest_seal_id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "corpus_manifest_kind" CHECK("corpus_manifest"."kind" IN ('main', 'variant')),
	CONSTRAINT "corpus_manifest_content_hash" CHECK(length("corpus_manifest"."content_hash") = 64 AND "corpus_manifest"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "corpus_manifest_created_at" CHECK("corpus_manifest"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `corpus_member` (
	`corpus_member_id` text PRIMARY KEY NOT NULL,
	`manifest_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`import_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`manifest_id`) REFERENCES `corpus_manifest`(`corpus_manifest_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "corpus_member_import_ordinal" CHECK("corpus_member"."import_ordinal" >= 0),
	CONSTRAINT "corpus_member_created_at" CHECK("corpus_member"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `corpus_member_document` (
	`corpus_member_document_id` text PRIMARY KEY NOT NULL,
	`corpus_member_id` text NOT NULL,
	`candidate_document_id` text NOT NULL,
	`document_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`corpus_member_id`) REFERENCES `corpus_member`(`corpus_member_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_document_id`) REFERENCES `candidate_document`(`candidate_document_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "corpus_member_document_ordinal" CHECK("corpus_member_document"."document_ordinal" BETWEEN 0 AND 3),
	CONSTRAINT "corpus_member_document_created_at" CHECK("corpus_member_document"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `corpus_manifest_seal` (
	`corpus_manifest_seal_id` text PRIMARY KEY NOT NULL,
	`manifest_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`manifest_id`) REFERENCES `corpus_manifest`(`corpus_manifest_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "corpus_manifest_seal_created_at" CHECK("corpus_manifest_seal"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_manifest_content_hash_unique` ON `corpus_manifest` (`content_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_manifest_seal_id_unique` ON `corpus_manifest` (`seal_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_member_manifest_candidate_unique` ON `corpus_member` (`manifest_id`,`candidate_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_member_manifest_ordinal_unique` ON `corpus_member` (`manifest_id`,`import_ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_member_document_ordinal_unique` ON `corpus_member_document` (`corpus_member_id`,`document_ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_member_document_candidate_document_unique` ON `corpus_member_document` (`corpus_member_id`,`candidate_document_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `corpus_manifest_seal_manifest_unique` ON `corpus_manifest_seal` (`manifest_id`);
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_reject_replace`
BEFORE INSERT ON `corpus_manifest`
WHEN EXISTS (
	SELECT 1
	FROM `corpus_manifest`
	WHERE `corpus_manifest_id` = NEW.`corpus_manifest_id`
		OR `content_hash` = NEW.`content_hash`
		OR `seal_id` = NEW.`seal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_reject_update`
BEFORE UPDATE ON `corpus_manifest`
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_reject_delete`
BEFORE DELETE ON `corpus_manifest`
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_reject_replace`
BEFORE INSERT ON `corpus_member`
WHEN EXISTS (
	SELECT 1
	FROM `corpus_member`
	WHERE `corpus_member_id` = NEW.`corpus_member_id`
		OR (`manifest_id` = NEW.`manifest_id` AND `candidate_id` = NEW.`candidate_id`)
		OR (`manifest_id` = NEW.`manifest_id` AND `import_ordinal` = NEW.`import_ordinal`)
)
BEGIN
	SELECT RAISE(ABORT, 'corpus_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_reject_update`
BEFORE UPDATE ON `corpus_member`
BEGIN
	SELECT RAISE(ABORT, 'corpus_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_reject_delete`
BEFORE DELETE ON `corpus_member`
BEGIN
	SELECT RAISE(ABORT, 'corpus_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_document_reject_mismatched_candidate`
BEFORE INSERT ON `corpus_member_document`
WHEN (
	SELECT `candidate_id` FROM `candidate_document` WHERE `candidate_document_id` = NEW.`candidate_document_id`
) IS NOT (
	SELECT `candidate_id` FROM `corpus_member` WHERE `corpus_member_id` = NEW.`corpus_member_id`
)
BEGIN
	SELECT RAISE(ABORT, 'corpus_member_document candidate document must belong to the member candidate');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_document_reject_replace`
BEFORE INSERT ON `corpus_member_document`
WHEN EXISTS (
	SELECT 1
	FROM `corpus_member_document`
	WHERE `corpus_member_document_id` = NEW.`corpus_member_document_id`
		OR (`corpus_member_id` = NEW.`corpus_member_id` AND `document_ordinal` = NEW.`document_ordinal`)
		OR (`corpus_member_id` = NEW.`corpus_member_id` AND `candidate_document_id` = NEW.`candidate_document_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'corpus_member_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_document_reject_update`
BEFORE UPDATE ON `corpus_member_document`
BEGIN
	SELECT RAISE(ABORT, 'corpus_member_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_member_document_reject_delete`
BEFORE DELETE ON `corpus_member_document`
BEGIN
	SELECT RAISE(ABORT, 'corpus_member_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_seal_reject_incomplete`
BEFORE INSERT ON `corpus_manifest_seal`
WHEN
	(SELECT COUNT(*) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`) = 0
	OR (
		(SELECT `kind` FROM `corpus_manifest` WHERE `corpus_manifest_id` = NEW.`manifest_id`) = 'main'
		AND (SELECT COUNT(*) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`) <> 140
	)
	OR (
		(SELECT COUNT(*) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`)
		<> (SELECT COUNT(DISTINCT `import_ordinal`) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`)
	)
	OR (SELECT MIN(`import_ordinal`) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`) <> 0
	OR (SELECT MAX(`import_ordinal`) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`)
		<> (SELECT COUNT(*) FROM `corpus_member` WHERE `manifest_id` = NEW.`manifest_id`) - 1
	OR EXISTS (
		SELECT 1
		FROM `corpus_member` m
		WHERE m.`manifest_id` = NEW.`manifest_id`
			AND (
				(SELECT COUNT(*) FROM `corpus_member_document` d WHERE d.`corpus_member_id` = m.`corpus_member_id`) NOT BETWEEN 1 AND 4
				OR (SELECT COUNT(*) FROM `corpus_member_document` d WHERE d.`corpus_member_id` = m.`corpus_member_id`)
					<> (SELECT COUNT(DISTINCT `document_ordinal`) FROM `corpus_member_document` d WHERE d.`corpus_member_id` = m.`corpus_member_id`)
				OR (SELECT MIN(`document_ordinal`) FROM `corpus_member_document` d WHERE d.`corpus_member_id` = m.`corpus_member_id`) <> 0
				OR (SELECT MAX(`document_ordinal`) FROM `corpus_member_document` d WHERE d.`corpus_member_id` = m.`corpus_member_id`)
					<> (SELECT COUNT(*) FROM `corpus_member_document` d WHERE d.`corpus_member_id` = m.`corpus_member_id`) - 1
			)
	)
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest_seal requires complete contiguous membership and document ordering');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_seal_reject_replace`
BEFORE INSERT ON `corpus_manifest_seal`
WHEN EXISTS (
	SELECT 1
	FROM `corpus_manifest_seal`
	WHERE `corpus_manifest_seal_id` = NEW.`corpus_manifest_seal_id`
		OR `manifest_id` = NEW.`manifest_id`
)
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest_seal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_seal_reject_update`
BEFORE UPDATE ON `corpus_manifest_seal`
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest_seal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `corpus_manifest_seal_reject_delete`
BEFORE DELETE ON `corpus_manifest_seal`
BEGIN
	SELECT RAISE(ABORT, 'corpus_manifest_seal is immutable');
END;
