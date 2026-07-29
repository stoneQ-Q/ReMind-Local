\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  first_user UUID;
  second_user UUID;
  first_account UUID;
  first_job UUID;
  first_ledger_entry UUID;
  cross_user_rejected BOOLEAN := false;
  negative_balance_rejected BOOLEAN := false;
  ledger_mutation_rejected BOOLEAN := false;
BEGIN
  INSERT INTO users DEFAULT VALUES RETURNING id INTO first_user;
  INSERT INTO users DEFAULT VALUES RETURNING id INTO second_user;

  INSERT INTO notes (user_id, client_id, source, record_type, content_kind)
  VALUES
    (first_user, 'same-client-id', 'app', 'capture', 'text'),
    (second_user, 'same-client-id', 'app', 'capture', 'text');

  IF (
    SELECT count(*)
    FROM notes
    WHERE client_id = 'same-client-id'
  ) <> 2 THEN
    RAISE EXCEPTION 'the same client note id must be allowed for two users';
  END IF;

  IF (
    SELECT count(*)
    FROM notes
    WHERE user_id = first_user AND client_id = 'same-client-id'
  ) <> 1 THEN
    RAISE EXCEPTION 'user-scoped note lookup returned an unexpected result';
  END IF;

  INSERT INTO billing_accounts (user_id, balance_micros)
  VALUES (first_user, 1000000)
  RETURNING id INTO first_account;

  INSERT INTO jobs (user_id, type, idempotency_key)
  VALUES (first_user, 'schema-test', 'first-job')
  RETURNING id INTO first_job;

  BEGIN
    INSERT INTO ledger_entries (
      user_id,
      billing_account_id,
      job_id,
      kind,
      amount_micros,
      idempotency_key
    )
    VALUES (
      second_user,
      first_account,
      first_job,
      'reserve',
      -1000,
      'cross-user-entry'
    );
  EXCEPTION
    WHEN foreign_key_violation THEN
      cross_user_rejected := true;
  END;

  IF NOT cross_user_rejected THEN
    RAISE EXCEPTION 'cross-user billing reference was not rejected';
  END IF;

  BEGIN
    UPDATE billing_accounts
    SET balance_micros = -1
    WHERE id = first_account;
  EXCEPTION
    WHEN check_violation THEN
      negative_balance_rejected := true;
  END;

  IF NOT negative_balance_rejected THEN
    RAISE EXCEPTION 'negative balance was not rejected';
  END IF;

  INSERT INTO ledger_entries (
    user_id,
    billing_account_id,
    job_id,
    kind,
    amount_micros,
    idempotency_key
  )
  VALUES (
    first_user,
    first_account,
    first_job,
    'reserve',
    -1000,
    'valid-entry'
  )
  RETURNING id INTO first_ledger_entry;

  BEGIN
    UPDATE ledger_entries
    SET amount_micros = -2000
    WHERE id = first_ledger_entry;
  EXCEPTION
    WHEN raise_exception THEN
      ledger_mutation_rejected := true;
  END;

  IF NOT ledger_mutation_rejected THEN
    RAISE EXCEPTION 'ledger mutation was not rejected';
  END IF;
END;
$$;

ROLLBACK;

SELECT 'tenant boundary checks passed' AS result;
