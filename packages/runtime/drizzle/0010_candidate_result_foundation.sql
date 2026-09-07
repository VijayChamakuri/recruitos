CREATE TABLE `candidate_triage_result` (
	`candidate_triage_result_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`kind` text NOT NULL,
	`availability` text NOT NULL,
	`status` text NOT NULL,
	`supersedes_result_id` text,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_triage_result_kind" CHECK("candidate_triage_result"."kind" IN ('initial', 'correction')),
	CONSTRAINT "candidate_triage_result_availability" CHECK("candidate_triage_result"."availability" IN ('complete', 'unavailable')),
	CONSTRAINT "candidate_triage_result_status" CHECK("candidate_triage_result"."status" IN ('scored', 'rejected_hard_requirement', 'escalated')),
	CONSTRAINT "candidate_triage_result_lineage" CHECK((
        "candidate_triage_result"."kind" = 'initial' AND "candidate_triage_result"."supersedes_result_id" IS NULL
      ) OR (
        "candidate_triage_result"."kind" = 'correction' AND "candidate_triage_result"."supersedes_result_id" IS NOT NULL
      )),
	CONSTRAINT "candidate_triage_result_availability_status" CHECK((
        "candidate_triage_result"."availability" = 'unavailable' AND "candidate_triage_result"."status" = 'escalated'
      ) OR (
        "candidate_triage_result"."availability" = 'complete'
        AND "candidate_triage_result"."status" IN ('scored', 'escalated', 'rejected_hard_requirement')
      )),
	CONSTRAINT "candidate_triage_result_content_json" CHECK(json_valid("candidate_triage_result"."content_json") AND json_type("candidate_triage_result"."content_json") = 'object'),
	CONSTRAINT "candidate_triage_result_content_hash" CHECK(length("candidate_triage_result"."content_hash") = 64 AND "candidate_triage_result"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "candidate_triage_result_created_at" CHECK("candidate_triage_result"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_triage_result_content_hash_unique` ON `candidate_triage_result` (`content_hash`);--> statement-breakpoint
CREATE INDEX `candidate_triage_result_candidate_created` ON `candidate_triage_result` (`candidate_id`,`created_at`,`candidate_triage_result_id`);--> statement-breakpoint
CREATE TABLE `score_result` (
	`score_result_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`aggregate_text` text NOT NULL,
	`confidence_text` text NOT NULL,
	`aggregate_basis_points` integer NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "score_result_aggregate_text" CHECK(length("score_result"."aggregate_text") BETWEEN 3 AND 64
        AND "score_result"."aggregate_text" NOT GLOB '*[^0-9/]*'),
	CONSTRAINT "score_result_confidence_text" CHECK(length("score_result"."confidence_text") BETWEEN 3 AND 64
        AND "score_result"."confidence_text" NOT GLOB '*[^0-9/]*'),
	CONSTRAINT "score_result_aggregate_basis_points" CHECK("score_result"."aggregate_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "score_result_confidence_basis_points" CHECK("score_result"."confidence_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "score_result_content_json" CHECK(json_valid("score_result"."content_json")
        AND json_type("score_result"."content_json") = 'object'
        AND json_type(json_extract("score_result"."content_json", '$.contributions')) = 'array'
        AND json_array_length(json_extract("score_result"."content_json", '$.contributions')) = 6),
	CONSTRAINT "score_result_content_hash" CHECK(length("score_result"."content_hash") = 64 AND "score_result"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "score_result_created_at" CHECK("score_result"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `score_result_candidate_result_unique` ON `score_result` (`candidate_result_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `score_result_content_hash_unique` ON `score_result` (`content_hash`);--> statement-breakpoint
CREATE TABLE `candidate_result_evidence_span` (
	`candidate_result_evidence_span_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`evidence_span_id` text NOT NULL,
	`span_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_span_id`) REFERENCES `evidence_span`(`evidence_span_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_evidence_span_ordinal" CHECK("candidate_result_evidence_span"."span_ordinal" >= 0),
	CONSTRAINT "candidate_result_evidence_span_created_at" CHECK("candidate_result_evidence_span"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_evidence_span_ordinal_unique` ON `candidate_result_evidence_span` (`candidate_result_id`,`span_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_evidence_span_unique` ON `candidate_result_evidence_span` (`candidate_result_id`,`evidence_span_id`);--> statement-breakpoint
CREATE TABLE `candidate_result_evidence_gap` (
	`candidate_result_evidence_gap_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`evidence_gap_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`gap_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_gap_id`) REFERENCES `evidence_gap`(`evidence_gap_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_evidence_gap_dimension_id" CHECK(length("candidate_result_evidence_gap"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "candidate_result_evidence_gap_ordinal" CHECK("candidate_result_evidence_gap"."gap_ordinal" >= 0),
	CONSTRAINT "candidate_result_evidence_gap_created_at" CHECK("candidate_result_evidence_gap"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_evidence_gap_ordinal_unique` ON `candidate_result_evidence_gap` (`candidate_result_id`,`gap_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_evidence_gap_unique` ON `candidate_result_evidence_gap` (`candidate_result_id`,`evidence_gap_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_evidence_gap_dimension_unique` ON `candidate_result_evidence_gap` (`candidate_result_id`,`dimension_id`);--> statement-breakpoint
CREATE TABLE `candidate_result_dimension_assessment` (
	`candidate_result_dimension_assessment_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`dimension_assessment_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`assessment_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dimension_assessment_id`) REFERENCES `dimension_assessment`(`dimension_assessment_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_dimension_assessment_dimension_id" CHECK(length("candidate_result_dimension_assessment"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "candidate_result_dimension_assessment_ordinal" CHECK("candidate_result_dimension_assessment"."assessment_ordinal" >= 0),
	CONSTRAINT "candidate_result_dimension_assessment_created_at" CHECK("candidate_result_dimension_assessment"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_dimension_assessment_ordinal_unique` ON `candidate_result_dimension_assessment` (`candidate_result_id`,`assessment_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_dimension_assessment_unique` ON `candidate_result_dimension_assessment` (`candidate_result_id`,`dimension_assessment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_dimension_assessment_dimension_unique` ON `candidate_result_dimension_assessment` (`candidate_result_id`,`dimension_id`);--> statement-breakpoint
CREATE TABLE `candidate_result_structured_fact` (
	`candidate_result_structured_fact_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`structured_fact_id` text NOT NULL,
	`fact_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`structured_fact_id`) REFERENCES `structured_fact`(`structured_fact_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_structured_fact_ordinal" CHECK("candidate_result_structured_fact"."fact_ordinal" >= 0),
	CONSTRAINT "candidate_result_structured_fact_created_at" CHECK("candidate_result_structured_fact"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_structured_fact_ordinal_unique` ON `candidate_result_structured_fact` (`candidate_result_id`,`fact_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_structured_fact_unique` ON `candidate_result_structured_fact` (`candidate_result_id`,`structured_fact_id`);--> statement-breakpoint
CREATE TABLE `candidate_result_fact_conflict` (
	`candidate_result_fact_conflict_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`fact_conflict_id` text NOT NULL,
	`conflict_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fact_conflict_id`) REFERENCES `fact_conflict`(`fact_conflict_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_fact_conflict_ordinal" CHECK("candidate_result_fact_conflict"."conflict_ordinal" >= 0),
	CONSTRAINT "candidate_result_fact_conflict_created_at" CHECK("candidate_result_fact_conflict"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_fact_conflict_ordinal_unique` ON `candidate_result_fact_conflict` (`candidate_result_id`,`conflict_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_fact_conflict_unique` ON `candidate_result_fact_conflict` (`candidate_result_id`,`fact_conflict_id`);--> statement-breakpoint
CREATE TABLE `candidate_result_hard_requirement_assessment` (
	`candidate_result_hard_requirement_assessment_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`hard_requirement_assessment_id` text NOT NULL,
	`requirement_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`hard_requirement_assessment_id`) REFERENCES `hard_requirement_assessment`(`hard_requirement_assessment_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_result_hard_requirement_assessment_ordinal" CHECK("candidate_result_hard_requirement_assessment"."requirement_ordinal" >= 0),
	CONSTRAINT "candidate_result_hard_requirement_assessment_created_at" CHECK("candidate_result_hard_requirement_assessment"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_hard_requirement_assessment_ordinal_unique` ON `candidate_result_hard_requirement_assessment` (`candidate_result_id`,`requirement_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_result_hard_requirement_assessment_unique` ON `candidate_result_hard_requirement_assessment` (`candidate_result_id`,`hard_requirement_assessment_id`);--> statement-breakpoint
CREATE TRIGGER `candidate_triage_result_reject_replace`
BEFORE INSERT ON `candidate_triage_result`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_triage_result`
	WHERE `candidate_triage_result_id` = NEW.`candidate_triage_result_id`
		OR `content_hash` = NEW.`content_hash`
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
CREATE TRIGGER `score_result_reject_replace`
BEFORE INSERT ON `score_result`
WHEN EXISTS (
	SELECT 1
	FROM `score_result`
	WHERE `score_result_id` = NEW.`score_result_id`
		OR `content_hash` = NEW.`content_hash`
		OR `candidate_result_id` = NEW.`candidate_result_id`
)
BEGIN
	SELECT RAISE(ABORT, 'score_result is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `score_result_reject_update`
BEFORE UPDATE ON `score_result`
BEGIN
	SELECT RAISE(ABORT, 'score_result is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `score_result_reject_delete`
BEFORE DELETE ON `score_result`
BEGIN
	SELECT RAISE(ABORT, 'score_result is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_evidence_span_reject_replace`
BEFORE INSERT ON `candidate_result_evidence_span`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_evidence_span`
	WHERE `candidate_result_evidence_span_id` = NEW.`candidate_result_evidence_span_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `span_ordinal` = NEW.`span_ordinal`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `evidence_span_id` = NEW.`evidence_span_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_evidence_span_reject_update`
BEFORE UPDATE ON `candidate_result_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_evidence_span_reject_delete`
BEFORE DELETE ON `candidate_result_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_evidence_gap_reject_replace`
BEFORE INSERT ON `candidate_result_evidence_gap`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_evidence_gap`
	WHERE `candidate_result_evidence_gap_id` = NEW.`candidate_result_evidence_gap_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `gap_ordinal` = NEW.`gap_ordinal`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `evidence_gap_id` = NEW.`evidence_gap_id`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `dimension_id` = NEW.`dimension_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_evidence_gap is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_evidence_gap_reject_update`
BEFORE UPDATE ON `candidate_result_evidence_gap`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_evidence_gap is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_evidence_gap_reject_delete`
BEFORE DELETE ON `candidate_result_evidence_gap`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_evidence_gap is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_dimension_assessment_reject_replace`
BEFORE INSERT ON `candidate_result_dimension_assessment`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_dimension_assessment`
	WHERE `candidate_result_dimension_assessment_id` = NEW.`candidate_result_dimension_assessment_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `assessment_ordinal` = NEW.`assessment_ordinal`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `dimension_assessment_id` = NEW.`dimension_assessment_id`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `dimension_id` = NEW.`dimension_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_dimension_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_dimension_assessment_reject_update`
BEFORE UPDATE ON `candidate_result_dimension_assessment`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_dimension_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_dimension_assessment_reject_delete`
BEFORE DELETE ON `candidate_result_dimension_assessment`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_dimension_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_structured_fact_reject_replace`
BEFORE INSERT ON `candidate_result_structured_fact`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_structured_fact`
	WHERE `candidate_result_structured_fact_id` = NEW.`candidate_result_structured_fact_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `fact_ordinal` = NEW.`fact_ordinal`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `structured_fact_id` = NEW.`structured_fact_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_structured_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_structured_fact_reject_update`
BEFORE UPDATE ON `candidate_result_structured_fact`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_structured_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_structured_fact_reject_delete`
BEFORE DELETE ON `candidate_result_structured_fact`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_structured_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_fact_conflict_reject_replace`
BEFORE INSERT ON `candidate_result_fact_conflict`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_fact_conflict`
	WHERE `candidate_result_fact_conflict_id` = NEW.`candidate_result_fact_conflict_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `conflict_ordinal` = NEW.`conflict_ordinal`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `fact_conflict_id` = NEW.`fact_conflict_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_fact_conflict is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_fact_conflict_reject_update`
BEFORE UPDATE ON `candidate_result_fact_conflict`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_fact_conflict is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_fact_conflict_reject_delete`
BEFORE DELETE ON `candidate_result_fact_conflict`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_fact_conflict is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_hard_requirement_assessment_reject_replace`
BEFORE INSERT ON `candidate_result_hard_requirement_assessment`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_result_hard_requirement_assessment`
	WHERE `candidate_result_hard_requirement_assessment_id` = NEW.`candidate_result_hard_requirement_assessment_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `requirement_ordinal` = NEW.`requirement_ordinal`)
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `hard_requirement_assessment_id` = NEW.`hard_requirement_assessment_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_hard_requirement_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_hard_requirement_assessment_reject_update`
BEFORE UPDATE ON `candidate_result_hard_requirement_assessment`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_hard_requirement_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_result_hard_requirement_assessment_reject_delete`
BEFORE DELETE ON `candidate_result_hard_requirement_assessment`
BEGIN
	SELECT RAISE(ABORT, 'candidate_result_hard_requirement_assessment is immutable');
END;
