CREATE TABLE `channels` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`workspaceId` bigint unsigned NOT NULL,
	`slackChannelId` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`ingestEnabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `channels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `runners` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`workspaceId` bigint unsigned NOT NULL,
	`ownerMemberId` bigint unsigned NOT NULL,
	`label` varchar(255) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`agents` json,
	`version` varchar(32),
	`lastSeenAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runners_id` PRIMARY KEY(`id`),
	CONSTRAINT `runners_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `slack_installations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`workspaceId` bigint unsigned NOT NULL,
	`teamId` varchar(64) NOT NULL,
	`teamName` varchar(255),
	`botUserId` varchar(64),
	`botToken` text NOT NULL,
	`scopes` varchar(512),
	`installedByUserId` bigint unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `slack_installations_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_installations_teamId_unique` UNIQUE(`teamId`)
);
--> statement-breakpoint
CREATE TABLE `slack_oauth_states` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`state` varchar(64) NOT NULL,
	`workspaceId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `slack_oauth_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_oauth_states_state_unique` UNIQUE(`state`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`workspaceId` bigint unsigned NOT NULL,
	`runnerId` bigint unsigned,
	`slackChannelId` varchar(64) NOT NULL,
	`threadTs` varchar(32) NOT NULL,
	`prompt` text NOT NULL,
	`status` enum('running','done','failed','cancelled') NOT NULL DEFAULT 'running',
	`acpSessionId` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`unionId` varchar(255) NOT NULL,
	`name` varchar(255),
	`email` varchar(320),
	`avatar` text,
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	`lastSignInAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_unionId_unique` UNIQUE(`unionId`)
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`workspaceId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`ovUserKey` varchar(128),
	`slackUserId` varchar(32),
	`role` enum('owner','admin','member') NOT NULL DEFAULT 'member',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_members_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ownerUserId` bigint unsigned NOT NULL,
	`name` varchar(255) NOT NULL,
	`slackTeamId` varchar(64),
	`ovAccountId` varchar(64) NOT NULL,
	`plan` enum('free','team','enterprise') NOT NULL DEFAULT 'free',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_slackTeamId_unique` UNIQUE(`slackTeamId`),
	CONSTRAINT `workspaces_ovAccountId_unique` UNIQUE(`ovAccountId`)
);
--> statement-breakpoint
ALTER TABLE `channels` ADD CONSTRAINT `channels_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runners` ADD CONSTRAINT `runners_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runners` ADD CONSTRAINT `runners_ownerMemberId_workspace_members_id_fk` FOREIGN KEY (`ownerMemberId`) REFERENCES `workspace_members`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `slack_installations` ADD CONSTRAINT `slack_installations_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `slack_installations` ADD CONSTRAINT `slack_installations_installedByUserId_users_id_fk` FOREIGN KEY (`installedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `slack_oauth_states` ADD CONSTRAINT `slack_oauth_states_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `slack_oauth_states` ADD CONSTRAINT `slack_oauth_states_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_runnerId_runners_id_fk` FOREIGN KEY (`runnerId`) REFERENCES `runners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;