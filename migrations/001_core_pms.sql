-- 001_core_pms.sql
-- Phase 1 Core Schema: Properties, Users & RBAC, Sessions, Room Types, Rooms, Guests, Reservations, Status History, Audit Events

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  website VARCHAR(255) NOT NULL DEFAULT '',
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255) NOT NULL DEFAULT '',
  city VARCHAR(100) NOT NULL,
  state_region VARCHAR(100) NOT NULL DEFAULT '',
  postal_code VARCHAR(30) NOT NULL DEFAULT '',
  country VARCHAR(100) NOT NULL DEFAULT 'India',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 12.00 CHECK (default_tax_rate >= 0 AND default_tax_rate <= 100),
  tax_name VARCHAR(40) NOT NULL DEFAULT 'GST',
  standard_check_in_time CHAR(5) NOT NULL DEFAULT '14:00',
  standard_check_out_time CHAR(5) NOT NULL DEFAULT '11:00',
  cancellation_policy TEXT NOT NULL DEFAULT 'Free cancellation up to 24 hours prior to check-in.',
  booking_terms TEXT NOT NULL DEFAULT 'Valid government-issued photo ID required at check-in.',
  invoice_settings JSONB NOT NULL DEFAULT '{"prefix": "INV", "next_number": 1001, "tax_id": "", "footer_note": "Thank you for staying with us."}'::jsonb,
  extra_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('admin', 'receptionist')),
  phone VARCHAR(50) NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_property_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  ip_address VARCHAR(64) NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS room_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_capacity INTEGER NOT NULL DEFAULT 2 CHECK (base_capacity >= 1),
  max_capacity INTEGER NOT NULL DEFAULT 2 CHECK (max_capacity >= base_capacity),
  base_rate NUMERIC(12,2) NOT NULL CHECK (base_rate >= 0),
  amenities JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_room_types_property_code UNIQUE (property_id, code),
  CONSTRAINT uq_room_types_property_name UNIQUE (property_id, name)
);

CREATE INDEX IF NOT EXISTS idx_room_types_property_active ON room_types(property_id, is_active);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  room_number VARCHAR(30) NOT NULL,
  floor VARCHAR(20) NOT NULL DEFAULT '1',
  operational_status VARCHAR(32) NOT NULL DEFAULT 'available' CHECK (operational_status IN ('available', 'maintenance', 'out_of_service')),
  housekeeping_status VARCHAR(32) NOT NULL DEFAULT 'clean' CHECK (housekeeping_status IN ('clean', 'dirty', 'inspected', 'out_of_service')),
  notes TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rooms_property_room_number UNIQUE (property_id, room_number)
);

CREATE INDEX IF NOT EXISTS idx_rooms_property_type ON rooms(property_id, room_type_id);
CREATE INDEX IF NOT EXISTS idx_rooms_property_operational ON rooms(property_id, operational_status, is_active);
CREATE INDEX IF NOT EXISTS idx_rooms_property_housekeeping ON rooms(property_id, housekeeping_status);

CREATE TABLE IF NOT EXISTS guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL DEFAULT '',
  phone VARCHAR(50) NOT NULL,
  address_line1 VARCHAR(255) NOT NULL DEFAULT '',
  city VARCHAR(100) NOT NULL DEFAULT '',
  state_region VARCHAR(100) NOT NULL DEFAULT '',
  postal_code VARCHAR(30) NOT NULL DEFAULT '',
  country VARCHAR(100) NOT NULL DEFAULT '',
  id_document_type VARCHAR(50) NOT NULL DEFAULT '',
  id_document_number VARCHAR(100) NOT NULL DEFAULT '',
  vip_status BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guests_property_name ON guests(property_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_guests_property_phone ON guests(property_id, phone);
CREATE INDEX IF NOT EXISTS idx_guests_property_email ON guests(property_id, email);

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  booking_reference VARCHAR(40) NOT NULL UNIQUE,
  guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  arrival_date DATE NOT NULL,
  departure_date DATE NOT NULL,
  adults INTEGER NOT NULL DEFAULT 1 CHECK (adults >= 1),
  children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  num_guests INTEGER NOT NULL CHECK (num_guests >= 1 AND num_guests = adults + children),
  nights INTEGER GENERATED ALWAYS AS (departure_date - arrival_date) STORED,
  nightly_rate NUMERIC(12,2) NOT NULL CHECK (nightly_rate >= 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  estimated_total NUMERIC(12,2) NOT NULL CHECK (estimated_total >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  source VARCHAR(40) NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'walk_in', 'phone', 'website', 'ota_booking', 'ota_expedia', 'corporate')),
  is_walk_in BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled')),
  special_requests TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  cancellation_reason TEXT NOT NULL DEFAULT '',
  cancelled_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  checked_out_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reservations_dates CHECK (departure_date > arrival_date),
  CONSTRAINT excl_reservations_no_room_overlap EXCLUDE USING gist (
    room_id WITH =,
    daterange(arrival_date, departure_date, '[)') WITH &&
  ) WHERE (room_id IS NOT NULL AND status IN ('pending', 'confirmed', 'checked_in'))
);

CREATE INDEX IF NOT EXISTS idx_reservations_property_status ON reservations(property_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_property_arrival ON reservations(property_id, arrival_date);
CREATE INDEX IF NOT EXISTS idx_reservations_property_departure ON reservations(property_id, departure_date);
CREATE INDEX IF NOT EXISTS idx_reservations_guest_id ON reservations(guest_id);
CREATE INDEX IF NOT EXISTS idx_reservations_room_id ON reservations(room_id);

CREATE TABLE IF NOT EXISTS reservation_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_status VARCHAR(32),
  to_status VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_res_history_reservation ON reservation_status_history(reservation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id UUID,
  action VARCHAR(64) NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_property_created ON audit_events(property_id, created_at DESC);
