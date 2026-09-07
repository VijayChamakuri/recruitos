CREATE TABLE `structured_fact` (
	`structured_fact_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`kind` text NOT NULL,
	`semantic_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "structured_fact_kind" CHECK("structured_fact"."kind" IN ('employment_interval', 'work_authorization_statement', 'current_title', 'employer_history_entry', 'claimed_experience')),
	CONSTRAINT "structured_fact_semantic_key" CHECK(length("structured_fact"."semantic_key") BETWEEN 1 AND 256),
	CONSTRAINT "structured_fact_payload_json" CHECK(json_valid("structured_fact"."payload_json") AND json_type("structured_fact"."payload_json") = 'object'),
	CONSTRAINT "structured_fact_content_json" CHECK(json_valid("structured_fact"."content_json") AND json_type("structured_fact"."content_json") = 'object'),
	CONSTRAINT "structured_fact_content_hash" CHECK(length("structured_fact"."content_hash") = 64 AND "structured_fact"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "structured_fact_created_at" CHECK("structured_fact"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `structured_fact_content_hash_unique` ON `structured_fact` (`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `structured_fact_semantic_key_unique` ON `structured_fact` (`candidate_id`,`kind`,`semantic_key`);--> statement-breakpoint
CREATE INDEX `structured_fact_candidate` ON `structured_fact` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `structured_fact_kind` ON `structured_fact` (`kind`);--> statement-breakpoint
CREATE TABLE `structured_fact_evidence_span` (
	`structured_fact_evidence_span_id` text PRIMARY KEY NOT NULL,
	`structured_fact_id` text NOT NULL,
	`evidence_span_id` text NOT NULL,
	`span_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`structured_fact_id`) REFERENCES `structured_fact`(`structured_fact_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_span_id`) REFERENCES `evidence_span`(`evidence_span_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "structured_fact_evidence_span_ordinal" CHECK("structured_fact_evidence_span"."span_ordinal" >= 0),
	CONSTRAINT "structured_fact_evidence_span_created_at" CHECK("structured_fact_evidence_span"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `structured_fact_evidence_span_ordinal_unique` ON `structured_fact_evidence_span` (`structured_fact_id`,`span_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `structured_fact_evidence_span_unique` ON `structured_fact_evidence_span` (`structured_fact_id`,`evidence_span_id`);--> statement-breakpoint
CREATE TABLE `structured_fact_provenance` (
	`structured_fact_provenance_id` text PRIMARY KEY NOT NULL,
	`structured_fact_id` text NOT NULL,
	`source` text NOT NULL,
	`actor_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`structured_fact_id`) REFERENCES `structured_fact`(`structured_fact_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`actor_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "structured_fact_provenance_source" CHECK("structured_fact_provenance"."source" IN ('parsed', 'extracted', 'human')),
	CONSTRAINT "structured_fact_provenance_actor_presence" CHECK(("structured_fact_provenance"."source" = 'human') = ("structured_fact_provenance"."actor_id" IS NOT NULL)),
	CONSTRAINT "structured_fact_provenance_created_at" CHECK("structured_fact_provenance"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `structured_fact_provenance_fact` ON `structured_fact_provenance` (`structured_fact_id`);--> statement-breakpoint
CREATE TABLE `fact_conflict` (
	`fact_conflict_id` text PRIMARY KEY NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "fact_conflict_content_json" CHECK(json_valid("fact_conflict"."content_json")
        AND json_type("fact_conflict"."content_json") = 'object'
        AND json_type(json_extract("fact_conflict"."content_json", '$.memberIds')) = 'array'
        AND json_array_length(json_extract("fact_conflict"."content_json", '$.memberIds')) >= 2),
	CONSTRAINT "fact_conflict_content_hash" CHECK(length("fact_conflict"."content_hash") = 64 AND "fact_conflict"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "fact_conflict_created_at" CHECK("fact_conflict"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `fact_conflict_content_hash_unique` ON `fact_conflict` (`content_hash`);--> statement-breakpoint
CREATE TABLE `fact_conflict_member` (
	`fact_conflict_member_id` text PRIMARY KEY NOT NULL,
	`fact_conflict_id` text NOT NULL,
	`structured_fact_id` text NOT NULL,
	`member_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`fact_conflict_id`) REFERENCES `fact_conflict`(`fact_conflict_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`structured_fact_id`) REFERENCES `structured_fact`(`structured_fact_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fact_conflict_member_ordinal" CHECK("fact_conflict_member"."member_ordinal" >= 0),
	CONSTRAINT "fact_conflict_member_created_at" CHECK("fact_conflict_member"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `fact_conflict_member_ordinal_unique` ON `fact_conflict_member` (`fact_conflict_id`,`member_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `fact_conflict_member_fact_unique` ON `fact_conflict_member` (`fact_conflict_id`,`structured_fact_id`);--> statement-breakpoint
CREATE TABLE `hard_requirement_assessment` (
	`hard_requirement_assessment_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`requirement_field_id` text NOT NULL,
	`outcome` text NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "hard_requirement_assessment_requirement_field_id" CHECK("hard_requirement_assessment"."requirement_field_id" IN ('years_experience', 'work_authorization', 'current_title', 'employer_history')),
	CONSTRAINT "hard_requirement_assessment_outcome" CHECK("hard_requirement_assessment"."outcome" IN ('pass', 'fail', 'unknown')),
	CONSTRAINT "hard_requirement_assessment_content_json" CHECK(json_valid("hard_requirement_assessment"."content_json")
        AND json_type("hard_requirement_assessment"."content_json") = 'object'
        AND json_type(json_extract("hard_requirement_assessment"."content_json", '$.facts')) = 'array'
        AND (
          "hard_requirement_assessment"."outcome" = 'unknown'
          OR json_array_length(json_extract("hard_requirement_assessment"."content_json", '$.facts')) >= 1
        )),
	CONSTRAINT "hard_requirement_assessment_content_hash" CHECK(length("hard_requirement_assessment"."content_hash") = 64 AND "hard_requirement_assessment"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "hard_requirement_assessment_created_at" CHECK("hard_requirement_assessment"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `hard_requirement_assessment_content_hash_unique` ON `hard_requirement_assessment` (`content_hash`);--> statement-breakpoint
CREATE INDEX `hard_requirement_assessment_candidate` ON `hard_requirement_assessment` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `hard_requirement_assessment_field` ON `hard_requirement_assessment` (`requirement_field_id`);--> statement-breakpoint
CREATE TABLE `hard_requirement_assessment_fact` (
	`hard_requirement_assessment_fact_id` text PRIMARY KEY NOT NULL,
	`hard_requirement_assessment_id` text NOT NULL,
	`structured_fact_id` text NOT NULL,
	`polarity` text NOT NULL,
	`fact_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`hard_requirement_assessment_id`) REFERENCES `hard_requirement_assessment`(`hard_requirement_assessment_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`structured_fact_id`) REFERENCES `structured_fact`(`structured_fact_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "hard_requirement_assessment_fact_polarity" CHECK("hard_requirement_assessment_fact"."polarity" IN ('supporting', 'contradicting')),
	CONSTRAINT "hard_requirement_assessment_fact_ordinal" CHECK("hard_requirement_assessment_fact"."fact_ordinal" >= 0),
	CONSTRAINT "hard_requirement_assessment_fact_created_at" CHECK("hard_requirement_assessment_fact"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `hard_requirement_assessment_fact_ordinal_unique` ON `hard_requirement_assessment_fact` (`hard_requirement_assessment_id`,`fact_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `hard_requirement_assessment_fact_unique` ON `hard_requirement_assessment_fact` (`hard_requirement_assessment_id`,`structured_fact_id`);--> statement-breakpoint
CREATE TRIGGER `structured_fact_reject_replace`
BEFORE INSERT ON `structured_fact`
WHEN EXISTS (
	SELECT 1
	FROM `structured_fact`
	WHERE `structured_fact_id` = NEW.`structured_fact_id`
		OR `content_hash` = NEW.`content_hash`
		OR (`candidate_id` = NEW.`candidate_id` AND `kind` = NEW.`kind` AND `semantic_key` = NEW.`semantic_key`)
)
BEGIN
	SELECT RAISE(ABORT, 'structured_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_reject_update`
BEFORE UPDATE ON `structured_fact`
BEGIN
	SELECT RAISE(ABORT, 'structured_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_reject_delete`
BEFORE DELETE ON `structured_fact`
BEGIN
	SELECT RAISE(ABORT, 'structured_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_evidence_span_reject_replace`
BEFORE INSERT ON `structured_fact_evidence_span`
WHEN EXISTS (
	SELECT 1
	FROM `structured_fact_evidence_span`
	WHERE `structured_fact_evidence_span_id` = NEW.`structured_fact_evidence_span_id`
		OR (`structured_fact_id` = NEW.`structured_fact_id` AND `span_ordinal` = NEW.`span_ordinal`)
		OR (`structured_fact_id` = NEW.`structured_fact_id` AND `evidence_span_id` = NEW.`evidence_span_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'structured_fact_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_evidence_span_reject_update`
BEFORE UPDATE ON `structured_fact_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'structured_fact_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_evidence_span_reject_delete`
BEFORE DELETE ON `structured_fact_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'structured_fact_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_provenance_reject_replace`
BEFORE INSERT ON `structured_fact_provenance`
WHEN EXISTS (
	SELECT 1
	FROM `structured_fact_provenance`
	WHERE `structured_fact_provenance_id` = NEW.`structured_fact_provenance_id`
)
BEGIN
	SELECT RAISE(ABORT, 'structured_fact_provenance is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_provenance_reject_update`
BEFORE UPDATE ON `structured_fact_provenance`
BEGIN
	SELECT RAISE(ABORT, 'structured_fact_provenance is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `structured_fact_provenance_reject_delete`
BEFORE DELETE ON `structured_fact_provenance`
BEGIN
	SELECT RAISE(ABORT, 'structured_fact_provenance is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fact_conflict_reject_replace`
BEFORE INSERT ON `fact_conflict`
WHEN EXISTS (
	SELECT 1
	FROM `fact_conflict`
	WHERE `fact_conflict_id` = NEW.`fact_conflict_id`
		OR `content_hash` = NEW.`content_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'fact_conflict is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fact_conflict_reject_update`
BEFORE UPDATE ON `fact_conflict`
BEGIN
	SELECT RAISE(ABORT, 'fact_conflict is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fact_conflict_reject_delete`
BEFORE DELETE ON `fact_conflict`
BEGIN
	SELECT RAISE(ABORT, 'fact_conflict is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fact_conflict_member_reject_replace`
BEFORE INSERT ON `fact_conflict_member`
WHEN EXISTS (
	SELECT 1
	FROM `fact_conflict_member`
	WHERE `fact_conflict_member_id` = NEW.`fact_conflict_member_id`
		OR (`fact_conflict_id` = NEW.`fact_conflict_id` AND `member_ordinal` = NEW.`member_ordinal`)
		OR (`fact_conflict_id` = NEW.`fact_conflict_id` AND `structured_fact_id` = NEW.`structured_fact_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'fact_conflict_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fact_conflict_member_reject_update`
BEFORE UPDATE ON `fact_conflict_member`
BEGIN
	SELECT RAISE(ABORT, 'fact_conflict_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fact_conflict_member_reject_delete`
BEFORE DELETE ON `fact_conflict_member`
BEGIN
	SELECT RAISE(ABORT, 'fact_conflict_member is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `hard_requirement_assessment_reject_replace`
BEFORE INSERT ON `hard_requirement_assessment`
WHEN EXISTS (
	SELECT 1
	FROM `hard_requirement_assessment`
	WHERE `hard_requirement_assessment_id` = NEW.`hard_requirement_assessment_id`
		OR `content_hash` = NEW.`content_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'hard_requirement_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `hard_requirement_assessment_reject_update`
BEFORE UPDATE ON `hard_requirement_assessment`
BEGIN
	SELECT RAISE(ABORT, 'hard_requirement_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `hard_requirement_assessment_reject_delete`
BEFORE DELETE ON `hard_requirement_assessment`
BEGIN
	SELECT RAISE(ABORT, 'hard_requirement_assessment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `hard_requirement_assessment_fact_reject_replace`
BEFORE INSERT ON `hard_requirement_assessment_fact`
WHEN EXISTS (
	SELECT 1
	FROM `hard_requirement_assessment_fact`
	WHERE `hard_requirement_assessment_fact_id` = NEW.`hard_requirement_assessment_fact_id`
		OR (`hard_requirement_assessment_id` = NEW.`hard_requirement_assessment_id` AND `fact_ordinal` = NEW.`fact_ordinal`)
		OR (`hard_requirement_assessment_id` = NEW.`hard_requirement_assessment_id` AND `structured_fact_id` = NEW.`structured_fact_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'hard_requirement_assessment_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `hard_requirement_assessment_fact_reject_update`
BEFORE UPDATE ON `hard_requirement_assessment_fact`
BEGIN
	SELECT RAISE(ABORT, 'hard_requirement_assessment_fact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `hard_requirement_assessment_fact_reject_delete`
BEFORE DELETE ON `hard_requirement_assessment_fact`
BEGIN
	SELECT RAISE(ABORT, 'hard_requirement_assessment_fact is immutable');
END;
