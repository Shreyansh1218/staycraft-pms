-- 003_phase2_room_operations.sql
-- Phase 2 Additive Schema: Cleaning & Inspection Workflow Metadata, Housekeeping Task Attribution, and Maintenance / Out-of-Service Management

-- 1. Additive cleaning & inspection workflow columns on physical rooms
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS cleaning_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleaning_started_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_cleaned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_cleaned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_inspected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_inspected_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 2. Additive attribution & lifecycle timestamps on housekeeping_tasks
ALTER TABLE housekeeping_tasks
  ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_room_status
  ON housekeeping_tasks(room_id, status);

CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_assigned
  ON housekeeping_tasks(property_id, assigned_to, status);

-- 3. Maintenance requests & out-of-service periods
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL DEFAULT 'general'
    CHECK (category IN ('hvac', 'plumbing', 'electrical', 'furniture', 'appliance', 'safety', 'general')),
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status VARCHAR(32) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'cancelled')),
  operational_impact VARCHAR(32) NOT NULL DEFAULT 'none'
    CHECK (operational_impact IN ('none', 'maintenance', 'out_of_service')),
  blocks_inventory BOOLEAN NOT NULL DEFAULT FALSE,
  unavailable_from DATE,
  unavailable_to DATE,
  reported_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes TEXT NOT NULL DEFAULT '',
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_maintenance_unavailable_dates
    CHECK (unavailable_to IS NULL OR (unavailable_from IS NOT NULL AND unavailable_to > unavailable_from)),
  CONSTRAINT chk_maintenance_blocks_start
    CHECK (blocks_inventory = FALSE OR unavailable_from IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_property_status
  ON maintenance_requests(property_id, status, priority);

CREATE INDEX IF NOT EXISTS idx_maintenance_room_history
  ON maintenance_requests(room_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_active_blocks
  ON maintenance_requests(room_id, unavailable_from, unavailable_to)
  WHERE blocks_inventory = TRUE AND status IN ('open', 'in_progress');
