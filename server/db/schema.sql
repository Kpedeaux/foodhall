-- Food Hall Manager Database Schema

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  square_environment TEXT NOT NULL DEFAULT 'production',
  default_delivery_fee_rate REAL NOT NULL DEFAULT 0.105,
  default_service_charge_rate REAL NOT NULL DEFAULT 0.02,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  name TEXT NOT NULL,
  square_location_id TEXT,
  plan_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (plan_type IN ('FLAT', 'STANDARD', 'WEEKLY')),
  percentage_rate REAL NOT NULL DEFAULT 0.30,
  daily_base_rent REAL NOT NULL DEFAULT 0.00,
  delivery_fee_rate REAL NOT NULL DEFAULT 0.105,
  service_charge_rate REAL NOT NULL DEFAULT 0.02,
  weekly_minimum REAL NOT NULL DEFAULT 0.00,
  linen_charge REAL NOT NULL DEFAULT 0.00,
  active INTEGER NOT NULL DEFAULT 1,
  departed_date TEXT,
  is_excluded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(market_id, square_location_id)
);

CREATE INDEX IF NOT EXISTS idx_vendors_market ON vendors(market_id);
CREATE INDEX IF NOT EXISTS idx_vendors_active ON vendors(market_id, active);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  vendor_id INTEGER REFERENCES vendors(id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'vendor' CHECK (role IN ('admin', 'vendor')),
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_market ON users(market_id);

CREATE TABLE IF NOT EXISTS weekly_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  is_linen_week INTEGER NOT NULL DEFAULT 0,
  closure_days TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  calculated_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(market_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_periods_market ON weekly_periods(market_id);
CREATE INDEX IF NOT EXISTS idx_weekly_periods_status ON weekly_periods(market_id, status);

CREATE TABLE IF NOT EXISTS daily_calculations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekly_period_id INTEGER NOT NULL REFERENCES weekly_periods(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  date TEXT NOT NULL,
  dine_in_sales REAL NOT NULL DEFAULT 0,
  delivery_sales REAL NOT NULL DEFAULT 0,
  total_sales REAL NOT NULL DEFAULT 0,
  market_fee_calculated REAL NOT NULL DEFAULT 0,
  market_fee_applied REAL NOT NULL DEFAULT 0,
  square_fees REAL NOT NULL DEFAULT 0,
  cash_collected REAL NOT NULL DEFAULT 0,
  tips REAL NOT NULL DEFAULT 0,
  daily_transfer REAL NOT NULL DEFAULT 0,
  payment_count INTEGER NOT NULL DEFAULT 0,
  is_closure_day INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_daily_calc_period_vendor ON daily_calculations(weekly_period_id, vendor_id);

CREATE TABLE IF NOT EXISTS weekly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekly_period_id INTEGER NOT NULL REFERENCES weekly_periods(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  total_sales REAL NOT NULL DEFAULT 0,
  total_dine_in REAL NOT NULL DEFAULT 0,
  total_delivery REAL NOT NULL DEFAULT 0,
  total_market_fee REAL NOT NULL DEFAULT 0,
  total_square_fees REAL NOT NULL DEFAULT 0,
  total_cash REAL NOT NULL DEFAULT 0,
  total_tips REAL NOT NULL DEFAULT 0,
  delivery_fee REAL NOT NULL DEFAULT 0,
  service_charge REAL NOT NULL DEFAULT 0,
  tips_to_transfer REAL NOT NULL DEFAULT 0,
  weekly_minimum_bump REAL NOT NULL DEFAULT 0,
  linen_charge REAL NOT NULL DEFAULT 0,
  gross_transfer REAL NOT NULL DEFAULT 0,
  net_transfer REAL NOT NULL DEFAULT 0,
  UNIQUE(weekly_period_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_weekly_summaries_period ON weekly_summaries(weekly_period_id);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekly_summary_id INTEGER NOT NULL REFERENCES weekly_summaries(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('linen', 'fine', 'equipment', 'credit', 'deposit', 'other')),
  amount REAL NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_adjustments_summary ON adjustments(weekly_summary_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER REFERENCES markets(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_market ON audit_log(market_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
