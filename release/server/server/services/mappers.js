import { getRoomCleaningStage } from '../../shared/constants.js';
import { getPropertyLocalDate } from '../../shared/dates.js';
export function mapPropertyRow(row) {
    const rawInv = (row.invoice_settings ?? {});
    const invoiceSettings = {
        prefix: String(rawInv.prefix ?? 'INV'),
        nextNumber: Number(rawInv.next_number ?? rawInv.nextNumber ?? 1001),
        taxId: String(rawInv.tax_id ?? rawInv.taxId ?? ''),
        footerNote: String(rawInv.footer_note ?? rawInv.footerNote ?? 'Thank you for staying with us.'),
    };
    const timezone = String(row.timezone ?? 'Asia/Kolkata');
    return {
        id: row.id,
        code: row.code,
        name: row.name,
        email: row.email,
        phone: row.phone,
        website: row.website ?? '',
        addressLine1: row.address_line1,
        addressLine2: row.address_line2 ?? '',
        city: row.city,
        stateRegion: row.state_region ?? '',
        postalCode: row.postal_code ?? '',
        country: row.country ?? '',
        timezone,
        currency: String(row.currency ?? 'INR').trim(),
        defaultTaxRate: Number(row.default_tax_rate ?? 0),
        taxName: row.tax_name ?? 'GST',
        standardCheckInTime: String(row.standard_check_in_time ?? '14:00').trim(),
        standardCheckOutTime: String(row.standard_check_out_time ?? '11:00').trim(),
        cancellationPolicy: row.cancellation_policy ?? '',
        bookingTerms: row.booking_terms ?? '',
        invoiceSettings,
        isActive: Boolean(row.is_active),
        localToday: getPropertyLocalDate(timezone),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
export function mapUserRow(row) {
    const normalizedRole = String(row.role ?? '')
        .trim()
        .toLowerCase();
    return {
        id: String(row.id),
        email: String(row.email),
        fullName: String(row.full_name),
        role: normalizedRole,
        phone: row.phone ?? '',
        isActive: Boolean(row.is_active),
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
export function mapRoomTypeRow(row) {
    return {
        id: row.id,
        propertyId: row.property_id,
        code: row.code,
        name: row.name,
        description: row.description ?? '',
        baseCapacity: Number(row.base_capacity),
        maxCapacity: Number(row.max_capacity),
        baseRate: Number(row.base_rate),
        amenities: Array.isArray(row.amenities) ? row.amenities : [],
        isActive: Boolean(row.is_active),
        totalRoomsCount: Number(row.total_rooms_count ?? 0),
        activeRoomsCount: Number(row.active_rooms_count ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
export function mapRoomRow(row) {
    const hasOcc = Boolean(row.occ_reservation_id);
    const cleaningInProgress = Boolean(row.housekeeping_status === 'dirty' && row.cleaning_started_at);
    const cleaningStage = getRoomCleaningStage({
        housekeepingStatus: row.housekeeping_status,
        cleaningInProgress,
    });
    return {
        id: row.id,
        propertyId: row.property_id,
        roomTypeId: row.room_type_id,
        roomTypeName: row.room_type_name ?? '',
        roomTypeCode: row.room_type_code ?? '',
        baseCapacity: Number(row.base_capacity ?? 2),
        maxCapacity: Number(row.max_capacity ?? 2),
        baseRate: Number(row.base_rate ?? 0),
        roomNumber: row.room_number,
        floor: row.floor,
        operationalStatus: row.operational_status,
        housekeepingStatus: row.housekeeping_status,
        cleaningInProgress,
        cleaningStage,
        cleaningStartedAt: row.cleaning_started_at
            ? new Date(row.cleaning_started_at).toISOString()
            : null,
        lastCleanedAt: row.last_cleaned_at ? new Date(row.last_cleaned_at).toISOString() : null,
        lastInspectedAt: row.last_inspected_at
            ? new Date(row.last_inspected_at).toISOString()
            : null,
        openTasksCount: Number(row.open_tasks_count ?? 0),
        openMaintenanceCount: Number(row.open_maintenance_count ?? 0),
        activeMaintenanceSummary: row.active_maintenance_summary ?? null,
        notes: row.notes ?? '',
        isActive: Boolean(row.is_active),
        isOccupied: hasOcc,
        currentOccupancy: hasOcc
            ? {
                reservationId: row.occ_reservation_id,
                bookingReference: row.occ_booking_reference,
                guestName: row.occ_guest_name,
                arrivalDate: row.occ_arrival_date,
                departureDate: row.occ_departure_date,
                status: row.occ_status,
            }
            : null,
        ...(row.available_for_dates !== undefined
            ? {
                availableForDates: Boolean(row.available_for_dates),
                conflictingBookingRef: row.conflicting_booking_ref ?? null,
                conflictingMaintenanceTitle: row.conflicting_maintenance_title ?? null,
            }
            : {}),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
export function mapGuestRow(row) {
    return {
        id: row.id,
        propertyId: row.property_id,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: `${row.first_name} ${row.last_name}`.trim(),
        email: row.email ?? '',
        phone: row.phone,
        addressLine1: row.address_line1 ?? '',
        city: row.city ?? '',
        stateRegion: row.state_region ?? '',
        postalCode: row.postal_code ?? '',
        country: row.country ?? '',
        idDocumentType: row.id_document_type ?? '',
        idDocumentNumber: row.id_document_number ?? '',
        vipStatus: Boolean(row.vip_status),
        notes: row.notes ?? '',
        totalReservations: Number(row.total_reservations ?? 0),
        activeStays: Number(row.active_stays ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
export function mapReservationRow(row) {
    const hkStatus = row.room_housekeeping_status ?? null;
    const cleaningInProgress = Boolean(hkStatus === 'dirty' && row.room_cleaning_started_at);
    const roomCleaningStage = hkStatus
        ? getRoomCleaningStage({
            housekeepingStatus: hkStatus,
            cleaningInProgress,
        })
        : null;
    return {
        id: row.id,
        propertyId: row.property_id,
        bookingReference: row.booking_reference,
        guestId: row.guest_id,
        guestName: `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim(),
        guestEmail: row.guest_email ?? '',
        guestPhone: row.guest_phone ?? '',
        roomTypeId: row.room_type_id,
        roomTypeName: row.room_type_name ?? '',
        roomTypeCode: row.room_type_code ?? '',
        roomId: row.room_id ?? null,
        roomNumber: row.room_number ?? null,
        floor: row.room_floor ?? null,
        roomHousekeepingStatus: hkStatus,
        roomOperationalStatus: row.room_operational_status ?? null,
        roomCleaningInProgress: cleaningInProgress,
        roomCleaningStage,
        roomOpenMaintenanceCount: Number(row.room_open_maintenance_count ?? 0),
        roomHasInventoryBlock: Boolean(row.room_has_inventory_block),
        arrivalDate: row.arrival_date,
        departureDate: row.departure_date,
        adults: Number(row.adults),
        children: Number(row.children),
        numGuests: Number(row.num_guests),
        nights: Number(row.nights),
        nightlyRate: Number(row.nightly_rate),
        discountAmount: Number(row.discount_amount),
        taxRate: Number(row.tax_rate),
        taxAmount: Number(row.tax_amount),
        estimatedTotal: Number(row.estimated_total),
        currency: String(row.currency ?? 'INR').trim(),
        source: row.source,
        isWalkIn: Boolean(row.is_walk_in),
        status: row.status,
        specialRequests: row.special_requests ?? '',
        internalNotes: row.internal_notes ?? '',
        cancellationReason: row.cancellation_reason ?? '',
        cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
        checkedInAt: row.checked_in_at ? new Date(row.checked_in_at).toISOString() : null,
        checkedOutAt: row.checked_out_at ? new Date(row.checked_out_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
export function mapReservationHistoryRow(row) {
    return {
        id: row.id,
        reservationId: row.reservation_id,
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status,
        action: row.action,
        note: row.note ?? '',
        metadata: row.metadata ?? {},
        changedByName: row.changed_by_name ?? null,
        changedByRole: row.changed_by_role ?? null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
export function mapStaffOptionRow(row) {
    return {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        role: row.role,
    };
}
export function mapHousekeepingTaskRow(row) {
    const roomHk = row.room_housekeeping_status ?? 'dirty';
    const roomInProg = Boolean(roomHk === 'dirty' && row.room_cleaning_started_at);
    return {
        id: row.id,
        propertyId: row.property_id,
        roomId: row.room_id,
        roomNumber: row.room_number ?? '',
        floor: row.room_floor ?? '',
        roomTypeName: row.room_type_name ?? '',
        roomHousekeepingStatus: roomHk,
        roomOperationalStatus: row.room_operational_status ?? 'available',
        roomCleaningStage: getRoomCleaningStage({
            housekeepingStatus: roomHk,
            cleaningInProgress: roomInProg,
        }),
        roomCleaningInProgress: roomInProg,
        isRoomOccupied: Boolean(row.is_room_occupied),
        reservationId: row.reservation_id ?? null,
        bookingReference: row.booking_reference ?? null,
        assignedTo: row.assigned_to ?? null,
        assignedToName: row.assigned_to_name ?? null,
        assignedToRole: row.assigned_to_role ?? null,
        taskType: row.task_type,
        priority: row.priority,
        status: row.status,
        dueDate: row.scheduled_for,
        notes: row.notes ?? '',
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        startedBy: row.started_by ?? null,
        startedByName: row.started_by_name ?? null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        completedBy: row.completed_by ?? null,
        completedByName: row.completed_by_name ?? null,
        createdBy: row.created_by ?? null,
        createdByName: row.created_by_name ?? null,
        updatedBy: row.updated_by ?? null,
        updatedByName: row.updated_by_name ?? null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
export function mapMaintenanceRequestRow(row) {
    return {
        id: row.id,
        propertyId: row.property_id,
        roomId: row.room_id,
        roomNumber: row.room_number ?? '',
        floor: row.room_floor ?? '',
        roomTypeName: row.room_type_name ?? '',
        roomOperationalStatus: row.room_operational_status ?? 'available',
        roomHousekeepingStatus: row.room_housekeeping_status ?? 'clean',
        isRoomOccupied: Boolean(row.is_room_occupied),
        category: row.category,
        title: row.title,
        description: row.description ?? '',
        priority: row.priority,
        status: row.status,
        operationalImpact: row.operational_impact,
        blocksInventory: Boolean(row.blocks_inventory),
        unavailableFrom: row.unavailable_from ?? null,
        unavailableTo: row.unavailable_to ?? null,
        reportedBy: row.reported_by ?? null,
        reportedByName: row.reported_by_name ?? null,
        assignedTo: row.assigned_to ?? null,
        assignedToName: row.assigned_to_name ?? null,
        assignedToRole: row.assigned_to_role ?? null,
        resolvedBy: row.resolved_by ?? null,
        resolvedByName: row.resolved_by_name ?? null,
        resolutionNotes: row.resolution_notes ?? '',
        reportedAt: new Date(row.reported_at).toISOString(),
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
