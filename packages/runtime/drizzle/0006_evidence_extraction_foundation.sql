CREATE TABLE `extraction_run` (
	`extraction_run_id` text PRIMARY KEY NOT NULL,
	`spans_returned` integer NOT NULL,
	`spans_located` integer NOT NULL,
	`dropped_quotes_json` text NOT NULL,
	`dropped_quotes_hash` text NOT NULL,
	`model_id` text NOT NULL,
	`fixture_key` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "extraction_run_spans_returned" CHECK("extraction_run"."spans_returned" >= 0),
	CONSTRAINT "extraction_run_spans_located" CHECK("extraction_run"."spans_located" >= 0 AND "extraction_run"."spans_located" <= "extraction_run"."spans_returned"),
	CONSTRAINT "extraction_run_dropped_quotes_json" CHECK(json_valid("extraction_run"."dropped_quotes_json")
        AND json_type("extraction_run"."dropped_quotes_json") = 'array'
        AND json_array_length("extraction_run"."dropped_quotes_json") = "extraction_run"."spans_returned" - "extraction_run"."spans_located"),
	CONSTRAINT "extraction_run_dropped_quotes_hash" CHECK(length("extraction_run"."dropped_quotes_hash") = 64 AND "extraction_run"."dropped_quotes_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_run_model_id" CHECK(length("extraction_run"."model_id") BETWEEN 1 AND 200),
	CONSTRAINT "extraction_run_fixture_key" CHECK("extraction_run"."fixture_key" IS NULL OR (length("extraction_run"."fixture_key") = 64 AND "extraction_run"."fixture_key" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "extraction_run_created_at" CHECK("extraction_run"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `evidence_span` (
	`evidence_span_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`quoted_text` text NOT NULL,
	`dimension_id` text NOT NULL,
	`polarity` text NOT NULL,
	`source` text NOT NULL,
	`match_quality` text NOT NULL,
	`extractor_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `source_document`(`source_document_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "evidence_span_start" CHECK("evidence_span"."start" >= 0),
	CONSTRAINT "evidence_span_end" CHECK("evidence_span"."end" > "evidence_span"."start"),
	CONSTRAINT "evidence_span_quoted_text" CHECK(length("evidence_span"."quoted_text") BETWEEN 1 AND 240),
	CONSTRAINT "evidence_span_dimension_id" CHECK(length("evidence_span"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "evidence_span_polarity" CHECK("evidence_span"."polarity" IN ('supporting', 'contradicting')),
	CONSTRAINT "evidence_span_source" CHECK("evidence_span"."source" IN ('extracted', 'human')),
	CONSTRAINT "evidence_span_match_quality" CHECK("evidence_span"."match_quality" IN ('exact', 'normalized', 'fuzzy')),
	CONSTRAINT "evidence_span_extractor_version" CHECK(length("evidence_span"."extractor_version") BETWEEN 1 AND 64),
	CONSTRAINT "evidence_span_created_at" CHECK("evidence_span"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `evidence_span_document` ON `evidence_span` (`document_id`);--> statement-breakpoint
CREATE INDEX `evidence_span_dimension` ON `evidence_span` (`dimension_id`);--> statement-breakpoint
CREATE TABLE `evidence_gap` (
	`evidence_gap_id` text PRIMARY KEY NOT NULL,
	`dimension_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`documents_searched_json` text NOT NULL,
	`documents_searched_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "evidence_gap_dimension_id" CHECK(length("evidence_gap"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "evidence_gap_reason_code" CHECK(length("evidence_gap"."reason_code") BETWEEN 1 AND 256
        AND "evidence_gap"."reason_code" NOT GLOB '*[^!-~]*'),
	CONSTRAINT "evidence_gap_documents_searched_json" CHECK(json_valid("evidence_gap"."documents_searched_json")
        AND json_type("evidence_gap"."documents_searched_json") = 'array'
        AND json_array_length("evidence_gap"."documents_searched_json") >= 1),
	CONSTRAINT "evidence_gap_documents_searched_hash" CHECK(length("evidence_gap"."documents_searched_hash") = 64 AND "evidence_gap"."documents_searched_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "evidence_gap_created_at" CHECK("evidence_gap"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `evidence_gap_dimension` ON `evidence_gap` (`dimension_id`);--> statement-breakpoint
CREATE TABLE `dimension_assessment` (
	`dimension_assessment_id` text PRIMARY KEY NOT NULL,
	`dimension_id` text NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`actor_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`actor_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dimension_assessment_dimension_id" CHECK(length("dimension_assessment"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "dimension_assessment_level" CHECK("dimension_assessment"."level" IN ('none', 'weak', 'partial', 'strong')),
	CONSTRAINT "dimension_assessment_source" CHECK("dimension_assessment"."source" IN ('extracted', 'human')),
	CONSTRAINT "dimension_assessment_actor_presence" CHECK(("dimension_assessment"."source" = 'human') = ("dimension_assessment"."actor_id" IS NOT NULL)),
	CONSTRAINT "dimension_assessment_created_at" CHECK("dimension_assessment"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `dimension_assessment_dimension` ON `dimension_assessment` (`dimension_id`);--> statement-breakpoint
CREATE TABLE `dimension_assessment_evidence_span` (
	`dimension_assessment_evidence_span_id` text PRIMARY KEY NOT NULL,
	`dimension_assessment_id` text NOT NULL,
	`evidence_span_id` text NOT NULL,
	`span_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dimension_assessment_id`) REFERENCES `dimension_assessment`(`dimension_assessment_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_span_id`) REFERENCES `evidence_span`(`evidence_span_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dimension_assessment_evidence_span_ordinal" CHECK("dimension_assessment_evidence_span"."span_ordinal" >= 0),
	CONSTRAINT "dimension_assessment_evidence_span_created_at" CHECK("dimension_assessment_evidence_span"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `dimension_assessment_evidence_span_ordinal_unique` ON `dimension_assessment_evidence_span` (`dimension_assessment_id`,`span_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `dimension_assessment_evidence_span_unique` ON `dimension_assessment_evidence_span` (`dimension_assessment_id`,`evidence_span_id`);--> statement-breakpoint
CREATE TRIGGER `extraction_run_reject_replace`
BEFORE INSERT ON `extraction_run`
WHEN EXISTS (
	SELECT 1
	FROM `extraction_run`
	WHERE `extraction_run_id` = NEW.`extraction_run_id`
)
BEGIN
	SELECT RAISE(ABORT, 'extraction_run is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_run_reject_update`
BEFORE UPDATE ON `extraction_run`
BEGIN
	SELECT RAISE(ABORT, 'extraction_run is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_run_reject_delete`
BEFORE DELETE ON `extraction_run`
BEGIN
	SELECT RAISE(ABORT, 'extraction_run is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_span_reject_replace`
BEFORE INSERT ON `evidence_span`
WHEN EXISTS (
	SELECT 1
	FROM `evidence_span`
	WHERE `evidence_span_id` = NEW.`evidence_span_id`
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_span_reject_update`
BEFORE UPDATE ON `evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_span_reject_delete`
BEFORE DELETE ON `evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_gap_reject_replace`
BEFORE INSERT ON `evidence_gap`
WHEN EXISTS (
	SELECT 1
	FROM `evidence_gap`
	WHERE `evidence_gap_id` = NEW.`evidence_gap_id`
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_gap is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_gap_reject_update`
BEFORE UPDATE ON `evidence_gap`
BEGIN
	SELECT RAISE(ABORT, 'evidence_gap is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_gap_reject_delete`
BEFORE DELETE ON `evidence_gap`
BEGIN
	SELECT RAISE(ABORT, 'evidence_gap is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `dimension_assessment_reject_replace`
BEFORE INSERT ON `dimension_assessment`
WHEN EXISTS (
	SELECT 1
	FROM `dimension_assessment`
	WHERE `dimension_assessment_id` = NEW.`dimension_assessment_id`
)
BEGIN
	SELECT RAISE(ABORT, 'dimension_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `dimension_assessment_reject_update`
BEFORE UPDATE ON `dimension_assessment`
BEGIN
	SELECT RAISE(ABORT, 'dimension_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `dimension_assessment_reject_delete`
BEFORE DELETE ON `dimension_assessment`
BEGIN
	SELECT RAISE(ABORT, 'dimension_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `dimension_assessment_evidence_span_reject_replace`
BEFORE INSERT ON `dimension_assessment_evidence_span`
WHEN EXISTS (
	SELECT 1
	FROM `dimension_assessment_evidence_span`
	WHERE `dimension_assessment_evidence_span_id` = NEW.`dimension_assessment_evidence_span_id`
		OR (`dimension_assessment_id` = NEW.`dimension_assessment_id` AND `span_ordinal` = NEW.`span_ordinal`)
		OR (`dimension_assessment_id` = NEW.`dimension_assessment_id` AND `evidence_span_id` = NEW.`evidence_span_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'dimension_assessment_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `dimension_assessment_evidence_span_reject_update`
BEFORE UPDATE ON `dimension_assessment_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'dimension_assessment_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `dimension_assessment_evidence_span_reject_delete`
BEFORE DELETE ON `dimension_assessment_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'dimension_assessment_evidence_span is immutable');
END;
