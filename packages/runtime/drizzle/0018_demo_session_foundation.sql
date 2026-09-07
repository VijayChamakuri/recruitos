CREATE TABLE `candidate_demographics` (
	`candidate_demographics_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`sex` text NOT NULL,
	`race_ethnicity` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidate`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "candidate_demographics_sex" CHECK("candidate_demographics"."sex" IN ('female', 'male', 'not_specified')),
	CONSTRAINT "candidate_demographics_race_ethnicity" CHECK("candidate_demographics"."race_ethnicity" IN (
        'hispanic_or_latino',
        'white',
        'black_or_african_american',
        'asian',
        'native_hawaiian_or_other_pacific_islander',
        'american_indian_or_alaska_native',
        'two_or_more_races',
        'not_specified'
      )),
	CONSTRAINT "candidate_demographics_created_at" CHECK("candidate_demographics"."created_at" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_demographics_candidate_unique` ON `candidate_demographics` (`candidate_id`);
--> statement-breakpoint
CREATE TABLE `demo_session` (
	`demo_session_id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`generation` integer NOT NULL,
	`web_owner` text,
	`heartbeat_at` integer,
	`expires_at` integer,
	`seed_hash` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "demo_session_identity" CHECK("demo_session"."demo_session_id" = 'synthetic_demo'),
	CONSTRAINT "demo_session_purpose" CHECK("demo_session"."purpose" = 'synthetic_demo'),
	CONSTRAINT "demo_session_generation" CHECK("demo_session"."generation" >= 1),
	CONSTRAINT "demo_session_seed_hash" CHECK(length("demo_session"."seed_hash") = 64 AND "demo_session"."seed_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "demo_session_version" CHECK("demo_session"."version" >= 1),
	CONSTRAINT "demo_session_created_at" CHECK("demo_session"."created_at" >= 0),
	CONSTRAINT "demo_session_updated_at" CHECK("demo_session"."updated_at" >= "demo_session"."created_at"),
	CONSTRAINT "demo_session_web_owner" CHECK("demo_session"."web_owner" IS NULL OR (
        length("demo_session"."web_owner") BETWEEN 1 AND 128
        AND "demo_session"."web_owner" NOT GLOB '*[^!-~]*'
      )),
	CONSTRAINT "demo_session_ownership_shape" CHECK((
        "demo_session"."web_owner" IS NULL
        AND "demo_session"."heartbeat_at" IS NULL
        AND "demo_session"."expires_at" IS NULL
      ) OR (
        "demo_session"."web_owner" IS NOT NULL
        AND "demo_session"."heartbeat_at" IS NOT NULL
        AND "demo_session"."expires_at" IS NOT NULL
        AND "demo_session"."heartbeat_at" >= 0
        AND "demo_session"."expires_at" = "demo_session"."heartbeat_at" + 15000
      ))
) STRICT;
--> statement-breakpoint
CREATE TRIGGER `candidate_demographics_reject_replace`
BEFORE INSERT ON `candidate_demographics`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_demographics`
	WHERE `candidate_demographics_id` = NEW.`candidate_demographics_id`
		OR `candidate_id` = NEW.`candidate_id`
)
BEGIN
	SELECT RAISE(ABORT, 'candidate_demographics is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_demographics_reject_update`
BEFORE UPDATE ON `candidate_demographics`
BEGIN
	SELECT RAISE(ABORT, 'candidate_demographics is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `candidate_demographics_reject_delete`
BEFORE DELETE ON `candidate_demographics`
BEGIN
	SELECT RAISE(ABORT, 'candidate_demographics is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `demo_session_reject_replace`
BEFORE INSERT ON `demo_session`
WHEN EXISTS (
	SELECT 1
	FROM `demo_session`
	WHERE `demo_session_id` = NEW.`demo_session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'demo_session identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `demo_session_reject_pinned_update`
BEFORE UPDATE ON `demo_session`
WHEN NEW.`demo_session_id` IS NOT OLD.`demo_session_id`
	OR NEW.`purpose` IS NOT OLD.`purpose`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR NEW.`version` IS NOT OLD.`version` + 1
BEGIN
	SELECT RAISE(ABORT, 'demo_session pinned fields are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `demo_session_reject_delete`
BEFORE DELETE ON `demo_session`
BEGIN
	SELECT RAISE(ABORT, 'demo_session rows cannot be deleted');
END;
