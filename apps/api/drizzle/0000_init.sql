CREATE TABLE `alert_reads` (
	`alert_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`alert_id`, `user_id`),
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alert_rule_channels` (
	`rule_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	PRIMARY KEY(`rule_id`, `channel_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheduler_id` integer NOT NULL,
	`type` text NOT NULL,
	`params` text NOT NULL,
	`scope` text NOT NULL,
	`severity` text NOT NULL,
	`renotify_minutes` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scheduler_id`) REFERENCES `schedulers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_rules_scheduler_idx` ON `alert_rules` (`scheduler_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheduler_id` integer NOT NULL,
	`rule_id` integer,
	`fingerprint` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`affected` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	`acked_by` integer,
	`acked_at` integer,
	`last_notified_at` integer,
	FOREIGN KEY (`scheduler_id`) REFERENCES `schedulers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`acked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alerts_scheduler_status_idx` ON `alerts` (`scheduler_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_open_fingerprint_uq` ON `alerts` (`rule_id`,`fingerprint`) WHERE status <> 'resolved';--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`user_id` integer,
	`username` text,
	`ip` text,
	`request_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target` text,
	`connection_id` integer,
	`scheduler_id` integer,
	`before` text,
	`after` text,
	`result` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_at_idx` ON `audit_logs` (`at`);--> statement-breakpoint
CREATE INDEX `audit_logs_scheduler_at_idx` ON `audit_logs` (`scheduler_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_logs_user_at_idx` ON `audit_logs` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`db_type` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`database` text,
	`oracle_service_name` text,
	`oracle_sid` text,
	`schema_name` text,
	`username` text NOT NULL,
	`password_enc` text NOT NULL,
	`options` text NOT NULL,
	`env_label` text NOT NULL,
	`tags` text NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`write_capable` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_name_unique` ON `connections` (`name`);--> statement-breakpoint
CREATE TABLE `known_nodes` (
	`scheduler_id` integer NOT NULL,
	`instance_name` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_checkin_time` integer,
	`checkin_interval` integer,
	PRIMARY KEY(`scheduler_id`, `instance_name`),
	FOREIGN KEY (`scheduler_id`) REFERENCES `schedulers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alert_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`event` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_due_idx` ON `notifications` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `scheduler_snapshots` (
	`scheduler_id` integer PRIMARY KEY NOT NULL,
	`polled_at` integer NOT NULL,
	`db_now` integer,
	`clock_skew_ms` integer,
	`status` text NOT NULL,
	`trigger_counts` text,
	`nodes` text,
	`executing_count` integer,
	`error_code` text,
	`error_message` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`scheduler_id`) REFERENCES `schedulers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schedulers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`table_prefix` text NOT NULL,
	`table_names` text NOT NULL,
	`sched_name` text NOT NULL,
	`display_name` text NOT NULL,
	`features` text NOT NULL,
	`bool_format` text NOT NULL,
	`misfire_threshold_ms` integer DEFAULT 60000 NOT NULL,
	`overdue_grace_ms` integer DEFAULT 60000 NOT NULL,
	`checkin_multiplier` integer DEFAULT 3 NOT NULL,
	`expected_node_count` integer NOT NULL,
	`poll_interval_sec` integer DEFAULT 60 NOT NULL,
	`muted_until` integer,
	`detected_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedulers_identity_uq` ON `schedulers` (`connection_id`,`table_prefix`,`sched_name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trigger_observations` (
	`scheduler_id` integer NOT NULL,
	`trigger_group` text NOT NULL,
	`trigger_name` text NOT NULL,
	`state` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	PRIMARY KEY(`scheduler_id`, `trigger_group`, `trigger_name`),
	FOREIGN KEY (`scheduler_id`) REFERENCES `schedulers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);