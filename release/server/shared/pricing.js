import { diffDays } from './dates.js';
export function roundCurrency(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
export function toCents(amount) {
    const num = typeof amount === 'string' ? Number(amount) : amount;
    if (!Number.isFinite(num)) {
        throw new Error('Invalid monetary amount');
    }
    return Math.round((num + Math.sign(num) * Number.EPSILON) * 100);
}
export function fromCents(cents) {
    return Math.round(cents) / 100;
}
/**
 * Computes billable room nights for an arrival/departure window.
 * Same-day stays (arrivalDate === departureDate, diff === 0) bill 1 night;
 * standard overnight and extended stays bill exact (departureDate - arrivalDate) nights.
 */
export function calculateBillableNights(arrivalDate, departureDate) {
    const rawNights = diffDays(arrivalDate, departureDate);
    if (rawNights < 0) {
        throw new Error('Departure date cannot be before arrival date');
    }
    return Math.max(1, rawNights);
}
/**
 * Exact integer-cent invoice calculation engine.
 * Applies discounts before tax (reservation_discount against room_charge first,
 * then any additional discounts across remaining charge items) so reservation
 * estimates and invoice totals match to the exact cent without float drift.
 */
export function computeInvoiceTotalsFromItems(rawItems, amountPaidInput = 0) {
    // Identify food orders that have an explicit auditable reversal item on this invoice
    const reversedFoodOrderIds = new Set();
    for (const item of rawItems) {
        if (item.itemType === 'adjustment' &&
            item.sourceKey?.startsWith('food_order_reversal:')) {
            reversedFoodOrderIds.add(item.sourceKey.slice('food_order_reversal:'.length));
        }
    }
    const chargeEntries = [];
    const reversalEntries = [];
    const discountEntries = [];
    for (const item of rawItems) {
        const qty = Number(item.quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error('Line item quantity must be greater than zero');
        }
        const unitCents = toCents(item.unitPrice);
        if (item.itemType === 'discount') {
            const discCents = Math.round(qty * Math.abs(unitCents));
            discountEntries.push({
                id: item.id,
                discCents,
                sourceKey: item.sourceKey ?? null,
            });
        }
        else if (item.itemType === 'adjustment' &&
            unitCents < 0 &&
            item.sourceKey?.startsWith('food_order_reversal:')) {
            reversalEntries.push({
                id: item.id,
                netCents: Math.round(qty * unitCents),
                taxRate: roundCurrency(Number(item.taxRate ?? 0)),
            });
        }
        else {
            if (unitCents < 0) {
                throw new Error('Charge unit price cannot be negative; use a discount item instead');
            }
            const netCents = Math.round(qty * unitCents);
            const isReversedFoodOrder = Boolean(item.sourceKey?.startsWith('food_order:') &&
                reversedFoodOrderIds.has(item.sourceKey.slice('food_order:'.length)));
            chargeEntries.push({
                id: item.id,
                itemType: item.itemType,
                netCents,
                taxRate: roundCurrency(Number(item.taxRate ?? 0)),
                discountAllocatedCents: 0,
                isReversedFoodOrder,
            });
        }
    }
    const grossChargesCents = chargeEntries.reduce((sum, c) => sum + c.netCents, 0);
    const reversalNetCents = reversalEntries.reduce((sum, r) => sum + r.netCents, 0); // <= 0
    const subtotalCents = grossChargesCents + reversalNetCents;
    const discountTotalCents = discountEntries.reduce((sum, d) => sum + d.discCents, 0);
    if (subtotalCents < 0) {
        throw new Error('Reversals cannot reduce invoice subtotal below zero');
    }
    if (discountTotalCents > subtotalCents) {
        throw new Error('Total discounts cannot exceed invoice subtotal');
    }
    let unallocatedDiscountCents = discountTotalCents;
    // 1. Allocate reservation_discount directly against room_charge lines first
    const resDiscCents = discountEntries
        .filter((d) => d.sourceKey === 'reservation_discount')
        .reduce((sum, d) => sum + d.discCents, 0);
    let remainingResDisc = resDiscCents;
    for (const ch of chargeEntries) {
        if (remainingResDisc <= 0)
            break;
        if (ch.itemType !== 'room_charge' || ch.isReversedFoodOrder)
            continue;
        const cap = ch.netCents - ch.discountAllocatedCents;
        const take = Math.min(cap, remainingResDisc);
        ch.discountAllocatedCents += take;
        remainingResDisc -= take;
        unallocatedDiscountCents -= take;
    }
    // 2. Allocate any remaining discount proportionally across active unreversed charge balances
    if (unallocatedDiscountCents > 0) {
        const eligible = chargeEntries.filter((c) => !c.isReversedFoodOrder && c.netCents - c.discountAllocatedCents > 0);
        const remainingCapacity = eligible.reduce((sum, c) => sum + (c.netCents - c.discountAllocatedCents), 0);
        let distributed = 0;
        eligible.forEach((ch, idx) => {
            const cap = ch.netCents - ch.discountAllocatedCents;
            const share = idx === eligible.length - 1
                ? unallocatedDiscountCents - distributed
                : Math.min(cap, Math.round((unallocatedDiscountCents * cap) / remainingCapacity));
            ch.discountAllocatedCents += share;
            distributed += share;
        });
    }
    const computedMap = new Map();
    let taxTotalCents = 0;
    for (const ch of chargeEntries) {
        const taxableCents = Math.max(0, ch.netCents - ch.discountAllocatedCents);
        const taxCents = Math.round((taxableCents * ch.taxRate) / 100);
        taxTotalCents += taxCents;
        computedMap.set(ch.id, {
            id: ch.id,
            netAmount: fromCents(ch.netCents),
            taxAmount: fromCents(taxCents),
            lineTotal: fromCents(ch.netCents + taxCents),
        });
    }
    for (const rev of reversalEntries) {
        const revTaxCents = -Math.round((Math.abs(rev.netCents) * rev.taxRate) / 100);
        taxTotalCents += revTaxCents;
        computedMap.set(rev.id, {
            id: rev.id,
            netAmount: fromCents(rev.netCents),
            taxAmount: fromCents(revTaxCents),
            lineTotal: fromCents(rev.netCents + revTaxCents),
        });
    }
    for (const d of discountEntries) {
        computedMap.set(d.id, {
            id: d.id,
            netAmount: fromCents(-d.discCents),
            taxAmount: 0,
            lineTotal: fromCents(-d.discCents),
        });
    }
    const taxableSubtotalCents = subtotalCents - discountTotalCents;
    const grandTotalCents = taxableSubtotalCents + taxTotalCents;
    const paidCents = Math.max(0, toCents(amountPaidInput));
    const balanceDueCents = Math.max(0, grandTotalCents - paidCents);
    return {
        items: rawItems.map((r) => computedMap.get(r.id)),
        subtotal: fromCents(subtotalCents),
        discountTotal: fromCents(discountTotalCents),
        taxableSubtotal: fromCents(taxableSubtotalCents),
        taxTotal: fromCents(taxTotalCents),
        grandTotal: fromCents(grandTotalCents),
        amountPaid: fromCents(paidCents),
        balanceDue: fromCents(balanceDueCents),
    };
}
export function calculateFoodOrderTotals(items, taxRateInput) {
    if (items.length === 0) {
        throw new Error('Food order must include at least one item');
    }
    const taxRate = roundCurrency(Number(taxRateInput ?? 0));
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        throw new Error('Tax rate must be between 0 and 100');
    }
    const lineSubtotals = [];
    let subtotalCents = 0;
    for (const item of items) {
        const qty = Math.trunc(Number(item.quantity));
        if (!Number.isInteger(qty) || qty < 1 || qty > 500) {
            throw new Error('Item quantity must be an integer between 1 and 500');
        }
        const unitCents = toCents(item.unitPrice);
        if (unitCents < 1) {
            throw new Error('Menu item unit price must be at least 0.01');
        }
        const lineCents = qty * unitCents;
        subtotalCents += lineCents;
        lineSubtotals.push(fromCents(lineCents));
    }
    const taxCents = Math.round((subtotalCents * taxRate) / 100);
    const totalCents = subtotalCents + taxCents;
    return {
        lineSubtotals,
        subtotal: fromCents(subtotalCents),
        taxRate,
        taxAmount: fromCents(taxCents),
        totalAmount: fromCents(totalCents),
    };
}
export function calculateReservationFinancials(input) {
    const nights = Math.max(0, Math.trunc(input.nights));
    const nightlyRateCents = Math.round(input.nightlyRate * 100);
    const discountCents = Math.round((input.discountAmount ?? 0) * 100);
    const taxRate = roundCurrency(input.taxRate ?? 0);
    const subtotalCents = nights * nightlyRateCents;
    if (discountCents > subtotalCents) {
        throw new Error('Discount amount cannot exceed room subtotal');
    }
    const taxableCents = Math.max(0, subtotalCents - discountCents);
    const taxCents = Math.round((taxableCents * taxRate) / 100);
    const totalCents = taxableCents + taxCents;
    return {
        nights,
        nightlyRate: nightlyRateCents / 100,
        roomSubtotal: subtotalCents / 100,
        discountAmount: discountCents / 100,
        taxableAmount: taxableCents / 100,
        taxRate,
        taxAmount: taxCents / 100,
        estimatedTotal: totalCents / 100,
    };
}
export function formatMoney(amount, currency = 'INR') {
    const numeric = typeof amount === 'string' ? Number(amount) : amount;
    const safeNum = Number.isFinite(numeric) ? numeric : 0;
    try {
        return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
            style: 'currency',
            currency: currency || 'INR',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(safeNum);
    }
    catch {
        return `${currency} ${safeNum.toFixed(2)}`;
    }
}
