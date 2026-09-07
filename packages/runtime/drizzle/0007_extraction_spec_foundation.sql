CREATE TABLE `extraction_spec` (
	`extraction_spec_id` text PRIMARY KEY NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`model_id` text NOT NULL,
	`extractor_version` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`schema_hash` text NOT NULL,
	`dimension_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "extraction_spec_content_json" CHECK(json_valid("extraction_spec"."content_json") AND json_type("extraction_spec"."content_json") = 'object'),
	CONSTRAINT "extraction_spec_content_hash" CHECK(length("extraction_spec"."content_hash") = 64 AND "extraction_spec"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_spec_model_id" CHECK(length("extraction_spec"."model_id") BETWEEN 1 AND 200),
	CONSTRAINT "extraction_spec_extractor_version" CHECK(length("extraction_spec"."extractor_version") BETWEEN 1 AND 64),
	CONSTRAINT "extraction_spec_prompt_hash" CHECK(length("extraction_spec"."prompt_hash") = 64 AND "extraction_spec"."prompt_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_spec_schema_hash" CHECK(length("extraction_spec"."schema_hash") = 64 AND "extraction_spec"."schema_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_spec_dimension_id" CHECK(length("extraction_spec"."dimension_id") BETWEEN 1 AND 128),
	CONSTRAINT "extraction_spec_created_at" CHECK("extraction_spec"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_spec_content_hash_unique` ON `extraction_spec` (`content_hash`);--> statement-breakpoint
CREATE INDEX `extraction_spec_dimension` ON `extraction_spec` (`dimension_id`);--> statement-breakpoint
CREATE TABLE `extraction_artifact` (
	`extraction_artifact_id` text PRIMARY KEY NOT NULL,
	`spec_id` text NOT NULL,
	`source_document_id` text NOT NULL,
	`accepted_output_json` text NOT NULL,
	`accepted_output_hash` text NOT NULL,
	`rejected_claims_json` text NOT NULL,
	`rejected_claims_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`spec_id`) REFERENCES `extraction_spec`(`extraction_spec_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_document_id`) REFERENCES `source_document`(`source_document_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "extraction_artifact_accepted_output_json" CHECK(json_valid("extraction_artifact"."accepted_output_json")
        AND json_type("extraction_artifact"."accepted_output_json") = 'object'
        AND json_type(json_extract("extraction_artifact"."accepted_output_json", '$.spans')) = 'array'
        AND json_array_length(json_extract("extraction_artifact"."accepted_output_json", '$.spans')) BETWEEN 0 AND 12),
	CONSTRAINT "extraction_artifact_accepted_output_hash" CHECK(length("extraction_artifact"."accepted_output_hash") = 64 AND "extraction_artifact"."accepted_output_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_artifact_rejected_claims_json" CHECK(json_valid("extraction_artifact"."rejected_claims_json")
        AND json_type("extraction_artifact"."rejected_claims_json") = 'array'
        AND json_array_length("extraction_artifact"."rejected_claims_json") BETWEEN 0 AND 8),
	CONSTRAINT "extraction_artifact_rejected_claims_hash" CHECK(length("extraction_artifact"."rejected_claims_hash") = 64 AND "extraction_artifact"."rejected_claims_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_artifact_content_hash" CHECK(length("extraction_artifact"."content_hash") = 64 AND "extraction_artifact"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_artifact_created_at" CHECK("extraction_artifact"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_artifact_content_hash_unique` ON `extraction_artifact` (`content_hash`);--> statement-breakpoint
CREATE INDEX `extraction_artifact_spec` ON `extraction_artifact` (`spec_id`);--> statement-breakpoint
CREATE INDEX `extraction_artifact_document` ON `extraction_artifact` (`source_document_id`);--> statement-breakpoint
CREATE TABLE `extraction_failure` (
	`extraction_failure_id` text PRIMARY KEY NOT NULL,
	`spec_id` text NOT NULL,
	`source_document_id` text NOT NULL,
	`error_class` text NOT NULL,
	`response_hash` text NOT NULL,
	`response_byte_length` integer NOT NULL,
	`diagnostic_json` text NOT NULL,
	`diagnostic_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`spec_id`) REFERENCES `extraction_spec`(`extraction_spec_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_document_id`) REFERENCES `source_document`(`source_document_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "extraction_failure_error_class" CHECK("extraction_failure"."error_class" IN ('structurally_invalid', 'oversized_response', 'identity_mismatch', 'cardinality_exceeded')),
	CONSTRAINT "extraction_failure_response_hash" CHECK(length("extraction_failure"."response_hash") = 64 AND "extraction_failure"."response_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_failure_response_byte_length" CHECK("extraction_failure"."response_byte_length" >= 0),
	CONSTRAINT "extraction_failure_oversized_response" CHECK(("extraction_failure"."error_class" = 'oversized_response') = ("extraction_failure"."response_byte_length" > 65536)),
	CONSTRAINT "extraction_failure_diagnostic_json" CHECK(json_valid("extraction_failure"."diagnostic_json")
        AND json_type("extraction_failure"."diagnostic_json") = 'object'
        AND json_type(json_extract("extraction_failure"."diagnostic_json", '$.details')) = 'array'
        AND json_array_length(json_extract("extraction_failure"."diagnostic_json", '$.details')) BETWEEN 0 AND 8),
	CONSTRAINT "extraction_failure_diagnostic_hash" CHECK(length("extraction_failure"."diagnostic_hash") = 64 AND "extraction_failure"."diagnostic_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_failure_content_hash" CHECK(length("extraction_failure"."content_hash") = 64 AND "extraction_failure"."content_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "extraction_failure_created_at" CHECK("extraction_failure"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_failure_content_hash_unique` ON `extraction_failure` (`content_hash`);--> statement-breakpoint
CREATE INDEX `extraction_failure_spec` ON `extraction_failure` (`spec_id`);--> statement-breakpoint
CREATE INDEX `extraction_failure_document` ON `extraction_failure` (`source_document_id`);--> statement-breakpoint
CREATE INDEX `extraction_failure_error_class` ON `extraction_failure` (`error_class`);--> statement-breakpoint
CREATE TRIGGER `extraction_spec_reject_replace`
BEFORE INSERT ON `extraction_spec`
WHEN EXISTS (
	SELECT 1
	FROM `extraction_spec`
	WHERE `extraction_spec_id` = NEW.`extraction_spec_id`
		OR `content_hash` = NEW.`content_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'extraction_spec is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_spec_reject_update`
BEFORE UPDATE ON `extraction_spec`
BEGIN
	SELECT RAISE(ABORT, 'extraction_spec is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_spec_reject_delete`
BEFORE DELETE ON `extraction_spec`
BEGIN
	SELECT RAISE(ABORT, 'extraction_spec is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_artifact_reject_replace`
BEFORE INSERT ON `extraction_artifact`
WHEN EXISTS (
	SELECT 1
	FROM `extraction_artifact`
	WHERE `extraction_artifact_id` = NEW.`extraction_artifact_id`
		OR `content_hash` = NEW.`content_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'extraction_artifact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_artifact_reject_update`
BEFORE UPDATE ON `extraction_artifact`
BEGIN
	SELECT RAISE(ABORT, 'extraction_artifact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_artifact_reject_delete`
BEFORE DELETE ON `extraction_artifact`
BEGIN
	SELECT RAISE(ABORT, 'extraction_artifact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_failure_reject_replace`
BEFORE INSERT ON `extraction_failure`
WHEN EXISTS (
	SELECT 1
	FROM `extraction_failure`
	WHERE `extraction_failure_id` = NEW.`extraction_failure_id`
		OR `content_hash` = NEW.`content_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'extraction_failure is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_failure_reject_update`
BEFORE UPDATE ON `extraction_failure`
BEGIN
	SELECT RAISE(ABORT, 'extraction_failure is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `extraction_failure_reject_delete`
BEFORE DELETE ON `extraction_failure`
BEGIN
	SELECT RAISE(ABORT, 'extraction_failure is immutable');
END;
