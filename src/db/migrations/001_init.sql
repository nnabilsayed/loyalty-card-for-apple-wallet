-- Tables for the digital stamp card.

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES customers (id),
  serial text NOT NULL UNIQUE,
  auth_token text NOT NULL,
  cups integer NOT NULL DEFAULT 0 CHECK (cups >= 0),
  free_drink_earned boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cards_updated_at_idx ON cards (updated_at);

-- A single row.
CREATE TABLE settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  reward_goal integer NOT NULL DEFAULT 10 CHECK (reward_goal >= 1),
  announcement_text text,
  announcement_at timestamptz
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE baristas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  pin_hmac text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);

-- A PIN identifies one active barista; a removed barista's PIN can be reused.
CREATE UNIQUE INDEX baristas_active_pin_idx ON baristas (pin_hmac) WHERE active;

CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('barista', 'admin')),
  barista_id uuid REFERENCES baristas (id),
  admin_id uuid REFERENCES admins (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (role = 'barista' AND barista_id IS NOT NULL AND admin_id IS NULL) OR
    (role = 'admin' AND admin_id IS NOT NULL AND barista_id IS NULL)
  )
);

CREATE TABLE device_registrations (
  device_library_id text NOT NULL,
  card_id uuid NOT NULL REFERENCES cards (id),
  push_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_library_id, card_id)
);

CREATE TABLE ledger_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL CHECK (type IN (
    'stamp', 'stamp_forced', 'redeem', 'undo', 'goal_change', 'announcement',
    'card_issued', 'card_reissued', 'barista_added', 'barista_removed', 'barista_pin_changed'
  )),
  card_id uuid REFERENCES cards (id),
  actor_role text NOT NULL CHECK (actor_role IN ('barista', 'admin', 'customer', 'system')),
  actor_id uuid,
  actor_name text NOT NULL,
  before jsonb,
  after jsonb,
  idempotency_key text,
  UNIQUE (actor_id, card_id, idempotency_key)
);

CREATE INDEX ledger_events_card_idx ON ledger_events (card_id, id DESC);
CREATE INDEX ledger_events_at_idx ON ledger_events (at DESC);

CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL CHECK (char_length(text) <= 200),
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_by text NOT NULL,
  cards_targeted integer NOT NULL
);
