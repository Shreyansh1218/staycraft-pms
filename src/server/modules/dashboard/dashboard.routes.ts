import { Router } from 'express';
import { summarizeRoomStatusBuckets } from '../../../shared/constants.js';
import { getPropertyLocalDate } from '../../../shared/dates.js';
import { roundCurrency } from '../../../shared/pricing.js';
import type { DashboardSummary, NotificationItem, Property } from '../../../shared/types.js';
import { getPool } from '../../db/pool.js';
import { requireAuth, requirePropertyContext } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { mapReservationRow } from '../../services/mappers.js';
import { getDashboardFoodOrdersSnapshot } from '../restaurant/restaurant.service.js';
import { listRooms } from '../rooms/rooms.service.js';

const RESERVATION_SELECT = `
  SELECT r.*,
         g.first_name AS guest_first_name,
         g.last_name AS guest_last_name,
         g.email AS guest_email,
         g.phone AS guest_phone,
         rt.name AS room_type_name,
         rt.code AS room_type_code,
         rm.room_number,
         rm.floor AS room_floor,
         rm.housekeeping_status AS room_housekeeping_status,
         rm.operational_status AS room_operational_status,
         rm.cleaning_started_at AS room_cleaning_started_at
  FROM reservations r
  JOIN guests g ON g.id = r.guest_id
  JOIN room_types rt ON rt.id = r.room_type_id
  LEFT JOIN rooms rm ON rm.id = r.room_id
`;

