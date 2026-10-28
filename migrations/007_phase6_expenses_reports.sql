-- ============================================================================
-- Migration 007: Phase 6 — Operating Expenses, Expense Categories & Reports
-- Builds additively and non-destructively on 002_future_modules_foundation.sql.
-- ============================================================================

-- 1. Property-Scoped Expense Categories
CREATE TABLE IF NOT EXISTS expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_expense_categories_property_code UNIQUE (property_id, code),
  CONSTRAINT uq_expense_categories_id_property UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_categories_property_lower_name
  ON expense_categories (property_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_expense_categories_property_active
  ON expense_categories (property_id, is_active, display_order ASC, name ASC);

-- 2. Sequential Per-Property Expense Voucher Counters
CREATE TABLE IF NOT EXISTS property_expense_counters (
  property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1001 CHECK (next_number >= 1)
);

-- 3. Upgrade Expenses Table (from 002_future_modules_foundation.sql)
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS expense_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS category_id UUID,
  ADD COLUMN IF NOT EXISTS category_name_snapshot VARCHAR(120) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(160) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_expenses_id_property'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT uq_expenses_id_property UNIQUE (id, property_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_category_property'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT fk_expenses_category_property
      FOREIGN KEY (category_id, property_id)
      REFERENCES expense_categories (id, property_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_positive_amount'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT chk_expenses_positive_amount
      CHECK (amount >= 0.01);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_status'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT chk_expenses_status
      CHECK (status IN ('recorded', 'voided'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_payment_method'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT chk_expenses_payment_method
      CHECK (
        payment_method IN (
          'cash',
          'card',
          'upi',
          'bank_transfer',
          'online',
          'cheque',
          'petty_cash'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_void_audit'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT chk_expenses_void_audit
      CHECK (
        (status = 'recorded' AND voided_at IS NULL)
        OR (status = 'voided' AND voided_at IS NOT NULL AND LENGTH(BTRIM(void_reason)) >= 3)
      );
  END IF;
END $$;

-- Enforce DB-level property isolation between expenses and suppliers
CREATE OR REPLACE FUNCTION enforce_expense_supplier_property()
RETURNS TRIGGER AS $$
DECLARE
  v_supplier_property UUID;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT property_id INTO v_supplier_property
    FROM suppliers
    WHERE id = NEW.supplier_id;

    IF v_supplier_property IS NULL OR v_supplier_property <> NEW.property_id THEN
      RAISE EXCEPTION 'Supplier does not belong to the same property as operating expense'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expenses_supplier_property ON expenses;
CREATE TRIGGER trg_expenses_supplier_property
  BEFORE INSERT OR UPDATE OF supplier_id, property_id ON expenses
  FOR EACH ROW
  EXECUTE FUNCTION enforce_expense_supplier_property();

CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_property_number
  ON expenses (property_id, expense_number)
  WHERE expense_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_property_idempotency
  ON expenses (property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_property_status_date
  ON expenses (property_id, status, expense_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_property_category_id
  ON expenses (property_id, category_id)
  WHERE category_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_property_supplier_id
  ON expenses (property_id, supplier_id)
  WHERE supplier_id IS NOT NULL;

-- 4. Expense Lifecycle History (Creation, Edits & Auditable Voiding)
CREATE TABLE IF NOT EXISTS expense_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  action VARCHAR(32) NOT NULL CHECK (action IN ('created', 'updated', 'voided')),
  reason VARCHAR(500) NOT NULL DEFAULT '',
  previous_snapshot JSONB,
  new_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_expense_history_expense_property
    FOREIGN KEY (expense_id, property_id)
    REFERENCES expenses (id, property_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expense_history_expense_created
  ON expense_history (expense_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_expense_history_property_created
  ON expense_history (property_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_expense_history_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Expense audit history cannot be modified'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_history_no_update ON expense_history;
CREATE TRIGGER trg_expense_history_no_update
  BEFORE UPDATE ON expense_history
  FOR EACH ROW
  EXECUTE FUNCTION prevent_expense_history_update();
