-- ============================================================================
-- Migration 009: Guest Self-Service Food Ordering & Account Management
-- Additive, non-destructive migration building on 001_core_pms.sql and
-- 005_phase4_food_restaurant.sql.
-- ============================================================================

-- 1. Common Per-Hotel Guest QR Token & Ordering Toggle on properties
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS guest_qr_token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS guest_qr_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE properties
SET guest_qr_token = encode(gen_random_bytes(16), 'hex')
WHERE guest_qr_token IS NULL OR BTRIM(guest_qr_token) = '';

ALTER TABLE properties
  ALTER COLUMN guest_qr_token SET DEFAULT encode(gen_random_bytes(16), 'hex'),
  ALTER COLUMN guest_qr_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_guest_qr_token
  ON properties (guest_qr_token);

-- 2. Guest Self-Service Source & Restricted Single-Order Tracking Token on food_orders
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS order_source VARCHAR(24) NOT NULL DEFAULT 'staff_pos',
  ADD COLUMN IF NOT EXISTS guest_tracking_token_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS guest_tracking_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_food_orders_order_source'
  ) THEN
    ALTER TABLE food_orders
      ADD CONSTRAINT chk_food_orders_order_source
      CHECK (order_source IN ('staff_pos', 'guest_qr'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_food_orders_guest_tracking_hash
  ON food_orders (guest_tracking_token_hash)
  WHERE guest_tracking_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_food_orders_property_source_status
  ON food_orders (property_id, order_source, status, placed_at DESC);

-- 3. Secure, Time-Limited, Single-Use Password Reset Tokens (SHA-256 hashed only)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  delivery_email VARCHAR(255) NOT NULL,
  initiated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_ip VARCHAR(64) NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_password_reset_tokens_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_created
  ON password_reset_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_active_expiry
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL AND invalidated_at IS NULL;
