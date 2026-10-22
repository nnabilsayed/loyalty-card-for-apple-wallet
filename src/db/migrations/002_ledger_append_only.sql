-- The ledger is a permanent record: nothing may change or remove a row (Principle II).

CREATE FUNCTION ledger_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_events is append-only';
END;
$$;

CREATE TRIGGER ledger_events_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION ledger_events_append_only();

CREATE TRIGGER ledger_events_no_truncate
  BEFORE TRUNCATE ON ledger_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_events_append_only();
