-- 004_phase3_billing_invoices.sql
-- Phase 3 Additive Schema: Billing, Invoices, Itemized Folio Deduplication, and Concurrency-Safe Payments
-- Builds non-destructively on invoices, invoice_line_items, and payments from 002_future_modules_foundation.sql.

-- 1. Snapshot tax/header metadata and lifecycle audit columns on invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_name VARCHAR(40) NOT NULL DEFAULT 'GST',
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  ADD COLUMN IF NOT EXISTS property_tax_id VARCHAR(60) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS footer_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_non_negative_balance'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT chk_invoices_non_negative_balance
      CHECK (status = 'void' OR balance_due >= 0);
  END IF;
END
$$;

-- At most one active (non-void) invoice per reservation within a property
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_active_reservation
  ON invoices(property_id, reservation_id)
  WHERE reservation_id IS NOT NULL AND status != 'void';

CREATE INDEX IF NOT EXISTS idx_invoices_property_issue_date
  ON invoices(property_id, issue_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_guest
  ON invoices(property_id, guest_id);

-- 2. Source-key idempotency and pre-tax decimal storage on invoice_line_items
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS source_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_items_source_key
  ON invoice_line_items(invoice_id, source_key)
  WHERE source_key IS NOT NULL;

-- 3. Business payment_date and retry idempotency on payments
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_invoice_idempotency
  ON payments(invoice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_property_paid_at
  ON payments(property_id, paid_at DESC);
