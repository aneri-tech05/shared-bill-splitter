CREATE TABLE homes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  CONSTRAINT chk_homes_id_not_empty CHECK (length(id) > 0),
  CONSTRAINT chk_homes_name_not_empty
    CHECK (length(trim(name, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0)
);

CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL,
  member_order INTEGER NOT NULL,
  CONSTRAINT fk_members_home
    FOREIGN KEY (home_id) REFERENCES homes (id) ON DELETE CASCADE,
  CONSTRAINT chk_members_id_not_empty CHECK (length(id) > 0),
  CONSTRAINT chk_members_name_not_empty
    CHECK (length(trim(name, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0),
  CONSTRAINT chk_members_order_nonnegative
    CHECK (typeof(member_order) = 'integer' AND member_order >= 0),
  CONSTRAINT uq_members_home_order UNIQUE (home_id, member_order),
  CONSTRAINT uq_members_id_home UNIQUE (id, home_id)
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  CONSTRAINT fk_bills_home
    FOREIGN KEY (home_id) REFERENCES homes (id) ON DELETE CASCADE,
  CONSTRAINT chk_bills_id_not_empty CHECK (length(id) > 0),
  CONSTRAINT chk_bills_title_not_empty
    CHECK (length(trim(title, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0),
  CONSTRAINT chk_bills_total_positive_integer
    CHECK (typeof(total_cents) = 'integer' AND total_cents > 0),
  CONSTRAINT uq_bills_id_home UNIQUE (id, home_id)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY NOT NULL,
  bill_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT,
  idempotency_key TEXT,
  CONSTRAINT fk_shares_bill_home
    FOREIGN KEY (bill_id, home_id) REFERENCES bills (id, home_id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_member_home
    FOREIGN KEY (member_id, home_id) REFERENCES members (id, home_id) ON DELETE CASCADE,
  CONSTRAINT chk_shares_id_not_empty CHECK (length(id) > 0),
  CONSTRAINT chk_shares_amount_nonnegative_integer
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  CONSTRAINT chk_shares_payment_state
    CHECK (
      (paid_at IS NULL AND idempotency_key IS NULL)
      OR (
        paid_at IS NOT NULL
        AND length(paid_at) > 0
        AND idempotency_key IS NOT NULL
        AND length(trim(idempotency_key)) > 0
      )
    ),
  CONSTRAINT uq_shares_bill_member UNIQUE (bill_id, member_id)
);
