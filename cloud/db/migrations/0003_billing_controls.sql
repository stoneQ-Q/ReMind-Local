ALTER TABLE billing_accounts
  ADD COLUMN daily_limit_micros BIGINT NOT NULL DEFAULT 10000000
    CHECK (daily_limit_micros > 0),
  ADD COLUMN monthly_limit_micros BIGINT NOT NULL DEFAULT 100000000
    CHECK (monthly_limit_micros > 0);

ALTER TABLE ledger_entries
  ADD COLUMN balance_delta_micros BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN reserved_delta_micros BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN balance_after_micros BIGINT NOT NULL DEFAULT 0
    CHECK (balance_after_micros >= 0),
  ADD COLUMN reserved_after_micros BIGINT NOT NULL DEFAULT 0
    CHECK (
      reserved_after_micros >= 0
      AND reserved_after_micros <= balance_after_micros
    ),
  ADD CONSTRAINT ledger_entries_amount_nonnegative
    CHECK (amount_micros >= 0);

CREATE TABLE billing_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  max_job_cost_micros BIGINT NOT NULL CHECK (max_job_cost_micros > 0),
  default_user_daily_limit_micros BIGINT NOT NULL
    CHECK (default_user_daily_limit_micros > 0),
  default_user_monthly_limit_micros BIGINT NOT NULL
    CHECK (default_user_monthly_limit_micros > 0),
  platform_daily_limit_micros BIGINT NOT NULL
    CHECK (platform_daily_limit_micros > 0),
  platform_monthly_limit_micros BIGINT NOT NULL
    CHECK (platform_monthly_limit_micros > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_policy (
  singleton,
  max_job_cost_micros,
  default_user_daily_limit_micros,
  default_user_monthly_limit_micros,
  platform_daily_limit_micros,
  platform_monthly_limit_micros
) VALUES (
  true,
  5000000,
  10000000,
  100000000,
  100000000,
  1000000000
);

CREATE INDEX ledger_entries_user_created_idx
  ON ledger_entries(user_id, created_at, id);

CREATE INDEX ledger_entries_settlement_created_idx
  ON ledger_entries(created_at)
  WHERE kind = 'settle';
