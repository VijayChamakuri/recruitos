CREATE TABLE `proposal` (
	`proposal_id` text PRIMARY KEY NOT NULL,
	`candidate_result_id` text NOT NULL,
	`proposal_kind` text NOT NULL,
	`proposal_ordinal` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_result_id`) REFERENCES `candidate_triage_result`(`candidate_triage_result_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "proposal_kind" CHECK("proposal"."proposal_kind" IN (
        'follow_up_draft',
        'ats_stage_change',
        'shortlist_inclusion',
        'rejection'
      )),
	CONSTRAINT "proposal_payload_json" CHECK(json_valid("proposal"."payload_json") AND json_type("proposal"."payload_json") = 'object'),
	CONSTRAINT "proposal_payload_hash" CHECK(length("proposal"."payload_hash") = 64 AND "proposal"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "proposal_ordinal" CHECK("proposal"."proposal_ordinal" >= 0),
	CONSTRAINT "proposal_created_at" CHECK("proposal"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `proposal_evidence_span` (
	`proposal_evidence_span_id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`evidence_span_id` text NOT NULL,
	`span_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`proposal_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_span_id`) REFERENCES `evidence_span`(`evidence_span_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "proposal_evidence_span_ordinal" CHECK("proposal_evidence_span"."span_ordinal" >= 0),
	CONSTRAINT "proposal_evidence_span_created_at" CHECK("proposal_evidence_span"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `review_decision` (
	`review_decision_id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`decision_kind` text NOT NULL,
	`decision_ordinal` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`proposal_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`actor_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_decision_kind" CHECK("review_decision"."decision_kind" IN (
        'approve',
        'edit',
        'reject',
        'request_evidence'
      )),
	CONSTRAINT "review_decision_actor" CHECK("review_decision"."actor_id" != 'system:runtime'),
	CONSTRAINT "review_decision_payload_json" CHECK(json_valid("review_decision"."payload_json") AND json_type("review_decision"."payload_json") = 'object'),
	CONSTRAINT "review_decision_payload_hash" CHECK(length("review_decision"."payload_hash") = 64 AND "review_decision"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "review_decision_ordinal" CHECK("review_decision"."decision_ordinal" >= 0),
	CONSTRAINT "review_decision_created_at" CHECK("review_decision"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `proposal_head` (
	`proposal_id` text PRIMARY KEY NOT NULL,
	`current_decision_id` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`proposal_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_decision_id`) REFERENCES `review_decision`(`review_decision_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "proposal_head_version" CHECK("proposal_head"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_ordinal_unique` ON `proposal` (`candidate_result_id`,`proposal_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_shortlist_result_unique` ON `proposal` (`candidate_result_id`) WHERE "proposal"."proposal_kind" = 'shortlist_inclusion';--> statement-breakpoint
CREATE INDEX `proposal_result_created` ON `proposal` (`candidate_result_id`,`created_at`,`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_evidence_span_ordinal_unique` ON `proposal_evidence_span` (`proposal_id`,`span_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_evidence_span_unique` ON `proposal_evidence_span` (`proposal_id`,`evidence_span_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_decision_ordinal_unique` ON `review_decision` (`proposal_id`,`decision_ordinal`);--> statement-breakpoint
CREATE INDEX `review_decision_proposal_created` ON `review_decision` (`proposal_id`,`created_at`,`review_decision_id`);--> statement-breakpoint
CREATE TRIGGER `proposal_reject_replace`
BEFORE INSERT ON `proposal`
WHEN EXISTS (
	SELECT 1
	FROM `proposal`
	WHERE `proposal_id` = NEW.`proposal_id`
		OR (`candidate_result_id` = NEW.`candidate_result_id` AND `proposal_ordinal` = NEW.`proposal_ordinal`)
		OR (
			NEW.`proposal_kind` = 'shortlist_inclusion'
			AND `proposal_kind` = 'shortlist_inclusion'
			AND `candidate_result_id` = NEW.`candidate_result_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'proposal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_reject_update`
BEFORE UPDATE ON `proposal`
BEGIN
	SELECT RAISE(ABORT, 'proposal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_reject_delete`
BEFORE DELETE ON `proposal`
BEGIN
	SELECT RAISE(ABORT, 'proposal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_evidence_span_reject_replace`
BEFORE INSERT ON `proposal_evidence_span`
WHEN EXISTS (
	SELECT 1
	FROM `proposal_evidence_span`
	WHERE `proposal_evidence_span_id` = NEW.`proposal_evidence_span_id`
		OR (`proposal_id` = NEW.`proposal_id` AND `span_ordinal` = NEW.`span_ordinal`)
		OR (`proposal_id` = NEW.`proposal_id` AND `evidence_span_id` = NEW.`evidence_span_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'proposal_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_evidence_span_reject_update`
BEFORE UPDATE ON `proposal_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'proposal_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_evidence_span_reject_delete`
BEFORE DELETE ON `proposal_evidence_span`
BEGIN
	SELECT RAISE(ABORT, 'proposal_evidence_span is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `review_decision_reject_replace`
BEFORE INSERT ON `review_decision`
WHEN EXISTS (
	SELECT 1
	FROM `review_decision`
	WHERE `review_decision_id` = NEW.`review_decision_id`
		OR (`proposal_id` = NEW.`proposal_id` AND `decision_ordinal` = NEW.`decision_ordinal`)
)
BEGIN
	SELECT RAISE(ABORT, 'review_decision is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `review_decision_reject_update`
BEFORE UPDATE ON `review_decision`
BEGIN
	SELECT RAISE(ABORT, 'review_decision is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `review_decision_reject_delete`
BEFORE DELETE ON `review_decision`
BEGIN
	SELECT RAISE(ABORT, 'review_decision is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_reject_replace`
BEFORE INSERT ON `proposal_head`
WHEN EXISTS (
	SELECT 1
	FROM `proposal_head`
	WHERE `proposal_id` = NEW.`proposal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'proposal_head cannot be replaced');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_insert_version`
BEFORE INSERT ON `proposal_head`
WHEN NEW.`version` != 1
BEGIN
	SELECT RAISE(ABORT, 'proposal_head insert version must be 1');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_insert_decision_owner`
BEFORE INSERT ON `proposal_head`
WHEN NOT EXISTS (
	SELECT 1
	FROM `review_decision`
	WHERE `review_decision_id` = NEW.`current_decision_id`
		AND `proposal_id` = NEW.`proposal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'proposal_head current_decision_id must belong to the proposal');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_reject_delete`
BEFORE DELETE ON `proposal_head`
BEGIN
	SELECT RAISE(ABORT, 'proposal_head cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_update_identity`
BEFORE UPDATE OF `proposal_id` ON `proposal_head`
BEGIN
	SELECT RAISE(ABORT, 'proposal_head identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_update_version`
BEFORE UPDATE ON `proposal_head`
WHEN NEW.`version` != OLD.`version` + 1
BEGIN
	SELECT RAISE(ABORT, 'proposal_head version must increment by 1');
END;
--> statement-breakpoint
CREATE TRIGGER `proposal_head_update_decision_owner`
BEFORE UPDATE ON `proposal_head`
WHEN NOT EXISTS (
	SELECT 1
	FROM `review_decision`
	WHERE `review_decision_id` = NEW.`current_decision_id`
		AND `proposal_id` = NEW.`proposal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'proposal_head current_decision_id must belong to the proposal');
END;
