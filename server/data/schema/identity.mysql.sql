CREATE TABLE IF NOT EXISTS `admin_mfa` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `secret_enc` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `confirmed` BIGINT NOT NULL DEFAULT 0,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `last_counter` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`person_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `admin_mfa_recovery` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `code_hash` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `used_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`person_id`, `code_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `attestations` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `subject_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `attestor_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `ts` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `consents` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `purpose` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `version` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `ts` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `cred_idem` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `survey_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `nonce_hash` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `blinded_hash` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `sig_enc` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_ms` BIGINT NOT NULL,
  PRIMARY KEY (`person_id`, `survey_id`, `nonce_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `enrolment_rechecks` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `enrolment_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('open','confirmed','disputed','expired')),
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `due_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `decided_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `decided_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `enrolments` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `volunteer_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `context_kind` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `context_ref` MEDIUMTEXT COLLATE utf8mb4_bin,
  `label` MEDIUMTEXT COLLATE utf8mb4_bin,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin,
  `code_hash` MEDIUMTEXT COLLATE utf8mb4_bin,
  `notice_version` MEDIUMTEXT COLLATE utf8mb4_bin,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','activated','expired','cancelled','legacy')),
  `created_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `expires_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `activated_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `recheck_state` MEDIUMTEXT COLLATE utf8mb4_bin,
  `recheck_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `erasure_outbox` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `subjects` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `stores_done` BIGINT NOT NULL DEFAULT 0,
  `audit_done` BIGINT NOT NULL DEFAULT 0,
  `attempts` BIGINT NOT NULL DEFAULT 0,
  `last_error` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `has_responded` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `survey_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `ts` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`person_id`, `survey_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `hh_household` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `head_person_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `hh_invite` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `household_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `phone_hash` MEDIUMTEXT COLLATE utf8mb4_bin,
  `relation` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','accepted','declined','reported','expired')),
  `accepted_person_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `hh_invite_cooldown` (
  `target_hash` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `household_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `until` BIGINT NOT NULL,
  `reason` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`target_hash`, `household_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `hh_member` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `household_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin,
  `relation` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('accepted','dependent')),
  `year_of_birth` BIGINT,
  `consent_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  CHECK (status <> 'dependent' OR (person_id IS NULL AND year_of_birth IS NOT NULL)),
  CHECK (status <> 'accepted' OR (person_id IS NOT NULL AND year_of_birth IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `hh_transfer` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `household_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `from_person` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `to_person` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  `created_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `issue_links` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `link_key` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `kind` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `ref_enc` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `village_lgd` VARCHAR(190) COLLATE utf8mb4_bin,
  `ts` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`person_id`, `link_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `mhub_counts` (
  `kind` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `item_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `day` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `n` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`kind`, `item_id`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `mhub_news` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `source_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `title` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `link` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `snippet` MEDIUMTEXT COLLATE utf8mb4_bin,
  `published_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `fetched_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `hidden` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY (`source_id`, `link`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `mhub_reports` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `kind` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `item_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `reason` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `note` MEDIUMTEXT COLLATE utf8mb4_bin,
  `reporter` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT ('open'),
  `resolved_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `resolved_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `resolution` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`),
  UNIQUE KEY (`kind`, `item_id`, `reporter`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `mhub_sources` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `kind` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (kind IN ('news','live')),
  `name_en` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `name_te` MEDIUMTEXT COLLATE utf8mb4_bin,
  `site_url` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `feed_url` MEDIUMTEXT COLLATE utf8mb4_bin,
  `stream_url` MEDIUMTEXT COLLATE utf8mb4_bin,
  `allow` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (allow IN ('headline','snippet')),
  `state` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (state IN ('AP','TG','BOTH')),
  `permission_note` MEDIUMTEXT COLLATE utf8mb4_bin,
  `permission_date` MEDIUMTEXT COLLATE utf8mb4_bin,
  `contact` MEDIUMTEXT COLLATE utf8mb4_bin,
  `enabled` BIGINT NOT NULL DEFAULT 0,
  `created_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `enabled_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `enabled_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `last_fetch_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `last_ok_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `last_error` MEDIUMTEXT COLLATE utf8mb4_bin,
  `health_ok` BIGINT,
  `health_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `permission_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_approvals` (
  `message_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `credential_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`message_id`, `person_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_block_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `bucket` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `org_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `org_name` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `category` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `reason` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_challenges` (
  `challenge` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `kind` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `purpose` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `message_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `msg_hash` MEDIUMTEXT COLLATE utf8mb4_bin,
  `expires_at` BIGINT NOT NULL,
  `used_at` BIGINT,
  PRIMARY KEY (`challenge`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_credentials` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `spki` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `alg` BIGINT NOT NULL,
  `sign_count` BIGINT NOT NULL DEFAULT 0,
  `aaguid` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `last_used_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `revoked_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_devices` (
  `token_hash` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `token_enc` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `platform` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_inbox` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `message_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `category` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('delivered','deferred','expired')),
  `deliver_after` VARCHAR(190) COLLATE utf8mb4_bin,
  `created_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `delivered_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `read_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `push_status` MEDIUMTEXT COLLATE utf8mb4_bin,
  `sms_status` MEDIUMTEXT COLLATE utf8mb4_bin,
  `email_status` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_kill` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `scope` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (scope IN ('all','org')),
  `org_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `reason` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `engaged_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `engaged_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `release_requested_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `release_requested_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `released_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `released_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_messages` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `org_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `created_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `category` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `state` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `district` MEDIUMTEXT COLLATE utf8mb4_bin,
  `target` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `title_en` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `title_te` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `text_en` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `text_te` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `template_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `slots` MEDIUMTEXT COLLATE utf8mb4_bin,
  `declaration` MEDIUMTEXT COLLATE utf8mb4_bin,
  `msg_hash` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `approvals_required` BIGINT NOT NULL,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending_approval','approved','sending','sent','blocked','cancelled')),
  `blocked_reason` MEDIUMTEXT COLLATE utf8mb4_bin,
  `mcc_window` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `approved_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `sent_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `expires_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `key_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `key_version` BIGINT,
  `signature` MEDIUMTEXT COLLATE utf8mb4_bin,
  `signed_payload` MEDIUMTEXT COLLATE utf8mb4_bin,
  `stats` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_orgs` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `name` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `kind` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `letter_ref` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `email_domain` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `contact` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','verified','rejected')),
  `requested_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `decided_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `decided_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_person` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `quiet_start` MEDIUMTEXT COLLATE utf8mb4_bin,
  `quiet_end` MEDIUMTEXT COLLATE utf8mb4_bin,
  `antiphish_enc` MEDIUMTEXT COLLATE utf8mb4_bin,
  `language` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT ('te'),
  `sms_ok` BIGINT NOT NULL DEFAULT 0,
  `push_blocked` BIGINT NOT NULL DEFAULT 0,
  `updated_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `email_ok` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`person_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_prefs` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `category` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `opted_in` BIGINT NOT NULL,
  `updated_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`person_id`, `category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `notify_senders` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `org_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `role` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','active','rejected','revoked')),
  `requested_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `decided_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `decided_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `officer_application` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `details_enc` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `email_domain` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `department` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `designation` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT (''),
  `jurisdiction` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT (''),
  `letter_ref` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `domain_check` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `letter_checked` BIGINT NOT NULL DEFAULT 0,
  `role_request_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `reviewed_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `reviewed_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `review_note` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `updated_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `email_code_hash` MEDIUMTEXT COLLATE utf8mb4_bin,
  `email_code_expires` MEDIUMTEXT COLLATE utf8mb4_bin,
  `email_code_tries` BIGINT NOT NULL DEFAULT 0,
  `email_sends` BIGINT NOT NULL DEFAULT 0,
  `email_sent_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `email_confirmed_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `officer_role` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `role` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `department` MEDIUMTEXT COLLATE utf8mb4_bin,
  `jurisdiction_lgd` MEDIUMTEXT COLLATE utf8mb4_bin,
  `label` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`person_id`, `role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `otps` (
  `phone_hash` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `purpose` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL DEFAULT 'signup',
  `code_hash` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `expires_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `attempts` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`phone_hash`, `purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `persons` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `tier` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT ('T0'),
  `role` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT ('resident'),
  `phone_hash` VARCHAR(190) COLLATE utf8mb4_bin,
  `phone_enc` MEDIUMTEXT COLLATE utf8mb4_bin,
  `pin_salt` MEDIUMTEXT COLLATE utf8mb4_bin,
  `pin_hash` MEDIUMTEXT COLLATE utf8mb4_bin,
  `label` MEDIUMTEXT COLLATE utf8mb4_bin,
  `failed_pins` BIGINT NOT NULL DEFAULT 0,
  `locked_until` MEDIUMTEXT COLLATE utf8mb4_bin,
  `flags` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT ('[]'),
  `residence_enc` MEDIUMTEXT COLLATE utf8mb4_bin,
  `residence_unit` MEDIUMTEXT COLLATE utf8mb4_bin,
  `residence_declared_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `eligible_from` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `org` MEDIUMTEXT COLLATE utf8mb4_bin,
  `phone_purged_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `deleted_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `email_hash` VARCHAR(190) COLLATE utf8mb4_bin,
  `email_enc` MEDIUMTEXT COLLATE utf8mb4_bin,
  `last_active_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `pin_failures` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `source_key` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `failed` BIGINT NOT NULL DEFAULT 0,
  `locked_until` MEDIUMTEXT COLLATE utf8mb4_bin,
  `ok_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `updated_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`person_id`, `source_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `provider_keys` (
  `purpose` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `version` BIGINT NOT NULL,
  `kek_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `wrapped` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` BIGINT NOT NULL,
  `retired_at` BIGINT,
  PRIMARY KEY (`purpose`, `version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `rate_events` (
  `key` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `ts` BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `role_requests` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `action` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (action IN ('grant','revoke')),
  `person_id` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `role` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `jurisdiction` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT (''),
  `department` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT (''),
  `reason` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `requested_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  `created_at` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `expires_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `decided_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `decided_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `roles` (
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `role` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `jurisdiction` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `granted_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `granted_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `department` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL DEFAULT (''),
  PRIMARY KEY (`person_id`, `role`, `jurisdiction`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `sessions` (
  `token_hash` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `person_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `expires_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `id` VARCHAR(190) COLLATE utf8mb4_bin,
  `last_seen_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `label` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `sms_ledger` (
  `idem_key` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `phone_hash` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `payload_enc` MEDIUMTEXT COLLATE utf8mb4_bin,
  `template_id` MEDIUMTEXT COLLATE utf8mb4_bin,
  `segments` BIGINT NOT NULL DEFAULT 1,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `provider_msg_id` VARCHAR(190) COLLATE utf8mb4_bin,
  `attempts` BIGINT NOT NULL DEFAULT 0,
  `next_attempt_at` BIGINT,
  `cost_micro` BIGINT NOT NULL DEFAULT 0,
  `cost_known` BIGINT NOT NULL DEFAULT 0,
  `currency` MEDIUMTEXT COLLATE utf8mb4_bin,
  `last_error` MEDIUMTEXT COLLATE utf8mb4_bin,
  `created_at` BIGINT NOT NULL,
  `updated_at` BIGINT NOT NULL,
  PRIMARY KEY (`idem_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `store_meta` (
  `key` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `value` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `updated_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `survey_closures` (
  `survey_id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `closed_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`survey_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `vcast_videos` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `title_en` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `title_te` MEDIUMTEXT COLLATE utf8mb4_bin,
  `note_en` MEDIUMTEXT COLLATE utf8mb4_bin,
  `note_te` MEDIUMTEXT COLLATE utf8mb4_bin,
  `media_url` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `kind` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL CHECK (kind IN ('video','audio')),
  `credit` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `status` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL CHECK (status IN ('pending','live','recalled','rejected')),
  `created_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `publish_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `decided_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `decided_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  `live_at` VARCHAR(190) COLLATE utf8mb4_bin,
  `recall_note` MEDIUMTEXT COLLATE utf8mb4_bin,
  `views` BIGINT NOT NULL DEFAULT 0,
  `library` BIGINT NOT NULL DEFAULT 0,
  `transcript` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `vcast_windows` (
  `id` VARCHAR(190) COLLATE utf8mb4_bin NOT NULL,
  `label` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `starts_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `ends_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_by` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `created_at` MEDIUMTEXT COLLATE utf8mb4_bin NOT NULL,
  `ended_by` MEDIUMTEXT COLLATE utf8mb4_bin,
  `ended_at` MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX `idx_attest_attestor` ON `attestations` (`attestor_id`, `ts`);

CREATE INDEX `idx_attest_subject` ON `attestations` (`subject_id`);

CREATE INDEX `idx_consents_person` ON `consents` (`person_id`);

CREATE INDEX `idx_cred_idem_created` ON `cred_idem` (`created_ms`);

CREATE UNIQUE INDEX `idx_rechecks_enrolment` ON `enrolment_rechecks` (`enrolment_id`);

CREATE INDEX `idx_rechecks_status` ON `enrolment_rechecks` (`status`, `due_at`);

CREATE INDEX `idx_enrolments_person` ON `enrolments` (`person_id`);

CREATE INDEX `idx_enrolments_volunteer` ON `enrolments` (`volunteer_id`, `created_at`);

CREATE UNIQUE INDEX `hh_member_person` ON `hh_member` (`person_id`);

CREATE INDEX `idx_hh_transfer_household` ON `hh_transfer` (`household_id`, `status`);

CREATE INDEX `idx_issue_links_village` ON `issue_links` (`kind`, `village_lgd`);

CREATE INDEX `idx_mhub_news_pub` ON `mhub_news` (`published_at`);

CREATE INDEX `idx_notify_credentials_person` ON `notify_credentials` (`person_id`);

CREATE INDEX `idx_notify_devices_person` ON `notify_devices` (`person_id`);

CREATE INDEX `idx_notify_inbox_deferred` ON `notify_inbox` (`status`, `deliver_after`);

CREATE INDEX `idx_notify_inbox_person` ON `notify_inbox` (`person_id`, `created_at`);

CREATE INDEX `idx_notify_messages_org` ON `notify_messages` (`org_id`, `created_at`);

CREATE INDEX `idx_notify_senders_person` ON `notify_senders` (`person_id`);

CREATE INDEX `officer_application_person` ON `officer_application` (`person_id`, `created_at`);

CREATE INDEX `officer_application_status` ON `officer_application` (`status`, `created_at`);

CREATE UNIQUE INDEX `idx_persons_email_hash` ON `persons` (`email_hash`);

CREATE INDEX `idx_persons_phone_hash` ON `persons` (`phone_hash`);

CREATE INDEX `idx_rate_events` ON `rate_events` (`key`, `ts`);

CREATE INDEX `idx_role_requests_status` ON `role_requests` (`status`, `created_at`);

CREATE INDEX `idx_roles_role` ON `roles` (`role`);

CREATE UNIQUE INDEX `idx_sessions_id` ON `sessions` (`id`);

CREATE INDEX `idx_sessions_person` ON `sessions` (`person_id`);

CREATE INDEX `idx_sms_ledger_due` ON `sms_ledger` (`status`, `next_attempt_at`);

CREATE INDEX `idx_sms_ledger_msg` ON `sms_ledger` (`provider_msg_id`);

CREATE INDEX `idx_vcast_status` ON `vcast_videos` (`status`, `live_at`);
