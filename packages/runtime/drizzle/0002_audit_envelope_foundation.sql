CREATE TABLE `audit_event` (
	`audit_event_id` text PRIMARY KEY NOT NULL,
	`command_id` text,
	`event_ordinal` integer,
	`actor_id` text NOT NULL,
	`actor_display_name` text NOT NULL,
	`event_name` text NOT NULL,
	`event_version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `command_receipt`(`command_id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "audit_event_command_ordinal_pair" CHECK(("audit_event"."command_id" IS NULL AND "audit_event"."event_ordinal" IS NULL) OR ("audit_event"."command_id" IS NOT NULL AND "audit_event"."event_ordinal" IS NOT NULL)),
	CONSTRAINT "audit_event_event_ordinal" CHECK("audit_event"."event_ordinal" IS NULL OR "audit_event"."event_ordinal" >= 0),
	CONSTRAINT "audit_event_actor_display_name" CHECK(length("audit_event"."actor_display_name") BETWEEN 1 AND 200),
	CONSTRAINT "audit_event_name" CHECK(length("audit_event"."event_name") BETWEEN 1 AND 128),
	CONSTRAINT "audit_event_version" CHECK("audit_event"."event_version" > 0),
	CONSTRAINT "audit_event_payload_hash" CHECK(length("audit_event"."payload_hash") = 64 AND "audit_event"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "audit_event_occurred_at" CHECK("audit_event"."occurred_at" >= 0),
	CONSTRAINT "audit_event_recorded_at" CHECK("audit_event"."recorded_at" >= "audit_event"."occurred_at")
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_event_command_ordinal_unique` ON `audit_event` (`command_id`,`event_ordinal`);
--> statement-breakpoint
CREATE TRIGGER `audit_event_reject_replace`
BEFORE INSERT ON `audit_event`
WHEN EXISTS (
	SELECT 1
	FROM `audit_event`
	WHERE `audit_event_id` = NEW.`audit_event_id`
		OR (
			NEW.`command_id` IS NOT NULL
			AND `command_id` = NEW.`command_id`
			AND `event_ordinal` = NEW.`event_ordinal`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'audit_event is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_event_reject_update`
BEFORE UPDATE ON `audit_event`
BEGIN
	SELECT RAISE(ABORT, 'audit_event is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_event_reject_delete`
BEFORE DELETE ON `audit_event`
BEGIN
	SELECT RAISE(ABORT, 'audit_event is append-only');
END;
