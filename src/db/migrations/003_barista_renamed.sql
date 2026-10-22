-- A rename is a change the Admin makes to who appears in the records, so it gets its own record type.

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_check;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_check CHECK (type IN (
  'stamp', 'stamp_forced', 'redeem', 'undo', 'goal_change', 'announcement',
  'card_issued', 'card_reissued', 'barista_added', 'barista_removed', 'barista_pin_changed',
  'barista_renamed'
));