export async function getDashboardSummary(
  property: Property,
  referenceDate: Date = new Date()
): Promise<DashboardSummary> {
  const pool = getPool();
  const propertyToday = getPropertyLocalDate(property.timezone, referenceDate);
  const monthStart = `${propertyToday.slice(0, 7)}-01`;

  const rooms = await listRooms(property.id, { includeInactive: false });

  const totalRooms = rooms.length;
  const sellableRoomsList = rooms.filter(
    (r) => r.operationalStatus === 'available' && r.housekeepingStatus !== 'out_of_service'
  );
  const sellableRooms = sellableRoomsList.length;
  const unavailableOperationalRooms = totalRooms - sellableRooms;
  const occupiedRooms = rooms.filter((r) => r.isOccupied).length;
  const availableRooms = Math.max(0, sellableRooms - occupiedRooms);
  const occupancyPercentage =
    sellableRooms > 0 ? Math.round((occupiedRooms / sellableRooms) * 1000) / 10 : 0;

  const housekeepingCounts = summarizeRoomStatusBuckets(rooms);
  const cleaningInProgressRoomsCount = rooms.filter(
    (r) => r.operationalStatus === 'available' && r.cleaningStage === 'cleaning_in_progress'
  ).length;

  const [
    arrivalsRes,
    departuresRes,
    overdueRes,
    inHouseRes,
    recentRes,
    statsRes,
    opsCountsRes,
    foodSnapshot,
  ] = await Promise.all([
      pool.query(
        `${RESERVATION_SELECT}
         WHERE r.property_id = $1
           AND r.arrival_date = $2::date
           AND r.status IN ('pending', 'confirmed', 'checked_in')
         ORDER BY CASE WHEN r.status = 'checked_in' THEN 1 ELSE 0 END ASC, r.created_at ASC`,
        [property.id, propertyToday]
      ),
      pool.query(
        `${RESERVATION_SELECT}
         WHERE r.property_id = $1
           AND r.departure_date = $2::date
           AND r.status IN ('checked_in', 'checked_out')
         ORDER BY CASE WHEN r.status = 'checked_in' THEN 0 ELSE 1 END ASC, r.created_at ASC`,
        [property.id, propertyToday]
      ),
      pool.query(
        `${RESERVATION_SELECT}
         WHERE r.property_id = $1
           AND r.status = 'checked_in'
           AND r.departure_date < $2::date
         ORDER BY r.departure_date ASC, rm.room_number ASC, r.created_at ASC`,
        [property.id, propertyToday]
      ),
      pool.query(
        `${RESERVATION_SELECT}
         WHERE r.property_id = $1
           AND r.status = 'checked_in'
         ORDER BY r.departure_date ASC, rm.room_number ASC`,
        [property.id]
      ),
      pool.query(
        `${RESERVATION_SELECT}
         WHERE r.property_id = $1
         ORDER BY r.created_at DESC
         LIMIT 8`,
        [property.id]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed', 'checked_in'))::int AS active_bookings_count,
           COALESCE(SUM(num_guests) FILTER (WHERE status = 'checked_in'), 0)::int AS in_house_guests_count,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_confirmation_count,
           COALESCE(
             SUM(
               GREATEST(0, nightly_rate - (discount_amount / GREATEST(1, nights)))
             ) FILTER (
               WHERE status = 'checked_in'
                 AND arrival_date <= $2::date
                 AND departure_date > $2::date
             ),
             0
           ) AS tonight_room_revenue,
           COALESCE(
             SUM(estimated_total) FILTER (
               WHERE status IN ('confirmed', 'checked_in', 'checked_out')
                 AND arrival_date >= $3::date
                 AND arrival_date < ($3::date + INTERVAL '1 month')
             ),
             0
           ) AS month_confirmed_value
         FROM reservations
         WHERE property_id = $1`,
        [property.id, propertyToday, monthStart]
      ),
      pool.query(
        `SELECT
           (
             SELECT COUNT(*)::int FROM housekeeping_tasks ht
             WHERE ht.property_id = $1 AND ht.status IN ('pending', 'in_progress')
           ) AS open_hk_tasks_count,
           (
             SELECT COUNT(*)::int FROM maintenance_requests mr
             WHERE mr.property_id = $1 AND mr.status IN ('open', 'in_progress')
           ) AS open_maint_count,
           (
             SELECT COUNT(*)::int
             FROM reservations r_aff
             JOIN rooms rm_aff ON rm_aff.id = r_aff.room_id
             WHERE r_aff.property_id = $1
               AND r_aff.status IN ('pending', 'confirmed', 'checked_in')
               AND (
                 rm_aff.operational_status != 'available'
                 OR rm_aff.housekeeping_status = 'out_of_service'
                 OR EXISTS (
                   SELECT 1 FROM maintenance_requests mr_aff
                   WHERE mr_aff.room_id = rm_aff.id
                     AND mr_aff.status IN ('open', 'in_progress')
                     AND mr_aff.blocks_inventory = TRUE
                     AND daterange(mr_aff.unavailable_from, COALESCE(mr_aff.unavailable_to, '9999-12-31'::date), '[)')
                         && daterange(r_aff.arrival_date, r_aff.departure_date, '[)')
                 )
               )
           ) AS affected_stays_count`,
        [property.id]
      ),
      getDashboardFoodOrdersSnapshot(property.id),
    ]);

  const todayArrivals = arrivalsRes.rows.map(mapReservationRow);
  const todayDepartures = departuresRes.rows.map(mapReservationRow);
  const overdueCheckOuts = overdueRes.rows.map(mapReservationRow);
  const inHouseStays = inHouseRes.rows.map(mapReservationRow);
  const recentBookings = recentRes.rows.map(mapReservationRow);

  const statsRow = statsRes.rows[0] ?? {};
  const opsCountsRow = opsCountsRes.rows[0] ?? {};
  const openHousekeepingTasksCount = Number(opsCountsRow.open_hk_tasks_count ?? 0);
  const openMaintenanceRequestsCount = Number(opsCountsRow.open_maint_count ?? 0);
  const affectedStaysOnUnavailableRoomsCount = Number(opsCountsRow.affected_stays_count ?? 0);

  const arrivalsPendingCheckIn = todayArrivals.filter((r) => r.status !== 'checked_in').length;
  const arrivalsCheckedIn = todayArrivals.filter((r) => r.status === 'checked_in').length;
  const departuresPendingCheckOut = todayDepartures.filter((r) => r.status === 'checked_in').length;
  const departuresCheckedOut = todayDepartures.filter((r) => r.status === 'checked_out').length;
  const overdueCheckOutsCount = overdueCheckOuts.length;
  const pendingConfirmationCount = Number(statsRow.pending_confirmation_count ?? 0);

  const notifications: NotificationItem[] = [];
  if (overdueCheckOutsCount > 0) {
    notifications.push({
      id: 'overdue-checkouts',
      severity: 'urgent',
      title: `${overdueCheckOutsCount} overdue check-out${overdueCheckOutsCount === 1 ? '' : 's'} past scheduled departure`,
      description: `Checked-in stay${overdueCheckOutsCount === 1 ? '' : 's'} with departure prior to ${propertyToday} (${property.timezone}) require${overdueCheckOutsCount === 1 ? 's' : ''} date update and check-out`,
      href: '/reservations?quickFilter=overdue_checkouts',
    });
  }
  if (affectedStaysOnUnavailableRoomsCount > 0) {
    notifications.push({
      id: 'affected-stays-oos',
      severity: 'urgent',
      title: `${affectedStaysOnUnavailableRoomsCount} reservation${affectedStaysOnUnavailableRoomsCount === 1 ? '' : 's'} assigned to unavailable / maintenance room${affectedStaysOnUnavailableRoomsCount === 1 ? '' : 's'}`,
      description: 'Reassign affected stays or restore room to service before guest check-in',
      href: '/reservations',
    });
  }
  if (arrivalsPendingCheckIn > 0) {
    notifications.push({
      id: 'arrivals-due',
      severity: 'info',
      title: `${arrivalsPendingCheckIn} arrival${arrivalsPendingCheckIn === 1 ? '' : 's'} awaiting check-in today`,
      description: `Scheduled for ${propertyToday} (${property.timezone})`,
      href: '/reservations?quickFilter=arrivals_today',
    });
  }
  if (departuresPendingCheckOut > 0) {
    notifications.push({
      id: 'departures-due',
      severity: 'warning',
      title: `${departuresPendingCheckOut} room${departuresPendingCheckOut === 1 ? '' : 's'} due for check-out today`,
      description: `Scheduled departure today (${propertyToday}) • Standard check-out time is ${property.standardCheckOutTime}`,
      href: '/reservations?quickFilter=departures_today',
    });
  }
  if (housekeepingCounts.dirty > 0) {
    notifications.push({
      id: 'dirty-rooms',
      severity: 'warning',
      title: `${housekeepingCounts.dirty} dirty room${housekeepingCounts.dirty === 1 ? '' : 's'} require housekeeping`,
      description: 'Update room cleaning state in Housekeeping before assigning check-ins',
      href: '/housekeeping?status=dirty',
    });
  }
  if (pendingConfirmationCount > 0) {
    notifications.push({
      id: 'pending-bookings',
      severity: 'info',
      title: `${pendingConfirmationCount} pending reservation${pendingConfirmationCount === 1 ? '' : 's'} awaiting confirmation`,
      description: 'Review and confirm tentative bookings',
      href: '/reservations?status=pending',
    });
  }
  if (housekeepingCounts.out_of_service > 0) {
    notifications.push({
      id: 'oos-rooms',
      severity: 'urgent',
      title: `${housekeepingCounts.out_of_service} room${housekeepingCounts.out_of_service === 1 ? '' : 's'} in maintenance / out of service`,
      description: 'Excluded from sellable room inventory',
      href: '/housekeeping?tab=maintenance',
    });
  }
  if (openMaintenanceRequestsCount > 0 && housekeepingCounts.out_of_service === 0) {
    notifications.push({
      id: 'open-maintenance',
      severity: 'warning',
      title: `${openMaintenanceRequestsCount} open maintenance request${openMaintenanceRequestsCount === 1 ? '' : 's'}`,
      description: 'Review active room repairs and technician assignments',
      href: '/housekeeping?tab=maintenance',
    });
  }

  const lowStockRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active = TRUE AND current_stock <= reorder_level)::int AS low_stock_count,
       COUNT(*) FILTER (WHERE is_active = TRUE AND current_stock <= 0)::int AS out_of_stock_count
     FROM inventory_products
     WHERE property_id = $1`,
    [property.id]
  );
  const lowStockCount = Number(lowStockRes.rows[0]?.low_stock_count ?? 0);
  const outOfStockCount = Number(lowStockRes.rows[0]?.out_of_stock_count ?? 0);

  if (lowStockCount > 0) {
    notifications.push({
      id: 'low-stock-inventory',
      severity: outOfStockCount > 0 ? 'urgent' : 'warning',
      title: `${lowStockCount} inventory item${lowStockCount === 1 ? '' : 's'} at or below reorder threshold`,
      description:
        outOfStockCount > 0
          ? `${outOfStockCount} item${outOfStockCount === 1 ? ' is' : 's are'} completely out of stock — record a replenishment receipt`
          : 'Review low-stock items and record replenishment receipts',
      href: '/inventory?stockFilter=low_stock',
    });
  }

  const { foodOrdersSummary, activeFoodOrders } = foodSnapshot;
  if (foodOrdersSummary.pendingCount > 0 || foodOrdersSummary.readyCount > 0) {
    const pendingParts: string[] = [];
    if (foodOrdersSummary.pendingCount > 0) {
      pendingParts.push(
        `${foodOrdersSummary.pendingCount} pending prep${
          foodOrdersSummary.activeGuestQrCount > 0
            ? ` (${foodOrdersSummary.activeGuestQrCount} Guest QR)`
            : ''
        }`
      );
    }
    if (foodOrdersSummary.readyCount > 0) {
      pendingParts.push(`${foodOrdersSummary.readyCount} ready for delivery`);
    }

    notifications.push({
      id: 'active-food-orders',
      severity:
        foodOrdersSummary.activeGuestQrCount > 0 || foodOrdersSummary.pendingCount > 0
          ? 'warning'
          : 'info',
      title: `Food & Room Service: ${pendingParts.join(' • ')}`,
      description: 'Open Kitchen & POS board to prepare and deliver guest orders',
      href: '/restaurant?tab=kitchen',
    });
  }

  return {
    property: {
      ...property,
      localToday: propertyToday,
    },
    propertyToday,
    metrics: {
      totalRooms,
      sellableRooms,
      occupiedRooms,
      availableRooms,
      unavailableOperationalRooms,
      occupancyPercentage,
      arrivalsTodayTotal: todayArrivals.length,
      arrivalsPendingCheckIn,
      arrivalsCheckedIn,
      departuresTodayTotal: todayDepartures.length,
      departuresPendingCheckOut,
      departuresCheckedOut,
      overdueCheckOutsCount,
      activeBookingsCount: Number(statsRow.active_bookings_count ?? 0),
      inHouseGuestsCount: Number(statsRow.in_house_guests_count ?? 0),
      tonightInHouseRoomRevenue: roundCurrency(Number(statsRow.tonight_room_revenue ?? 0)),
      currentMonthConfirmedBookingValue: roundCurrency(Number(statsRow.month_confirmed_value ?? 0)),
      cleaningInProgressRoomsCount,
      openHousekeepingTasksCount,
      openMaintenanceRequestsCount,
      affectedStaysOnUnavailableRoomsCount,
    },
    housekeepingCounts,
    foodOrdersSummary,
    activeFoodOrders,
    todayArrivals,
    todayDepartures,
    overdueCheckOuts,
    inHouseStays,
    recentBookings,
    roomRack: rooms,
    notifications,
  };
}

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth, requirePropertyContext);

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const summary = await getDashboardSummary(req.property!);
    res.json(summary);
  })
);
