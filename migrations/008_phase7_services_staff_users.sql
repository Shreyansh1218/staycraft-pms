-- ============================================================================
-- Migration 008: Phase 7 — Additional Services, Service Requests & Staff Profiles
-- Builds additively and non-destructively on 001_core_pms.sql,
-- 002_future_modules_foundation.sql, and 004_phase3_billing_invoices.sql.
-- ============================================================================

-- 1. Upgrade Service Catalog (from 002_future_modules_foundation.sql)
ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pricing_unit VARCHAR(32) NOT NULL DEFAULT 'per_request',
  ADD COLUMN IF NOT EXISTS use_property_tax_rate BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_service_catalog_id_property'
  ) THEN
    ALTER TABLE service_catalog
      ADD CONSTRAINT uq_service_catalog_id_property UNIQUE (id, property_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_service_catalog_pricing_unit'
  ) THEN
    ALTER TABLE service_catalog
      ADD CONSTRAINT chk_service_catalog_pricing_unit
      CHECK (
        pricing_unit IN (
          'per_request',
          'per_item',
          'per_person',
          'per_hour',
          'per_day'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_catalog_property_lower_name
  ON service_catalog (property_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_service_catalog_property_active
  ON service_catalog (property_id, is_active, category, name);

-- 2. Property-Scoped Staff Profiles (separated from users credentials & sessions)
CREATE TABLE IF NOT EXISTS property_staff_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  employee_code VARCHAR(40) NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL DEFAULT '',
  phone VARCHAR(50) NOT NULL DEFAULT '',
  department VARCHAR(60) NOT NULL DEFAULT 'front_office'
    CHECK (
      department IN (
        'front_office',
        'housekeeping',
        'maintenance',
        'food_beverage',
        'concierge_spa',
        'transport',
        'security',
        'management',
        'finance'
      )
    ),
  job_title VARCHAR(120) NOT NULL,
  employment_status VARCHAR(32) NOT NULL DEFAULT 'active'
    CHECK (employment_status IN ('active', 'on_leave', 'inactive')),
  shift_type VARCHAR(32) NOT NULL DEFAULT 'day'
    CHECK (shift_type IN ('morning', 'day', 'evening', 'night', 'rotational')),
  joined_on DATE,
  emergency_contact VARCHAR(160) NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  deactivated_at TIMESTAMPTZ,
  deactivated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_property_staff_profiles_property_code UNIQUE (property_id, employee_code),
  CONSTRAINT uq_property_staff_profiles_id_property UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_property_staff_profiles_property_user
  ON property_staff_profiles (property_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_property_staff_profiles_property_status
  ON property_staff_profiles (property_id, employment_status, department, full_name);

-- 3. Per-Property Service Request Sequence Counters & Service Requests
CREATE TABLE IF NOT EXISTS property_service_request_counters (
  property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1001 CHECK (next_number >= 1)
);

CREATE TABLE IF NOT EXISTS service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  request_number VARCHAR(50) NOT NULL,
  service_id UUID NOT NULL,
  service_code_snapshot VARCHAR(30) NOT NULL,
  service_name_snapshot VARCHAR(150) NOT NULL,
  category_snapshot VARCHAR(60) NOT NULL,
  pricing_unit_snapshot VARCHAR(32) NOT NULL DEFAULT 'per_request',
  reservation_id UUID REFERENCES reservations(id) ON DELETE RESTRICT,
  guest_id UUID REFERENCES guests(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  assigned_staff_id UUID,
  assigned_staff_name_snapshot VARCHAR(150) NOT NULL DEFAULT '',
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 10000),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_name VARCHAR(40) NOT NULL DEFAULT 'GST',
  tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(24) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'in_progress', 'completed', 'cancelled')),
  requested_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT NOT NULL DEFAULT '',
  billing_status VARCHAR(24) NOT NULL DEFAULT 'unbilled'
    CHECK (billing_status IN ('not_billable', 'unbilled', 'posted')),
  posted_invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  posted_line_item_id UUID REFERENCES invoice_line_items(id) ON DELETE RESTRICT,
  posted_service_charge_id UUID REFERENCES reservation_service_charges(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posting_idempotency_key VARCHAR(100),
  started_at TIMESTAMPTZ,
  started_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason VARCHAR(500) NOT NULL DEFAULT '',
  idempotency_key VARCHAR(100),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_service_requests_property_number UNIQUE (property_id, request_number),
  CONSTRAINT uq_service_requests_id_property UNIQUE (id, property_id),
  CONSTRAINT fk_service_requests_catalog_property
    FOREIGN KEY (service_id, property_id)
    REFERENCES service_catalog (id, property_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_service_requests_staff_property
    FOREIGN KEY (assigned_staff_id, property_id)
    REFERENCES property_staff_profiles (id, property_id)
    ON DELETE SET NULL (assigned_staff_id),
  CONSTRAINT chk_service_requests_association
    CHECK (reservation_id IS NOT NULL OR guest_id IS NOT NULL),
  CONSTRAINT chk_service_requests_cancel_reason
    CHECK (
      status != 'cancelled'
      OR (cancelled_at IS NOT NULL AND LENGTH(BTRIM(cancel_reason)) >= 3)
    )
);

CREATE OR REPLACE FUNCTION enforce_service_request_property_references()
RETURNS TRIGGER AS $$
DECLARE
  v_res_property UUID;
  v_guest_property UUID;
  v_room_property UUID;
BEGIN
  IF NEW.reservation_id IS NOT NULL THEN
    SELECT property_id INTO v_res_property
    FROM reservations
    WHERE id = NEW.reservation_id;

    IF v_res_property IS NULL OR v_res_property <> NEW.property_id THEN
      RAISE EXCEPTION 'Reservation does not belong to the same property as service request'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.guest_id IS NOT NULL THEN
    SELECT property_id INTO v_guest_property
    FROM guests
    WHERE id = NEW.guest_id;

    IF v_guest_property IS NULL OR v_guest_property <> NEW.property_id THEN
      RAISE EXCEPTION 'Guest does not belong to the same property as service request'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.room_id IS NOT NULL THEN
    SELECT property_id INTO v_room_property
    FROM rooms
    WHERE id = NEW.room_id;

    IF v_room_property IS NULL OR v_room_property <> NEW.property_id THEN
      RAISE EXCEPTION 'Room does not belong to the same property as service request'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_requests_property_refs ON service_requests;
CREATE TRIGGER trg_service_requests_property_refs
  BEFORE INSERT OR UPDATE OF property_id, reservation_id, guest_id, room_id ON service_requests
  FOR EACH ROW
  EXECUTE FUNCTION enforce_service_request_property_references();

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_requests_property_idempotency
  ON service_requests (property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_service_requests_property_status_requested
  ON service_requests (property_id, status, requested_for DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_requests_property_reservation
  ON service_requests (property_id, reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_service_requests_property_staff
  ON service_requests (property_id, assigned_staff_id)
  WHERE assigned_staff_id IS NOT NULL;

-- 4. Append-Only Service Request Lifecycle History
CREATE TABLE IF NOT EXISTS service_request_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  action VARCHAR(40) NOT NULL
    CHECK (
      action IN (
        'created',
        'updated',
        'assigned',
        'status_in_progress',
        'status_completed',
        'cancelled',
        'posted_to_invoice',
        'folio_released_on_void'
      )
    ),
  from_status VARCHAR(24),
  to_status VARCHAR(24),
  note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_service_request_history_request_property
    FOREIGN KEY (service_request_id, property_id)
    REFERENCES service_requests (id, property_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_request_history_request
  ON service_request_history (service_request_id, created_at ASC);

CREATE OR REPLACE FUNCTION prevent_service_request_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Service request audit history cannot be modified'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_request_history_no_update ON service_request_history;
CREATE TRIGGER trg_service_request_history_no_update
  BEFORE UPDATE ON service_request_history
  FOR EACH ROW
  EXECUTE FUNCTION prevent_service_request_history_mutation();

-- 5. Additive Folio Deduplication Guarantees on reservation_service_charges & invoice_line_items
ALTER TABLE reservation_service_charges
  ADD COLUMN IF NOT EXISTS service_request_id UUID REFERENCES service_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_charges_active_service_request
  ON reservation_service_charges (service_request_id)
  WHERE service_request_id IS NOT NULL AND status != 'voided';

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_items_service_request_global
  ON invoice_line_items (source_key)
  WHERE source_key IS NOT NULL
    AND source_key LIKE 'service_request:%';
