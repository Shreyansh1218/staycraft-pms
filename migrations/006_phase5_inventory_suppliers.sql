-- ============================================================================
-- Migration 006: Phase 5 — Inventory, Suppliers, Stock Ledger & Recipe Links
-- Builds additively and non-destructively on 002_future_modules_foundation.sql
-- and 005_phase4_food_restaurant.sql.
-- ============================================================================

-- 1. Property-Scoped Inventory Categories
CREATE TABLE IF NOT EXISTS inventory_categories (
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
  CONSTRAINT uq_inventory_categories_property_code UNIQUE (property_id, code),
  CONSTRAINT uq_inventory_categories_id_property UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_categories_property_lower_name
  ON inventory_categories (property_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_inventory_categories_property_active
  ON inventory_categories (property_id, is_active, display_order, name);

-- 2. Upgrade Suppliers Table (from 002_future_modules_foundation.sql)
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS code VARCHAR(40),
  ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(120) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_suppliers_id_property'
  ) THEN
    ALTER TABLE suppliers
      ADD CONSTRAINT uq_suppliers_id_property UNIQUE (id, property_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_property_code
  ON suppliers (property_id, code)
  WHERE code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_property_lower_name
  ON suppliers (property_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_suppliers_property_active_name
  ON suppliers (property_id, is_active, name);

-- 3. Upgrade Inventory Products Table (from 002_future_modules_foundation.sql)
ALTER TABLE inventory_products
  ADD COLUMN IF NOT EXISTS category_id UUID,
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_inventory_products_id_property'
  ) THEN
    ALTER TABLE inventory_products
      ADD CONSTRAINT uq_inventory_products_id_property UNIQUE (id, property_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_inventory_products_category_property'
  ) THEN
    ALTER TABLE inventory_products
      ADD CONSTRAINT fk_inventory_products_category_property
      FOREIGN KEY (category_id, property_id)
      REFERENCES inventory_categories (id, property_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_products_non_negative_stock'
  ) THEN
    ALTER TABLE inventory_products
      ADD CONSTRAINT chk_inventory_products_non_negative_stock
      CHECK (current_stock >= 0);
  END IF;
END $$;

-- Enforce DB-level property isolation between inventory_products and suppliers
CREATE OR REPLACE FUNCTION enforce_inventory_product_supplier_property()
RETURNS TRIGGER AS $$
DECLARE
  v_supplier_property UUID;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT property_id INTO v_supplier_property
    FROM suppliers
    WHERE id = NEW.supplier_id;

    IF v_supplier_property IS NULL OR v_supplier_property <> NEW.property_id THEN
      RAISE EXCEPTION 'Supplier does not belong to the same property as inventory item'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_products_supplier_property ON inventory_products;
CREATE TRIGGER trg_inventory_products_supplier_property
  BEFORE INSERT OR UPDATE OF supplier_id, property_id ON inventory_products
  FOR EACH ROW
  EXECUTE FUNCTION enforce_inventory_product_supplier_property();

CREATE INDEX IF NOT EXISTS idx_inventory_products_property_active
  ON inventory_products (property_id, is_active, name);

CREATE INDEX IF NOT EXISTS idx_inventory_products_property_category_id
  ON inventory_products (property_id, category_id);

CREATE INDEX IF NOT EXISTS idx_inventory_products_property_supplier
  ON inventory_products (property_id, supplier_id);

-- 4. Sequential Per-Property Receipt Counters & Purchase/Stock Receipts Header
CREATE TABLE IF NOT EXISTS property_inventory_receipt_counters (
  property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1001 CHECK (next_number >= 1)
);

CREATE TABLE IF NOT EXISTS inventory_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  receipt_number VARCHAR(50) NOT NULL,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  vendor_invoice_number VARCHAR(100) NOT NULL DEFAULT '',
  receipt_date DATE NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key VARCHAR(100),
  request_fingerprint TEXT,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inventory_receipts_property_number UNIQUE (property_id, receipt_number),
  CONSTRAINT uq_inventory_receipts_id_property UNIQUE (id, property_id)
);

CREATE OR REPLACE FUNCTION enforce_inventory_receipt_supplier_property()
RETURNS TRIGGER AS $$
DECLARE
  v_supplier_property UUID;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT property_id INTO v_supplier_property
    FROM suppliers
    WHERE id = NEW.supplier_id;

    IF v_supplier_property IS NULL OR v_supplier_property <> NEW.property_id THEN
      RAISE EXCEPTION 'Supplier does not belong to the same property as stock receipt'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_receipts_supplier_property ON inventory_receipts;
CREATE TRIGGER trg_inventory_receipts_supplier_property
  BEFORE INSERT OR UPDATE OF supplier_id, property_id ON inventory_receipts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_inventory_receipt_supplier_property();

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_receipts_property_idempotency
  ON inventory_receipts (property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_receipts_property_date
  ON inventory_receipts (property_id, receipt_date DESC, created_at DESC);

-- 5. Upgrade Stock Movements Ledger (from 002_future_modules_foundation.sql) & Make Immutable
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS movement_source VARCHAR(40) NOT NULL DEFAULT 'manual_adjustment',
  ADD COLUMN IF NOT EXISTS quantity_delta NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_before NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_after NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reason VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_id UUID REFERENCES inventory_receipts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS food_order_id UUID REFERENCES food_orders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_key VARCHAR(160),
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_movements_source'
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT chk_stock_movements_source
      CHECK (
        movement_source IN (
          'opening_stock',
          'purchase_receipt',
          'manual_adjustment',
          'wastage',
          'department_issue',
          'order_consumption'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_movements_non_negative_balances'
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT chk_stock_movements_non_negative_balances
      CHECK (stock_before >= 0 AND stock_after >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_property_source_key
  ON stock_movements (property_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_property_source_created
  ON stock_movements (property_id, movement_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_food_order
  ON stock_movements (food_order_id)
  WHERE food_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_receipt
  ON stock_movements (receipt_id)
  WHERE receipt_id IS NOT NULL;

-- Enforce strict immutability on stock_movements (no row-level UPDATE or DELETE allowed)
CREATE OR REPLACE FUNCTION prevent_stock_movements_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Inventory stock movement history is immutable and cannot be modified or deleted'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_movements_immutable ON stock_movements;
CREATE TRIGGER trg_stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION prevent_stock_movements_mutation();

-- 6. Stock Receipt Line Items (links each receipt line to its immutable stock_movement)
CREATE TABLE IF NOT EXISTS inventory_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES inventory_receipts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  product_name_snapshot VARCHAR(150) NOT NULL,
  sku_snapshot VARCHAR(50) NOT NULL,
  unit_snapshot VARCHAR(30) NOT NULL,
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  line_total NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  movement_id UUID REFERENCES stock_movements(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_receipt_items_receipt
  ON inventory_receipt_items (receipt_id, sort_order ASC);

-- 7. Restaurant Menu Item Ingredient Recipes & Order Deduction Tracking
CREATE TABLE IF NOT EXISTS food_menu_item_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL,
  product_id UUID NOT NULL,
  quantity_required NUMERIC(12, 2) NOT NULL CHECK (quantity_required > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_menu_ingredients_menu_item_property
    FOREIGN KEY (menu_item_id, property_id)
    REFERENCES food_menu_items (id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_menu_ingredients_product_property
    FOREIGN KEY (product_id, property_id)
    REFERENCES inventory_products (id, property_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_menu_item_ingredient UNIQUE (menu_item_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_ingredients_property_menu_item
  ON food_menu_item_ingredients (property_id, menu_item_id);

CREATE INDEX IF NOT EXISTS idx_menu_ingredients_property_product
  ON food_menu_item_ingredients (property_id, product_id);

ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS inventory_deducted_at TIMESTAMPTZ;
