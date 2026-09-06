CREATE TABLE `command_receipt` (
	`command_id` text PRIMARY KEY NOT NULL,
	`command_name` text NOT NULL,
	`actor_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`result_hash` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "command_receipt_expected_version" CHECK("command_receipt"."expected_version" >= 0),
	CONSTRAINT "command_receipt_created_at" CHECK("command_receipt"."created_at" >= 0),
	CONSTRAINT "command_receipt_completed_at" CHECK("command_receipt"."completed_at" IS NULL OR "command_receipt"."completed_at" >= "command_receipt"."created_at"),
	CONSTRAINT "command_receipt_status" CHECK("command_receipt"."status" IN ('in_progress', 'succeeded', 'failed')),
	CONSTRAINT "command_receipt_terminal_shape" CHECK((
        "command_receipt"."status" = 'in_progress'
        AND "command_receipt"."result_json" IS NULL
        AND "command_receipt"."result_hash" IS NULL
        AND "command_receipt"."error_code" IS NULL
        AND "command_receipt"."error_message" IS NULL
        AND "command_receipt"."completed_at" IS NULL
      ) OR (
        "command_receipt"."status" = 'succeeded'
        AND "command_receipt"."result_json" IS NOT NULL
        AND "command_receipt"."result_hash" IS NOT NULL
        AND "command_receipt"."error_code" IS NULL
        AND "command_receipt"."error_message" IS NULL
        AND "command_receipt"."completed_at" IS NOT NULL
      ) OR (
        "command_receipt"."status" = 'failed'
        AND "command_receipt"."result_json" IS NULL
        AND "command_receipt"."result_hash" IS NULL
        AND "command_receipt"."error_code" IS NOT NULL
        AND "command_receipt"."error_message" IS NOT NULL
        AND "command_receipt"."completed_at" IS NOT NULL
      ))
) STRICT;
