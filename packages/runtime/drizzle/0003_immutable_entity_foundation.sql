CREATE TABLE `actor` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`actor_kind` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "actor_kind" CHECK("actor"."actor_kind" IN ('human', 'system')),
	CONSTRAINT "actor_system_identity" CHECK(("actor"."actor_kind" = 'system') = ("actor"."actor_id" = 'system:runtime')),
	CONSTRAINT "actor_display_name" CHECK(length("actor"."display_name") BETWEEN 1 AND 200),
	CONSTRAINT "actor_created_at" CHECK("actor"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `candidate` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`source_system` text NOT NULL,
	`source_key` text NOT NULL,
	`channel` text NOT NULL,
	`corpus_tag` text NOT NULL,
	`is_synthetic` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "candidate_source_system" CHECK(length("candidate"."source_system") BETWEEN 1 AND 64),
	CONSTRAINT "candidate_source_key" CHECK(length("candidate"."source_key") BETWEEN 1 AND 128),
	CONSTRAINT "candidate_channel" CHECK("candidate"."channel" IN ('inbound', 'sourced')),
	CONSTRAINT "candidate_corpus_tag" CHECK("candidate"."corpus_tag" IN ('main', 'variant')),
	CONSTRAINT "candidate_is_synthetic" CHECK("candidate"."is_synthetic" = 1),
	CONSTRAINT "candidate_created_at" CHECK("candidate"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `source_document` (
	`source_document_id` text PRIMARY KEY NOT NULL,
	`raw_text` text NOT NULL,
	`raw_hash` text NOT NULL,
	`raw_byte_length` integer NOT NULL,
	`normalized_text` text NOT NULL,
	`normalized_hash` text NOT NULL,
	`normalized_length` integer NOT NULL,
	`normalized_byte_length` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "source_document_raw_hash" CHECK(length("source_document"."raw_hash") = 64 AND "source_document"."raw_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "source_document_normalized_hash" CHECK(length("source_document"."normalized_hash") = 64 AND "source_document"."normalized_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "source_document_raw_byte_length" CHECK("source_document"."raw_byte_length" BETWEEN 1 AND 262144
        AND "source_document"."raw_byte_length" = length(CAST("source_document"."raw_text" AS BLOB))),
	CONSTRAINT "source_document_normalized_byte_length" CHECK("source_document"."normalized_byte_length" BETWEEN 1 AND 131072
        AND "source_document"."normalized_byte_length" = length(CAST("source_document"."normalized_text" AS BLOB))),
	CONSTRAINT "source_document_normalized_length" CHECK("source_document"."normalized_length" BETWEEN 1 AND 50000
        AND "source_document"."normalized_length" >= length("source_document"."normalized_text")
        AND "source_document"."normalized_length" <= 2 * length("source_document"."normalized_text")),
	CONSTRAINT "source_document_created_at" CHECK("source_document"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `candidate_document` (
	`candidate_document_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`source_document_id` text NOT NULL,
	`document_kind` text NOT NULL,
	`label` text NOT NULL,
	`document_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_document_id`) REFERENCES `source_document`(`source_document_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_document_kind" CHECK("candidate_document"."document_kind" IN ('resume', 'cover_letter', 'profile', 'recruiter_note')),
	CONSTRAINT "candidate_document_label" CHECK(length("candidate_document"."label") BETWEEN 1 AND 200),
	CONSTRAINT "candidate_document_ordinal" CHECK("candidate_document"."document_ordinal" BETWEEN 0 AND 3),
	CONSTRAINT "candidate_document_created_at" CHECK("candidate_document"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_source_unique` ON `candidate` (`source_system`,`source_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_document_raw_hash_unique` ON `source_document` (`raw_hash`);
--> statement-breakpoint
CREATE INDEX `source_document_normalized_hash` ON `source_document` (`normalized_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_document_ordinal_unique` ON `candidate_document` (`candidate_id`,`document_ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_document_source_unique` ON `candidate_document` (`candidate_id`,`source_document_id`);
--> statement-breakpoint
INSERT INTO `actor` (`actor_id`, `actor_kind`, `display_name`, `created_at`)
VALUES ('system:runtime', 'system', 'RecruitOS Runtime', 0);
--> statement-breakpoint
CREATE TRIGGER `actor_reject_replace`
BEFORE INSERT ON `actor`
WHEN EXISTS (
	SELECT 1
	FROM `actor`
	WHERE `actor_id` = NEW.`actor_id`
)
BEGIN
	SELECT RAISE(ABORT, 'actor is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `actor_reject_update`
BEFORE UPDATE ON `actor`
BEGIN
	SELECT RAISE(ABORT, 'actor is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `actor_reject_delete`
BEFORE DELETE ON `actor`
BEGIN
	SELECT RAISE(ABORT, 'actor is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_reject_replace`
BEFORE INSERT ON `candidate`
WHEN EXISTS (
	SELECT 1
	FROM `candidate`
	WHERE `candidate_id` = NEW.`candidate_id`
		OR (`source_system` = NEW.`source_system` AND `source_key` = NEW.`source_key`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_reject_update`
BEFORE UPDATE ON `candidate`
BEGIN
	SELECT RAISE(ABORT, 'candidate is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_reject_delete`
BEFORE DELETE ON `candidate`
BEGIN
	SELECT RAISE(ABORT, 'candidate is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `source_document_reject_replace`
BEFORE INSERT ON `source_document`
WHEN EXISTS (
	SELECT 1
	FROM `source_document`
	WHERE `source_document_id` = NEW.`source_document_id`
		OR `raw_hash` = NEW.`raw_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'source_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `source_document_reject_update`
BEFORE UPDATE ON `source_document`
BEGIN
	SELECT RAISE(ABORT, 'source_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `source_document_reject_delete`
BEFORE DELETE ON `source_document`
BEGIN
	SELECT RAISE(ABORT, 'source_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_document_reject_replace`
BEFORE INSERT ON `candidate_document`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_document`
	WHERE `candidate_document_id` = NEW.`candidate_document_id`
		OR (`candidate_id` = NEW.`candidate_id` AND `document_ordinal` = NEW.`document_ordinal`)
		OR (`candidate_id` = NEW.`candidate_id` AND `source_document_id` = NEW.`source_document_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_document_reject_update`
BEFORE UPDATE ON `candidate_document`
BEGIN
	SELECT RAISE(ABORT, 'candidate_document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_document_reject_delete`
BEFORE DELETE ON `candidate_document`
BEGIN
	SELECT RAISE(ABORT, 'candidate_document is immutable');
END;
