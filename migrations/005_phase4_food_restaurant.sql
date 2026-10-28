-- 005_phase4_food_restaurant.sql
-- Phase 4 Additive Schema: Food Categories, Menu Items, Restaurant/Takeaway/Room-Service Orders,
-- Kitchen Order Workflow, and Idempotent Guest Folio Posting & Reversal.

-- 1. Property-scoped Food Categories
CREATE TABLE IF NOT EXISTS food_categories (
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
  CONSTRAINT uq_food_categories_property_code UNIQUE (property_id, code),
  CONSTRAINT uq_food_categories_id_property UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_food_categories_property_lower_name
  ON food_categories(property_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_food_categories_property_active
  ON food_categories(property_id, is_active, display_order ASC, name ASC);

-- 2. Property-scoped Menu Items
CREATE TABLE IF NOT EXISTS food_menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category_id UUID NOT NULL,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0.01),
  dietary_tag VARCHAR(32) NOT NULL DEFAULT 'veg'
    CHECK (dietary_tag IN ('veg', 'non_veg', 'vegan', 'beverage', 'other')),
  prep_time_minutes INTEGER
    CHECK (prep_time_minutes IS NULL OR (prep_time_minutes >= 1 AND prep_time_minutes <= 240)),
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_food_menu_items_category_property
    FOREIGN KEY (category_id, property_id)
    REFERENCES food_categories(id, property_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_food_menu_items_property_sku UNIQUE (property_id, sku),
  CONSTRAINT uq_food_menu_items_id_property UNIQUE (id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_food_menu_items_property_cat
  ON food_menu_items(property_id, category_id, is_active, is_available, display_order ASC);

-- 3. Per-property concurrency-safe sequence counter for human-readable order references
CREATE TABLE IF NOT EXISTS property_food_order_counters (
  property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  next_number INTEGER NOT NULL DEFAULT 1001 CHECK (next_number >= 1)
);

-- 4. Food Orders (Restaurant/POS, Takeaway, Room Service)
CREATE TABLE IF NOT EXISTS food_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  order_reference VARCHAR(50) NOT NULL,
  order_type VARCHAR(24) NOT NULL
    CHECK (order_type IN ('restaurant', 'takeaway', 'room_service')),
  status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'preparing', 'ready', 'served', 'cancelled')),
  table_label VARCHAR(60) NOT NULL DEFAULT '',
  customer_name VARCHAR(160) NOT NULL DEFAULT '',
  reservation_id UUID REFERENCES reservations(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  guest_id UUID REFERENCES guests(id) ON DELETE RESTRICT,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_name VARCHAR(40) NOT NULL DEFAULT 'GST',
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  notes TEXT NOT NULL DEFAULT '',
  billing_status VARCHAR(24) NOT NULL DEFAULT 'not_applicable'
    CHECK (billing_status IN ('not_applicable', 'unbilled', 'posted', 'reversed')),
  posted_invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  posted_line_item_id UUID REFERENCES invoice_line_items(id) ON DELETE RESTRICT,
  posted_service_charge_id UUID REFERENCES reservation_service_charges(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason TEXT NOT NULL DEFAULT '',
  idempotency_key VARCHAR(100),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  preparing_at TIMESTAMPTZ,
  preparing_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ready_at TIMESTAMPTZ,
  ready_by UUID REFERENCES users(id) ON DELETE SET NULL,
  served_at TIMESTAMPTZ,
  served_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_food_orders_property_reference UNIQUE (property_id, order_reference),
  CONSTRAINT chk_food_orders_room_service_links CHECK (
    (order_type = 'room_service' AND reservation_id IS NOT NULL AND room_id IS NOT NULL AND guest_id IS NOT NULL)
    OR (order_type != 'room_service' AND reservation_id IS NULL AND room_id IS NULL)
  ),
  CONSTRAINT chk_food_orders_billing_type CHECK (
    (order_type = 'room_service' AND billing_status IN ('unbilled', 'posted', 'reversed'))
    OR (order_type != 'room_service' AND billing_status = 'not_applicable')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_food_orders_property_idempotency
  ON food_orders(property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_food_orders_property_status_placed
  ON food_orders(property_id, status, placed_at DESC);

CREATE INDEX IF NOT EXISTS idx_food_orders_property_reservation
  ON food_orders(property_id, reservation_id)
  WHERE reservation_id IS NOT NULL;

-- 5. Itemized Food Order Lines with Immutable Name & Price Snapshots
CREATE TABLE IF NOT EXISTS food_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES food_menu_items(id) ON DELETE RESTRICT,
  item_name_snapshot VARCHAR(160) NOT NULL,
  category_name_snapshot VARCHAR(120) NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 500),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0.01),
  line_subtotal NUMERIC(12,2) NOT NULL CHECK (line_subtotal >= 0.01),
  special_instructions VARCHAR(500) NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_order_items_order
  ON food_order_items(order_id, sort_order ASC);

-- 6. Kitchen & Order Lifecycle Status History
CREATE TABLE IF NOT EXISTS food_order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_status VARCHAR(24),
  to_status VARCHAR(24) NOT NULL
    CHECK (to_status IN ('pending', 'preparing', 'ready', 'served', 'cancelled')),
  note TEXT NOT NULL DEFAULT '',
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_order_history_order
  ON food_order_status_history(order_id, created_at ASC);

-- 7. Additive Folio Deduplication Guarantees on reservation_service_charges & invoice_line_items
ALTER TABLE reservation_service_charges
  ADD COLUMN IF NOT EXISTS food_order_id UUID REFERENCES food_orders(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_charges_active_food_order
  ON reservation_service_charges(food_order_id)
  WHERE food_order_id IS NOT NULL AND status != 'voided';

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_items_food_order_global
  ON invoice_line_items(source_key)
  WHERE source_key IS NOT NULL
    AND (source_key LIKE 'food_order:%' OR source_key LIKE 'food_order_reversal:%');
