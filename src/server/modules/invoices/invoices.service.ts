import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { INVOICE_STATUSES, type InvoiceStatus } from '../../../shared/constants.js';
import { getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import {
  calculateBillableNights,
  computeInvoiceTotalsFromItems,
  fromCents,
  toCents,
} from '../../../shared/pricing.js';
import {
  invoiceFromReservationSchema,
  invoiceLineItemCreateSchema,
  invoiceUpdateSchema,
  invoiceVoidSchema,
  paymentCreateSchema,
} from '../../../shared/schemas.js';
import type {
  InvoiceDetail,
  InvoiceLineItem,
  InvoiceListItem,
  InvoiceListResponse,
  InvoiceSummaryMetrics,
  PaymentRecord,
  Property,
  UserSummary,
} from '../../../shared/types.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';

const INVOICE_LIST_SELECT = `
  SELECT i.*,
         g.first_name AS guest_first_name,
         g.last_name AS guest_last_name,
         g.email AS guest_email,
         g.phone AS guest_phone,
         r.booking_reference,
         r.status AS reservation_status,
         r.arrival_date::text AS arrival_date,
         r.departure_date::text AS departure_date,
         rm.room_number,
         rt.name AS room_type_name
  FROM invoices i
  JOIN guests g ON g.id = i.guest_id
  LEFT JOIN reservations r ON r.id = i.reservation_id
  LEFT JOIN rooms rm ON rm.id = r.room_id
  LEFT JOIN room_types rt ON rt.id = r.room_type_id
`;

function mapInvoiceListItemRow(row: Record<string, any>): InvoiceListItem {
  const issueDate =
    typeof row.issue_date === 'string'
      ? row.issue_date.slice(0, 10)
      : new Date(row.issue_date).toISOString().slice(0, 10);
  const dueDate = row.due_date
    ? typeof row.due_date === 'string'
      ? row.due_date.slice(0, 10)
      : new Date(row.due_date).toISOString().slice(0, 10)
    : null;

  return {
    id: row.id,
    propertyId: row.property_id,
    invoiceNumber: row.invoice_number,
    status: row.status as InvoiceStatus,
    reservationId: row.reservation_id ?? null,
    bookingReference: row.booking_reference ?? null,
    reservationStatus: row.reservation_status ?? null,
    roomNumber: row.room_number ?? null,
    roomTypeName: row.room_type_name ?? null,
    arrivalDate: row.arrival_date ? String(row.arrival_date).slice(0, 10) : null,
    departureDate: row.departure_date ? String(row.departure_date).slice(0, 10) : null,
    guestId: row.guest_id,
    guestName: `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim(),
    guestEmail: row.guest_email ?? '',
    guestPhone: row.guest_phone ?? '',
    issueDate,
    dueDate,
    subtotal: Number(row.subtotal),
    discountTotal: Number(row.discount_total),
    taxName: String(row.tax_name ?? 'GST'),
    taxRate: Number(row.tax_rate ?? 0),
    taxTotal: Number(row.tax_total),
    grandTotal: Number(row.grand_total),
    amountPaid: Number(row.amount_paid),
    balanceDue: Number(row.balance_due),
    currency: String(row.currency ?? 'INR').trim(),
    notes: row.notes ?? '',
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapInvoiceLineItemRow(row: Record<string, any>): InvoiceLineItem {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    serviceChargeId: row.service_charge_id ?? null,
    sourceKey: row.source_key ?? null,
    itemType: row.item_type,
    description: row.description,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    netAmount: Number(row.net_amount ?? 0),
    taxRate: Number(row.tax_rate ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    lineTotal: Number(row.line_total),
    sortOrder: Number(row.sort_order ?? 0),
    metadata:
      row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapPaymentRow(row: Record<string, any>): PaymentRecord {
  const paidAtIso = new Date(row.paid_at).toISOString();
  const paymentDate = row.payment_date
    ? typeof row.payment_date === 'string'
      ? row.payment_date.slice(0, 10)
      : new Date(row.payment_date).toISOString().slice(0, 10)
    : paidAtIso.slice(0, 10);

  return {
    id: row.id,
    propertyId: row.property_id,
    invoiceId: row.invoice_id,
    reservationId: row.reservation_id ?? null,
    paymentReference: row.payment_reference,
    amount: Number(row.amount),
    currency: String(row.currency ?? 'INR').trim(),
    paymentMethod: row.payment_method,
    status: row.status,
    paymentDate,
    paidAt: paidAtIso,
    receivedBy: row.received_by ?? null,
    receivedByName: row.received_by_name ?? null,
    receivedByRole: row.received_by_role ?? null,
    notes: row.notes ?? '',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Allocates a strictly unique sequential invoice number per property under row lock.
 * Updates properties.invoice_settings.next_number without bumping properties.updated_at.
 */
async function allocateNextInvoiceNumber(
  client: PoolClient,
  propertyId: string
): Promise<string> {
  const propRes = await client.query(
    'SELECT invoice_settings, code FROM properties WHERE id = $1 FOR UPDATE',
    [propertyId]
  );
  if (propRes.rowCount === 0) {
    throw AppError.notFound('Property not found');
  }

  const rawSettings = (propRes.rows[0].invoice_settings ?? {}) as Record<string, unknown>;
  const rawPrefix = String(rawSettings.prefix ?? 'INV')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  const prefix = rawPrefix.length > 0 ? rawPrefix : 'INV';

  let candidateNum = Math.max(
    1,
    Math.trunc(Number(rawSettings.next_number ?? rawSettings.nextNumber ?? 1001))
  );

  let invoiceNumber = '';
  for (let attempts = 0; attempts < 5000; attempts++) {
    const formatted = `${prefix}-${String(candidateNum).padStart(4, '0')}`;
    const existsRes = await client.query(
      'SELECT 1 FROM invoices WHERE property_id = $1 AND invoice_number = $2 LIMIT 1',
      [propertyId, formatted]
    );
    if (existsRes.rowCount === 0) {
      invoiceNumber = formatted;
      break;
    }
    candidateNum += 1;
  }

  if (!invoiceNumber) {
    invoiceNumber = `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  }

  await client.query(
    `UPDATE properties
     SET invoice_settings = jsonb_set(
       COALESCE(invoice_settings, '{}'::jsonb),
       '{next_number}',
       to_jsonb($2::int),
       true
     )
     WHERE id = $1`,
    [propertyId, candidateNum + 1]
  );

  return invoiceNumber;
}

/**
 * Recalculates exact decimal monetary totals and derives invoice status inside a transaction.
 * Never marks an unpaid or partially paid invoice as 'paid'.
 */
export async function recomputeAndPersistInvoiceInTx(
  client: PoolClient,
  invoiceId: string,
  actorUserId: string,
  options?: { forceIssueIfDraft?: boolean }
): Promise<void> {
  const invRes = await client.query(
    'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
  if (invRes.rowCount === 0) {
    throw AppError.notFound('Invoice not found');
  }
  const existing = invRes.rows[0];

  const itemsRes = await client.query(
    `SELECT * FROM invoice_line_items
     WHERE invoice_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [invoiceId]
  );

  const paidRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_paid
     FROM payments
     WHERE invoice_id = $1 AND status = 'completed'`,
    [invoiceId]
  );
  const totalPaid = Number(paidRes.rows[0]?.total_paid ?? 0);

  let computed;
  try {
    computed = computeInvoiceTotalsFromItems(
      itemsRes.rows.map((r) => ({
        id: String(r.id),
        itemType: r.item_type,
        quantity: Number(r.quantity),
        unitPrice: Number(r.unit_price),
        taxRate: Number(r.tax_rate ?? 0),
        sourceKey: r.source_key ?? null,
      })),
      totalPaid
    );
  } catch (err) {
    throw AppError.badRequest((err as Error).message);
  }

  for (const itemCalc of computed.items) {
    await client.query(
      `UPDATE invoice_line_items
       SET net_amount = $1,
           tax_amount = $2,
           line_total = $3
       WHERE id = $4 AND invoice_id = $5`,
      [
        itemCalc.netAmount.toFixed(2),
        itemCalc.taxAmount.toFixed(2),
        itemCalc.lineTotal.toFixed(2),
        itemCalc.id,
        invoiceId,
      ]
    );
  }

  let nextStatus = existing.status as InvoiceStatus;
  let nextBalanceDue = computed.balanceDue;
  let issuedAt = existing.issued_at;
  let issuedBy = existing.issued_by;

  if (existing.status === 'void') {
    nextStatus = 'void';
    nextBalanceDue = 0;
  } else {
    const paidCents = toCents(computed.amountPaid);
    const grandCents = toCents(computed.grandTotal);

    if (paidCents > grandCents) {
      throw AppError.conflict(
        `Invoice total (${computed.grandTotal.toFixed(2)}) cannot be reduced below amount already paid (${computed.amountPaid.toFixed(2)}).`
      );
    }

    if (grandCents > 0 && paidCents === grandCents) {
      nextStatus = 'paid';
      if (!issuedAt) {
        issuedAt = new Date().toISOString();
        issuedBy = actorUserId;
      }
    } else if (paidCents > 0 && paidCents < grandCents) {
      nextStatus = 'partially_paid';
      if (!issuedAt) {
        issuedAt = new Date().toISOString();
        issuedBy = actorUserId;
      }
    } else {
      // paidCents === 0: distinguish draft vs issued (unpaid); never auto-mark paid
      if (
        options?.forceIssueIfDraft ||
        existing.status === 'issued' ||
        existing.status === 'partially_paid' ||
        existing.status === 'paid'
      ) {
        nextStatus = 'issued';
        if (!issuedAt) {
          issuedAt = new Date().toISOString();
          issuedBy = actorUserId;
        }
      } else {
        nextStatus = 'draft';
      }
    }
  }

  await client.query(
    `UPDATE invoices
     SET status = $1,
         subtotal = $2,
         discount_total = $3,
         tax_total = $4,
         grand_total = $5,
         amount_paid = $6,
         balance_due = $7,
         issued_at = $8,
         issued_by = $9,
         updated_by = $10,
         updated_at = NOW()
     WHERE id = $11`,
    [
      nextStatus,
      computed.subtotal.toFixed(2),
      computed.discountTotal.toFixed(2),
      computed.taxTotal.toFixed(2),
      computed.grandTotal.toFixed(2),
      computed.amountPaid.toFixed(2),
      nextBalanceDue.toFixed(2),
      issuedAt,
      issuedBy,
      actorUserId,
      invoiceId,
    ]
  );
}

/**
 * Ensures a single active reservation invoice exists and synchronizes its room charge &
 * reservation discount from the reservation's snapshotted rate and billable stay nights.
 * Safe under concurrent retries and stay extensions; never creates duplicate room charges.
 */
export async function ensureAndSyncReservationInvoiceInTx(
  client: PoolClient,
  property: Property,
  reservationId: string,
  actorUserId: string,
  options?: {
    issueImmediately?: boolean;
    dueDate?: string | null;
    notes?: string;
    onlyIfExisting?: boolean;
  }
): Promise<{ invoiceId: string | null; created: boolean }> {
  const resQuery = await client.query(
    `SELECT r.*,
            r.arrival_date::text AS arrival_iso,
            r.departure_date::text AS departure_iso,
            rt.name AS room_type_name,
            rm.room_number
     FROM reservations r
     JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.id = $1 AND r.property_id = $2
     FOR UPDATE OF r`,
    [reservationId, property.id]
  );

  if (resQuery.rowCount === 0) {
    throw AppError.notFound('Reservation not found');
  }
  const resRow = resQuery.rows[0];

  const existingInvRes = await client.query(
    `SELECT * FROM invoices
     WHERE property_id = $1
       AND reservation_id = $2
       AND status != 'void'
     LIMIT 1
     FOR UPDATE`,
    [property.id, reservationId]
  );

  if (existingInvRes.rowCount === 0 && options?.onlyIfExisting) {
    return { invoiceId: null, created: false };
  }

  if (existingInvRes.rowCount === 0 && resRow.status === 'cancelled') {
    throw AppError.badRequest('Cannot generate an invoice for a cancelled reservation.');
  }

  const arrivalIso = String(resRow.arrival_iso).slice(0, 10);
  const departureIso = String(resRow.departure_iso).slice(0, 10);
  const billableNights = calculateBillableNights(arrivalIso, departureIso);
  const nightlyRate = Number(resRow.nightly_rate);
  const discountAmount = Number(resRow.discount_amount ?? 0);
  const snapTaxRate = Number(resRow.tax_rate ?? property.defaultTaxRate);

  let invoiceId: string;
  let created = false;

  if (existingInvRes.rowCount === 0) {
    const propertyToday = getPropertyLocalDate(property.timezone);
    const invoiceNumber = await allocateNextInvoiceNumber(client, property.id);
    const initialStatus: InvoiceStatus = options?.issueImmediately ? 'issued' : 'draft';
    const dueDate = options?.dueDate ?? departureIso;

    const insertInv = await client.query(
      `INSERT INTO invoices (
         property_id, reservation_id, guest_id, invoice_number, status,
         issue_date, due_date, tax_name, tax_rate, property_tax_id, footer_note,
         currency, notes, issued_at, issued_by, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $16
       ) RETURNING id`,
      [
        property.id,
        reservationId,
        resRow.guest_id,
        invoiceNumber,
        initialStatus,
        propertyToday,
        dueDate,
        property.taxName,
        snapTaxRate.toFixed(2),
        property.invoiceSettings.taxId,
        property.invoiceSettings.footerNote,
        String(resRow.currency ?? property.currency).trim(),
        options?.notes ?? '',
        initialStatus === 'issued' ? new Date().toISOString() : null,
        initialStatus === 'issued' ? actorUserId : null,
        actorUserId,
      ]
    );
    invoiceId = insertInv.rows[0].id as string;
    created = true;
  } else {
    invoiceId = existingInvRes.rows[0].id as string;
    if (options?.dueDate !== undefined || options?.notes !== undefined) {
      await client.query(
        `UPDATE invoices
         SET due_date = COALESCE($1, due_date),
             notes = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE notes END,
             updated_by = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [
          options.dueDate ?? null,
          options.notes !== undefined ? options.notes : null,
          actorUserId,
          invoiceId,
        ]
      );
    }
  }

  const roomLabel = resRow.room_number ? `Room ${resRow.room_number}` : 'Assigned Room';
  const roomChargeDescription = `${roomLabel} (${resRow.room_type_name}) — ${billableNights} night${billableNights === 1 ? '' : 's'} (${arrivalIso} to ${departureIso})`;

  await client.query(
    `INSERT INTO invoice_line_items (
       invoice_id, source_key, item_type, description,
       quantity, unit_price, net_amount, tax_rate, tax_amount, line_total,
       sort_order, metadata, created_by
     ) VALUES ($1, 'reservation_room_charge', 'room_charge', $2, $3, $4, 0, $5, 0, 0, 10, $6::jsonb, $7)
     ON CONFLICT (invoice_id, source_key) WHERE source_key IS NOT NULL
     DO UPDATE SET
       description = EXCLUDED.description,
       quantity = EXCLUDED.quantity,
       unit_price = EXCLUDED.unit_price,
       tax_rate = EXCLUDED.tax_rate,
       metadata = EXCLUDED.metadata`,
    [
      invoiceId,
      roomChargeDescription,
      billableNights,
      nightlyRate.toFixed(2),
      snapTaxRate.toFixed(2),
      JSON.stringify({
        arrivalDate: arrivalIso,
        departureDate: departureIso,
        billableNights,
        roomNumber: resRow.room_number ?? null,
        roomTypeName: resRow.room_type_name,
      }),
      actorUserId,
    ]
  );

  if (toCents(discountAmount) > 0) {
    await client.query(
      `INSERT INTO invoice_line_items (
         invoice_id, source_key, item_type, description,
         quantity, unit_price, net_amount, tax_rate, tax_amount, line_total,
         sort_order, metadata, created_by
       ) VALUES ($1, 'reservation_discount', 'discount', $2, 1, $3, 0, 0, 0, 0, 20, $4::jsonb, $5)
       ON CONFLICT (invoice_id, source_key) WHERE source_key IS NOT NULL
       DO UPDATE SET
         description = EXCLUDED.description,
         unit_price = EXCLUDED.unit_price`,
      [
        invoiceId,
        `Reservation Stay Discount (${resRow.booking_reference})`,
        discountAmount.toFixed(2),
        JSON.stringify({ bookingReference: resRow.booking_reference }),
        actorUserId,
      ]
    );
  } else {
    await client.query(
      `DELETE FROM invoice_line_items
       WHERE invoice_id = $1 AND source_key = 'reservation_discount'`,
      [invoiceId]
    );
  }

  await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUserId, {
    forceIssueIfDraft: Boolean(options?.issueImmediately),
  });

  if (created) {
    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId,
        entityType: 'invoice',
        entityId: invoiceId,
        action: options?.issueImmediately ? 'created_and_issued' : 'created',
        summary: `Generated invoice for reservation ${resRow.booking_reference} (${billableNights} night${billableNights === 1 ? '' : 's'})`,
        payload: {
          reservationId,
          bookingReference: resRow.booking_reference,
          billableNights,
          nightlyRate,
        },
      },
      client
    );
  }

  return { invoiceId, created };
}

export interface ListInvoicesFilter {
  status?: string;
  search?: string;
  reservationId?: string;
  guestId?: string;
  issueFrom?: string;
  issueTo?: string;
  unpaidOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listInvoices(
  property: Property,
  filter: ListInvoicesFilter = {}
): Promise<InvoiceListResponse> {
  const pool = getPool();
  const params: unknown[] = [property.id];
  const conditions: string[] = ['i.property_id = $1'];

  if (filter.status) {
    if (filter.status === 'open_balance') {
      conditions.push(`i.status IN ('issued', 'partially_paid') AND i.balance_due > 0`);
    } else if ((INVOICE_STATUSES as readonly string[]).includes(filter.status)) {
      params.push(filter.status);
      conditions.push(`i.status = $${params.length}`);
    } else {
      throw AppError.badRequest(`Invalid invoice status filter: "${filter.status}"`);
    }
  }

  if (filter.unpaidOnly) {
    conditions.push(`i.status != 'void' AND i.balance_due > 0`);
  }

  if (filter.reservationId) {
    params.push(filter.reservationId);
    conditions.push(`i.reservation_id = $${params.length}`);
  }

  if (filter.guestId) {
    params.push(filter.guestId);
    conditions.push(`i.guest_id = $${params.length}`);
  }

  if (filter.issueFrom) {
    if (!isValidIsoDate(filter.issueFrom)) {
      throw AppError.badRequest('Invalid issueFrom date (must be YYYY-MM-DD)');
    }
    params.push(filter.issueFrom);
    conditions.push(`i.issue_date >= $${params.length}::date`);
  }

  if (filter.issueTo) {
    if (!isValidIsoDate(filter.issueTo)) {
      throw AppError.badRequest('Invalid issueTo date (must be YYYY-MM-DD)');
    }
    params.push(filter.issueTo);
    conditions.push(`i.issue_date <= $${params.length}::date`);
  }

  if (filter.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(i.invoice_number ILIKE $${idx}
        OR COALESCE(r.booking_reference, '') ILIKE $${idx}
        OR (g.first_name || ' ' || g.last_name) ILIKE $${idx}
        OR g.email ILIKE $${idx}
        OR g.phone ILIKE $${idx}
        OR COALESCE(rm.room_number, '') ILIKE $${idx})`
    );
  }

  const page = Math.max(1, Math.trunc(filter.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filter.pageSize ?? 20)));
  const offset = (page - 1) * pageSize;

  const whereSql = conditions.join(' AND ');

  const [countRes, listRes, summaryRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM invoices i
       JOIN guests g ON g.id = i.guest_id
       LEFT JOIN reservations r ON r.id = i.reservation_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
       WHERE ${whereSql}`,
      params
    ),
    pool.query(
      `${INVOICE_LIST_SELECT}
       WHERE ${whereSql}
       ORDER BY i.issue_date DESC, i.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_invoices,
         COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_count,
         COUNT(*) FILTER (WHERE status = 'issued')::int AS issued_unpaid_count,
         COUNT(*) FILTER (WHERE status = 'partially_paid')::int AS partially_paid_count,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
         COUNT(*) FILTER (WHERE status = 'void')::int AS void_count,
         COALESCE(SUM(grand_total) FILTER (WHERE status != 'void'), 0) AS total_billed,
         COALESCE(SUM(amount_paid) FILTER (WHERE status != 'void'), 0) AS total_collected,
         COALESCE(SUM(balance_due) FILTER (WHERE status != 'void'), 0) AS total_outstanding
       FROM invoices
       WHERE property_id = $1`,
      [property.id]
    ),
  ]);

  const total = Number(countRes.rows[0]?.total ?? 0);
  const sumRow = summaryRes.rows[0] ?? {};
  const summary: InvoiceSummaryMetrics = {
    totalInvoices: Number(sumRow.total_invoices ?? 0),
    draftCount: Number(sumRow.draft_count ?? 0),
    issuedUnpaidCount: Number(sumRow.issued_unpaid_count ?? 0),
    partiallyPaidCount: Number(sumRow.partially_paid_count ?? 0),
    paidCount: Number(sumRow.paid_count ?? 0),
    voidCount: Number(sumRow.void_count ?? 0),
    totalBilled: Number(sumRow.total_billed ?? 0),
    totalCollected: Number(sumRow.total_collected ?? 0),
    totalOutstandingBalance: Number(sumRow.total_outstanding ?? 0),
    currency: property.currency,
  };

  return {
    items: listRes.rows.map(mapInvoiceListItemRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary,
  };
}

export async function getInvoiceDetail(
  propertyId: string,
  invoiceId: string,
  db: Queryable = getPool()
): Promise<InvoiceDetail> {
  const invRes = await db.query(
    `SELECT i.*,
            g.first_name AS guest_first_name,
            g.last_name AS guest_last_name,
            g.email AS guest_email,
            g.phone AS guest_phone,
            g.address_line1 AS guest_address_line1,
            g.city AS guest_city,
            g.state_region AS guest_state_region,
            g.postal_code AS guest_postal_code,
            g.country AS guest_country,
            p.code AS prop_code,
            p.name AS prop_name,
            p.email AS prop_email,
            p.phone AS prop_phone,
            p.website AS prop_website,
            p.address_line1 AS prop_address1,
            p.address_line2 AS prop_address2,
            p.city AS prop_city,
            p.state_region AS prop_state_region,
            p.postal_code AS prop_postal_code,
            p.country AS prop_country,
            p.currency AS prop_currency,
            r.booking_reference,
            r.status AS reservation_status,
            r.arrival_date::text AS arrival_date,
            r.departure_date::text AS departure_date,
            rm.room_number,
            rt.name AS room_type_name,
            u_created.full_name AS created_by_name,
            u_issued.full_name AS issued_by_name,
            u_voided.full_name AS voided_by_name
     FROM invoices i
     JOIN properties p ON p.id = i.property_id
     JOIN guests g ON g.id = i.guest_id
     LEFT JOIN reservations r ON r.id = i.reservation_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN users u_created ON u_created.id = i.created_by
     LEFT JOIN users u_issued ON u_issued.id = i.issued_by
     LEFT JOIN users u_voided ON u_voided.id = i.voided_by
     WHERE i.id = $1 AND i.property_id = $2
     LIMIT 1`,
    [invoiceId, propertyId]
  );

  if (invRes.rowCount === 0) {
    throw AppError.notFound('Invoice not found');
  }
  const row = invRes.rows[0];
  const base = mapInvoiceListItemRow(row);

  const [itemsRes, paymentsRes] = await Promise.all([
    db.query(
      `SELECT li.*, u.full_name AS created_by_name
       FROM invoice_line_items li
       LEFT JOIN users u ON u.id = li.created_by
       WHERE li.invoice_id = $1
       ORDER BY li.sort_order ASC, li.created_at ASC`,
      [invoiceId]
    ),
    db.query(
      `SELECT pay.*, u.full_name AS received_by_name, u.role AS received_by_role
       FROM payments pay
       LEFT JOIN users u ON u.id = pay.received_by
       WHERE pay.invoice_id = $1 AND pay.property_id = $2
       ORDER BY pay.paid_at ASC, pay.created_at ASC`,
      [invoiceId, propertyId]
    ),
  ]);

  const taxableSubtotal = fromCents(
    Math.max(0, toCents(base.subtotal) - toCents(base.discountTotal))
  );

  return {
    ...base,
    taxableSubtotal,
    propertyTaxId: String(row.property_tax_id ?? ''),
    footerNote: String(row.footer_note ?? ''),
    issuedBy: row.issued_by ?? null,
    issuedByName: row.issued_by_name ?? null,
    voidedBy: row.voided_by ?? null,
    voidedByName: row.voided_by_name ?? null,
    voidReason: row.void_reason ?? '',
    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name ?? null,
    propertyHeader: {
      id: row.property_id,
      code: row.prop_code,
      name: row.prop_name,
      email: row.prop_email,
      phone: row.prop_phone,
      website: row.prop_website ?? '',
      addressLine1: row.prop_address1,
      addressLine2: row.prop_address2 ?? '',
      city: row.prop_city,
      stateRegion: row.prop_state_region ?? '',
      postalCode: row.prop_postal_code ?? '',
      country: row.prop_country ?? '',
      currency: String(row.prop_currency ?? 'INR').trim(),
    },
    guest: {
      id: row.guest_id,
      fullName: base.guestName,
      email: row.guest_email ?? '',
      phone: row.guest_phone ?? '',
      addressLine1: row.guest_address_line1 ?? '',
      city: row.guest_city ?? '',
      stateRegion: row.guest_state_region ?? '',
      postalCode: row.guest_postal_code ?? '',
      country: row.guest_country ?? '',
    },
    lineItems: itemsRes.rows.map(mapInvoiceLineItemRow),
    payments: paymentsRes.rows.map(mapPaymentRow),
  };
}

export async function getReservationActiveInvoice(
  propertyId: string,
  reservationId: string
): Promise<InvoiceDetail | null> {
  const pool = getPool();
  const resCheck = await pool.query(
    'SELECT id FROM reservations WHERE id = $1 AND property_id = $2 LIMIT 1',
    [reservationId, propertyId]
  );
  if (resCheck.rowCount === 0) {
    throw AppError.notFound('Reservation not found');
  }

  const invRes = await pool.query(
    `SELECT id FROM invoices
     WHERE property_id = $1 AND reservation_id = $2 AND status != 'void'
     ORDER BY created_at DESC
     LIMIT 1`,
    [propertyId, reservationId]
  );

  if (invRes.rowCount === 0) {
    return null;
  }
  return getInvoiceDetail(propertyId, String(invRes.rows[0].id));
}

export async function createOrSyncInvoiceFromReservation(
  property: Property,
  reservationId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{ invoice: InvoiceDetail; created: boolean }> {
  const input = invoiceFromReservationSchema.parse(rawInput ?? {});

  const { invoiceId, created } = await withTransaction(async (client) => {
    const res = await ensureAndSyncReservationInvoiceInTx(
      client,
      property,
      reservationId,
      actorUser.id,
      {
        issueImmediately: input.issueImmediately,
        dueDate: input.dueDate ?? undefined,
        notes: input.notes,
      }
    );
    return { invoiceId: res.invoiceId!, created: res.created };
  });

  const invoice = await getInvoiceDetail(property.id, invoiceId);
  return { invoice, created };
}

export async function syncInvoiceWithReservation(
  property: Property,
  invoiceId: string,
  actorUser: UserSummary
): Promise<InvoiceDetail> {
  await withTransaction(async (client) => {
    const invRes = await client.query(
      'SELECT id, reservation_id, status FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const inv = invRes.rows[0];
    if (inv.status === 'void') {
      throw AppError.conflict('Cannot sync a voided invoice.');
    }
    if (!inv.reservation_id) {
      throw AppError.badRequest('This invoice is not linked to a reservation.');
    }

    await ensureAndSyncReservationInvoiceInTx(
      client,
      property,
      String(inv.reservation_id),
      actorUser.id
    );
  });

  return getInvoiceDetail(property.id, invoiceId);
}

export async function issueInvoice(
  property: Property,
  invoiceId: string,
  actorUser: UserSummary
): Promise<InvoiceDetail> {
  await withTransaction(async (client) => {
    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const existing = invRes.rows[0];
    if (existing.status === 'void') {
      throw AppError.conflict('Cannot issue a voided invoice.');
    }

    await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUser.id, {
      forceIssueIfDraft: true,
    });

    if (existing.status === 'draft') {
      await recordAuditEvent(
        {
          propertyId: property.id,
          actorUserId: actorUser.id,
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'issued',
          summary: `Issued invoice ${existing.invoice_number}`,
        },
        client
      );
    }
  });

  return getInvoiceDetail(property.id, invoiceId);
}

export async function updateInvoiceMetadata(
  property: Property,
  invoiceId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<InvoiceDetail> {
  const input = invoiceUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const existing = invRes.rows[0];
    if (existing.status === 'void') {
      throw AppError.conflict('Cannot edit a voided invoice.');
    }

    const nextDueDate =
      input.dueDate !== undefined ? input.dueDate : existing.due_date;
    const nextNotes = input.notes !== undefined ? input.notes : existing.notes;

    const issueIso =
      typeof existing.issue_date === 'string'
        ? existing.issue_date.slice(0, 10)
        : new Date(existing.issue_date).toISOString().slice(0, 10);
    if (nextDueDate && nextDueDate < issueIso) {
      throw AppError.badRequest('Invoice due date cannot be earlier than issue date.');
    }

    await client.query(
      `UPDATE invoices
       SET due_date = $1,
           notes = $2,
           updated_by = $3,
           updated_at = NOW()
       WHERE id = $4 AND property_id = $5`,
      [nextDueDate, nextNotes, actorUser.id, invoiceId, property.id]
    );
  });

  return getInvoiceDetail(property.id, invoiceId);
}

export async function addInvoiceLineItem(
  property: Property,
  invoiceId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<InvoiceDetail> {
  const input = invoiceLineItemCreateSchema.parse(rawInput);

  if (
    (input.itemType === 'discount' ||
      input.itemType === 'adjustment' ||
      input.itemType === 'room_charge') &&
    actorUser.role !== 'admin'
  ) {
    throw AppError.forbidden(
      `Administrator role is required to post manual ${input.itemType.replace('_', ' ')} items.`
    );
  }

  await withTransaction(async (client) => {
    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const existing = invRes.rows[0];

    if (existing.status === 'void') {
      throw AppError.conflict('Cannot add charges to a voided invoice.');
    }
    if (existing.status === 'paid') {
      throw AppError.conflict('Cannot add line items to an invoice that is already Paid.');
    }

    const sourceKey = input.idempotencyKey ? `manual:${input.idempotencyKey}` : null;
    if (sourceKey) {
      const dupRes = await client.query(
        'SELECT id FROM invoice_line_items WHERE invoice_id = $1 AND source_key = $2 LIMIT 1',
        [invoiceId, sourceKey]
      );
      if ((dupRes.rowCount ?? 0) > 0) {
        throw AppError.conflict('This folio charge submission has already been recorded.');
      }
    }

    const sortRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 20)::int AS max_sort FROM invoice_line_items WHERE invoice_id = $1',
      [invoiceId]
    );
    const nextSort = Number(sortRes.rows[0]?.max_sort ?? 20) + 10;

    const effectiveTaxRate =
      input.itemType === 'discount'
        ? 0
        : input.taxRate !== undefined
          ? input.taxRate
          : Number(existing.tax_rate ?? property.defaultTaxRate);

    await client.query(
      `INSERT INTO invoice_line_items (
         invoice_id, source_key, item_type, description,
         quantity, unit_price, net_amount, tax_rate, tax_amount, line_total,
         sort_order, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 0, 0, $8, $9)`,
      [
        invoiceId,
        sourceKey,
        input.itemType,
        input.description,
        input.quantity,
        input.unitPrice.toFixed(2),
        effectiveTaxRate.toFixed(2),
        nextSort,
        actorUser.id,
      ]
    );

    await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUser.id);

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'invoice',
        entityId: invoiceId,
        action: 'line_item_added',
        summary: `Added ${input.itemType} item "${input.description}" to invoice ${existing.invoice_number}`,
        payload: {
          itemType: input.itemType,
          description: input.description,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
        },
      },
      client
    );
  });

  return getInvoiceDetail(property.id, invoiceId);
}

export async function removeInvoiceLineItem(
  property: Property,
  invoiceId: string,
  itemId: string,
  actorUser: UserSummary
): Promise<InvoiceDetail> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to remove invoice line items.');
  }

  await withTransaction(async (client) => {
    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const existing = invRes.rows[0];
    if (existing.status === 'void' || existing.status === 'paid') {
      throw AppError.conflict(`Cannot remove items from a ${existing.status} invoice.`);
    }

    const itemRes = await client.query(
      'SELECT * FROM invoice_line_items WHERE id = $1 AND invoice_id = $2',
      [itemId, invoiceId]
    );
    if (itemRes.rowCount === 0) {
      throw AppError.notFound('Invoice line item not found');
    }
    const item = itemRes.rows[0];
    if (
      existing.reservation_id &&
      (item.source_key === 'reservation_room_charge' ||
        item.source_key === 'reservation_discount')
    ) {
      throw AppError.badRequest(
        'Reservation stay room charges and stay discounts are governed by the linked reservation.'
      );
    }
    if (
      typeof item.source_key === 'string' &&
      (item.source_key.startsWith('food_order:') ||
        item.source_key.startsWith('food_order_reversal:') ||
        item.source_key.startsWith('voided_food_order:'))
    ) {
      throw AppError.badRequest(
        'Posted food order charges cannot be silently deleted. Use the auditable Food Order Reversal workflow instead.'
      );
    }

    await client.query(
      'DELETE FROM invoice_line_items WHERE id = $1 AND invoice_id = $2',
      [itemId, invoiceId]
    );

    await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUser.id);

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'invoice',
        entityId: invoiceId,
        action: 'line_item_removed',
        summary: `Removed line item "${item.description}" from invoice ${existing.invoice_number}`,
      },
      client
    );
  });

  return getInvoiceDetail(property.id, invoiceId);
}

export async function recordInvoicePayment(
  property: Property,
  invoiceId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{ invoice: InvoiceDetail; payment: PaymentRecord }> {
  const input = paymentCreateSchema.parse(rawInput);

  const paymentId = await withTransaction(async (client) => {
    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const existing = invRes.rows[0];

    if (existing.status === 'void') {
      throw AppError.conflict('Cannot record a payment against a voided invoice.');
    }

    if (input.idempotencyKey) {
      const dupCheck = await client.query(
        'SELECT id FROM payments WHERE invoice_id = $1 AND idempotency_key = $2 LIMIT 1',
        [invoiceId, input.idempotencyKey]
      );
      if ((dupCheck.rowCount ?? 0) > 0) {
        throw AppError.conflict('Duplicate payment submission detected for this request.');
      }
    }

    // Recompute exact completed payments under lock to prevent concurrent overpayment
    const paidRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM payments
       WHERE invoice_id = $1 AND status = 'completed'`,
      [invoiceId]
    );
    const paidCents = toCents(paidRes.rows[0]?.total_paid ?? 0);
    const grandCents = toCents(existing.grand_total);
    const remainingCents = grandCents - paidCents;

    if (remainingCents <= 0) {
      throw AppError.conflict('Invoice has no outstanding balance due.');
    }

    const paymentCents = toCents(input.amount);
    if (paymentCents > remainingCents) {
      throw AppError.badRequest(
        `Payment amount (${fromCents(paymentCents).toFixed(2)}) exceeds the outstanding balance due (${fromCents(remainingCents).toFixed(2)}).`,
        {
          reason: 'OVERPAYMENT_NOT_ALLOWED',
          balanceDue: fromCents(remainingCents),
        }
      );
    }

    const paymentDate = input.paymentDate ?? getPropertyLocalDate(property.timezone);
    const paymentRef =
      input.paymentReference && input.paymentReference.length > 0
        ? input.paymentReference
        : `PAY-${paymentDate.replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const insertPay = await client.query(
      `INSERT INTO payments (
         property_id, invoice_id, reservation_id, payment_reference,
         amount, currency, payment_method, status,
         payment_date, paid_at, received_by, notes, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, NOW(), $9, $10, $11)
       RETURNING id`,
      [
        property.id,
        invoiceId,
        existing.reservation_id ?? null,
        paymentRef,
        fromCents(paymentCents).toFixed(2),
        String(existing.currency ?? property.currency).trim(),
        input.paymentMethod,
        paymentDate,
        actorUser.id,
        input.notes,
        input.idempotencyKey ?? null,
      ]
    );

    const newPaymentId = insertPay.rows[0].id as string;

    await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUser.id, {
      forceIssueIfDraft: true,
    });

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'invoice',
        entityId: invoiceId,
        action: 'payment_recorded',
        summary: `Recorded ${input.paymentMethod.toUpperCase()} payment of ${fromCents(paymentCents).toFixed(2)} on invoice ${existing.invoice_number}`,
        payload: {
          paymentId: newPaymentId,
          amount: fromCents(paymentCents),
          paymentMethod: input.paymentMethod,
          paymentDate,
          paymentReference: paymentRef,
        },
      },
      client
    );

    return newPaymentId;
  });

  const invoice = await getInvoiceDetail(property.id, invoiceId);
  const payment = invoice.payments.find((p) => p.id === paymentId)!;
  return { invoice, payment };
}

export async function voidInvoice(
  property: Property,
  invoiceId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<InvoiceDetail> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to void an invoice.');
  }
  const input = invoiceVoidSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const preInvRes = await client.query(
      'SELECT id, reservation_id FROM invoices WHERE id = $1 AND property_id = $2',
      [invoiceId, property.id]
    );
    if (preInvRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }

    // Preserve consistent lock order: reservations -> invoices -> food_orders
    const preReservationId = preInvRes.rows[0].reservation_id as string | null;
    if (preReservationId) {
      await client.query(
        'SELECT id FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE',
        [preReservationId, property.id]
      );
    }

    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [invoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Invoice not found');
    }
    const existing = invRes.rows[0];
    if (existing.status === 'void') {
      throw AppError.badRequest('Invoice is already voided.');
    }

    const paidRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM payments
       WHERE invoice_id = $1 AND status = 'completed'`,
      [invoiceId]
    );
    if (toCents(paidRes.rows[0]?.total_paid ?? 0) > 0) {
      throw AppError.conflict(
        'Cannot void an invoice that has recorded payments. Payment history must be preserved.'
      );
    }

    // Lock only currently posted room-service orders linked to this unpaid invoice.
    // Orders already marked 'reversed' remain 'reversed' and are never re-released.
    const postedOrdersRes = await client.query(
      `SELECT id, order_reference, posted_line_item_id, posted_service_charge_id
       FROM food_orders
       WHERE property_id = $1
         AND posted_invoice_id = $2
         AND billing_status = 'posted'
       ORDER BY id ASC
       FOR UPDATE`,
      [property.id, invoiceId]
    );

    const postedServiceRequestsRes = await client.query(
      `SELECT id, request_number, posted_line_item_id, posted_service_charge_id
       FROM service_requests
       WHERE property_id = $1
         AND posted_invoice_id = $2
         AND billing_status = 'posted'
       ORDER BY id ASC
       FOR UPDATE`,
      [property.id, invoiceId]
    );

    await client.query(
      `UPDATE invoices
       SET status = 'void',
           balance_due = 0,
           voided_at = NOW(),
           voided_by = $1,
           void_reason = $2,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [actorUser.id, input.reason, invoiceId, property.id]
    );

    const releasedOrderIds: string[] = [];
    const releasedServiceRequestIds: string[] = [];

    for (const orderRow of postedOrdersRes.rows) {
      const orderId = String(orderRow.id);
      const orderRef = String(orderRow.order_reference);
      const postedLineItemId = orderRow.posted_line_item_id
        ? String(orderRow.posted_line_item_id)
        : null;
      const postedServiceChargeId = orderRow.posted_service_charge_id
        ? String(orderRow.posted_service_charge_id)
        : null;
      const archivedSourceKey = `voided_food_order:${invoiceId}:${orderId}`;

      // Preserve historical line item on the voided invoice while archiving source_key
      // so uq_invoice_items_food_order_global allows legitimate reposting to a replacement folio.
      await client.query(
        `UPDATE invoice_line_items
         SET source_key = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'archivedFromSourceKey', source_key,
               'releasedByInvoiceVoid', true,
               'voidedInvoiceNumber', $2::text
             )
         WHERE invoice_id = $3
           AND (
             ($4::uuid IS NOT NULL AND id = $4::uuid)
             OR source_key = $5
           )`,
        [
          archivedSourceKey,
          String(existing.invoice_number),
          invoiceId,
          postedLineItemId,
          `food_order:${orderId}`,
        ]
      );

      await client.query(
        `UPDATE reservation_service_charges
         SET status = 'voided'
         WHERE property_id = $1
           AND (
             ($2::uuid IS NOT NULL AND id = $2::uuid)
             OR (food_order_id = $3::uuid AND status != 'voided')
           )`,
        [property.id, postedServiceChargeId, orderId]
      );

      await client.query(
        `UPDATE food_orders
         SET billing_status = 'unbilled',
             posted_invoice_id = NULL,
             posted_line_item_id = NULL,
             posted_service_charge_id = NULL,
             posted_at = NULL,
             posted_by = NULL,
             updated_by = $1,
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3 AND billing_status = 'posted'`,
        [actorUser.id, orderId, property.id]
      );

      releasedOrderIds.push(orderId);

      await recordAuditEvent(
        {
          propertyId: property.id,
          actorUserId: actorUser.id,
          entityType: 'food_order',
          entityId: orderId,
          action: 'folio_posting_released_on_void',
          summary: `Released room-service order ${orderRef} back to unbilled after voiding unpaid invoice ${existing.invoice_number}`,
          payload: {
            voidedInvoiceId: invoiceId,
            voidedInvoiceNumber: existing.invoice_number,
            voidReason: input.reason,
          },
        },
        client
      );
    }

    for (const srRow of postedServiceRequestsRes.rows) {
      const srId = String(srRow.id);
      const srRef = String(srRow.request_number);
      const postedLineItemId = srRow.posted_line_item_id
        ? String(srRow.posted_line_item_id)
        : null;
      const postedServiceChargeId = srRow.posted_service_charge_id
        ? String(srRow.posted_service_charge_id)
        : null;
      const archivedSourceKey = `voided_service_request:${invoiceId}:${srId}`;

      await client.query(
        `UPDATE invoice_line_items
         SET source_key = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'archivedFromSourceKey', source_key,
               'releasedByInvoiceVoid', true,
               'voidedInvoiceNumber', $2::text
             )
         WHERE invoice_id = $3
           AND (
             ($4::uuid IS NOT NULL AND id = $4::uuid)
             OR source_key = $5
           )`,
        [
          archivedSourceKey,
          String(existing.invoice_number),
          invoiceId,
          postedLineItemId,
          `service_request:${srId}`,
        ]
      );

      await client.query(
        `UPDATE reservation_service_charges
         SET status = 'voided'
         WHERE property_id = $1
           AND (
             ($2::uuid IS NOT NULL AND id = $2::uuid)
             OR (service_request_id = $3::uuid AND status != 'voided')
           )`,
        [property.id, postedServiceChargeId, srId]
      );

      await client.query(
        `UPDATE service_requests
         SET billing_status = 'unbilled',
             posted_invoice_id = NULL,
             posted_line_item_id = NULL,
             posted_service_charge_id = NULL,
             posted_at = NULL,
             posted_by = NULL,
             posting_idempotency_key = NULL,
             updated_by = $1,
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3 AND billing_status = 'posted'`,
        [actorUser.id, srId, property.id]
      );

      await client.query(
        `INSERT INTO service_request_history (
           service_request_id, property_id, action, from_status, to_status, note, metadata, actor_user_id
         ) VALUES ($1, $2, 'folio_released_on_void', 'completed', 'completed', $3, $4::jsonb, $5)`,
        [
          srId,
          property.id,
          `Released back to unbilled after unpaid invoice ${existing.invoice_number} was voided`,
          JSON.stringify({
            voidedInvoiceId: invoiceId,
            voidedInvoiceNumber: existing.invoice_number,
            voidReason: input.reason,
          }),
          actorUser.id,
        ]
      );

      releasedServiceRequestIds.push(srId);

      await recordAuditEvent(
        {
          propertyId: property.id,
          actorUserId: actorUser.id,
          entityType: 'service_request',
          entityId: srId,
          action: 'folio_posting_released_on_void',
          summary: `Released service request ${srRef} back to unbilled after voiding unpaid invoice ${existing.invoice_number}`,
          payload: {
            voidedInvoiceId: invoiceId,
            voidedInvoiceNumber: existing.invoice_number,
            voidReason: input.reason,
          },
        },
        client
      );
    }

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'invoice',
        entityId: invoiceId,
        action: 'voided',
        summary: `Voided invoice ${existing.invoice_number}: ${input.reason}`,
        payload: {
          reason: input.reason,
          releasedFoodOrderIds: releasedOrderIds,
          releasedServiceRequestIds,
        },
      },
      client
    );
  });

  return getInvoiceDetail(property.id, invoiceId);
}
