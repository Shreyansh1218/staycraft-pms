import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  LayoutGrid,
  List,
  Plus,
  Search,
  Wrench,
} from 'lucide-react';
import { addDays, diffDays, formatDisplayDate, isValidIsoDate, rangesOverlap } from '@shared/dates';
import type {
  CalendarMaintenanceBlock,
  ReservationListItem,
  Room,
  RoomCalendarPayload,
  RoomType,
} from '@shared/types';
import { ReservationFormModal } from '../components/reservations/ReservationFormModal';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  HousekeepingBadge,
  OperationalBadge,
  ReservationStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

function formatShortHeaderDate(isoDate: string): { weekday: string; dayMonth: string } {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(dt);
  const dayMonth = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(dt);
  return { weekday, dayMonth };
}

type CellSegment =
  | {
      kind: 'reservation';
      colSpan: number;
      reservation: ReservationListItem;
      clippedLeft: boolean;
      clippedRight: boolean;
    }
  | {
      kind: 'maintenance';
      colSpan: number;
      block: CalendarMaintenanceBlock;
    }
  | {
      kind: 'empty';
      date: string;
      canBook: boolean;
      unavailableReason?: string;
    };

function buildRoomRowSegments(
  room: Room,
  dates: string[],
  windowStart: string,
  windowEnd: string,
  propertyToday: string,
  roomReservations: ReservationListItem[],
  roomMaintBlocks: CalendarMaintenanceBlock[]
): CellSegment[] {
  // Prioritize active reservations ('checked_in', 'confirmed', 'pending') over 'checked_out'
  const sortedRes = [...roomReservations].sort((a, b) => {
    const rank = (s: string) =>
      s === 'checked_in' ? 0 : s === 'confirmed' ? 1 : s === 'pending' ? 2 : 3;
    const diff = rank(a.status) - rank(b.status);
    return diff !== 0 ? diff : a.arrivalDate.localeCompare(b.arrivalDate);
  });

  const segments: CellSegment[] = [];
  let idx = 0;

  while (idx < dates.length) {
    const colDate = dates[idx];
    const nextColDate = addDays(colDate, 1);

    // 1. Check active reservation starting at colDate (or clipped at windowStart when idx === 0)
    const activeMatch = sortedRes.find(
      (r) =>
        r.status !== 'checked_out' &&
        rangesOverlap(r.arrivalDate, r.departureDate, colDate, nextColDate)
    );

    // Or checked_out reservation if no active reservation overlaps this night
    const matchRes =
      activeMatch ??
      sortedRes.find(
        (r) =>
          r.status === 'checked_out' &&
          rangesOverlap(r.arrivalDate, r.departureDate, colDate, nextColDate)
      );

    if (matchRes) {
      const visEnd = matchRes.departureDate < windowEnd ? matchRes.departureDate : windowEnd;
      let span = Math.max(1, diffDays(colDate, visEnd));
      // If matchRes is 'checked_out', cap span if an active booking starts earlier within [colDate, visEnd)
      if (matchRes.status === 'checked_out') {
        for (let step = 1; step < span; step++) {
          const probe = addDays(colDate, step);
          const hasHigher = sortedRes.some(
            (r) =>
              r.status !== 'checked_out' &&
              rangesOverlap(r.arrivalDate, r.departureDate, probe, addDays(probe, 1))
          );
          if (hasHigher) {
            span = step;
            break;
          }
        }
      }
      segments.push({
        kind: 'reservation',
        colSpan: Math.min(span, dates.length - idx),
        reservation: matchRes,
        clippedLeft: matchRes.arrivalDate < windowStart && idx === 0,
        clippedRight: matchRes.departureDate > windowEnd,
      });
      idx += Math.min(span, dates.length - idx);
      continue;
    }

    // 2. Check active maintenance block covering colDate
    const maintMatch = roomMaintBlocks.find((mb) =>
      rangesOverlap(
        mb.unavailableFrom,
        mb.unavailableTo ?? '9999-12-31',
        colDate,
        nextColDate
      )
    );

    if (maintMatch) {
      const rawEnd = maintMatch.unavailableTo ?? windowEnd;
      const visEnd = rawEnd < windowEnd ? rawEnd : windowEnd;
      let span = Math.max(1, diffDays(colDate, visEnd));
      // Stop span if a reservation starts inside this range so existing affected stays remain visible!
      for (let step = 1; step < span; step++) {
        const probe = addDays(colDate, step);
        const hasRes = sortedRes.some((r) =>
          rangesOverlap(r.arrivalDate, r.departureDate, probe, addDays(probe, 1))
        );
        if (hasRes) {
          span = step;
          break;
        }
      }
      segments.push({
        kind: 'maintenance',
        colSpan: Math.min(span, dates.length - idx),
        block: maintMatch,
      });
      idx += Math.min(span, dates.length - idx);
      continue;
    }

    // 3. Empty night cell
    const roomUnavailable =
      !room.isActive ||
      room.operationalStatus !== 'available' ||
      room.housekeepingStatus === 'out_of_service';
    const isPast = colDate < propertyToday;

    segments.push({
      kind: 'empty',
      date: colDate,
      canBook: !isPast && !roomUnavailable,
      unavailableReason: roomUnavailable
        ? `Unavailable (${room.operationalStatus.replace(/_/g, ' ')})`
        : isPast
          ? 'Past date'
          : undefined,
    });
    idx += 1;
  }

  return segments;
}

export function RoomCalendarPage() {
  const { selectedProperty } = useAuth();

  const [startDate, setStartDate] = useState<string>('');
  const [days, setDays] = useState<number>(14);
  const [roomTypeFilter, setRoomTypeFilter] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [includeCheckedOut, setIncludeCheckedOut] = useState<boolean>(true);
  const [viewMode, setViewMode] = useState<'grid' | 'agenda'>('grid');

  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [calendar, setCalendar] = useState<RoomCalendarPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Quick-create reservation modal state for a clicked room/date cell
  const [bookingSeed, setBookingSeed] = useState<{
    roomId?: string;
    arrivalDate?: string;
    departureDate?: string;
  } | null>(null);

  useEffect(() => {
    if (selectedProperty) {
      setStartDate(selectedProperty.localToday);
    }
  }, [selectedProperty?.id]);

  useEffect(() => {
    if (!selectedProperty) return;
    apiFetch<{ items: RoomType[] }>('/api/room-types', {
      propertyId: selectedProperty.id,
    })
      .then((res) => setRoomTypes(res.items))
      .catch(() => setRoomTypes([]));
  }, [selectedProperty?.id]);

  const loadCalendar = useCallback(async () => {
    if (!selectedProperty) return;
    const effectiveStart =
      startDate && isValidIsoDate(startDate) ? startDate : selectedProperty.localToday;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        startDate: effectiveStart,
        days: String(days),
        includeCheckedOut: includeCheckedOut ? 'true' : 'false',
      });
      if (roomTypeFilter) params.set('roomTypeId', roomTypeFilter);
      if (search.trim()) params.set('search', search.trim());

      const res = await apiFetch<RoomCalendarPayload>(
        `/api/reservations/calendar?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setCalendar(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load room calendar');
    } finally {
      setLoading(false);
    }
  }, [selectedProperty?.id, startDate, days, roomTypeFilter, search, includeCheckedOut]);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);

  const reservationsByRoom = useMemo(() => {
    const map = new Map<string, ReservationListItem[]>();
    if (!calendar) return map;
    for (const r of calendar.reservations) {
      if (!r.roomId) continue;
      const list = map.get(r.roomId) ?? [];
      list.push(r);
      map.set(r.roomId, list);
    }
    return map;
  }, [calendar]);

  const maintByRoom = useMemo(() => {
    const map = new Map<string, CalendarMaintenanceBlock[]>();
    if (!calendar) return map;
    for (const m of calendar.maintenanceBlocks) {
      const list = map.get(m.roomId) ?? [];
      list.push(m);
      map.set(m.roomId, list);
    }
    return map;
  }, [calendar]);

  const openBookForCell = (room: Room, cellDate: string) => {
    const roomRes = reservationsByRoom.get(room.id) ?? [];
    const roomMaint = maintByRoom.get(room.id) ?? [];
    const candidate2Night = addDays(cellDate, 2);
    const twoNightFree =
      !roomRes.some(
        (r) =>
          r.status !== 'checked_out' &&
          rangesOverlap(r.arrivalDate, r.departureDate, cellDate, candidate2Night)
      ) &&
      !roomMaint.some((m) =>
        rangesOverlap(m.unavailableFrom, m.unavailableTo ?? '9999-12-31', cellDate, candidate2Night)
      );

    setBookingSeed({
      roomId: room.id,
      arrivalDate: cellDate,
      departureDate: twoNightFree ? candidate2Night : addDays(cellDate, 1),
    });
  };

  if (!selectedProperty) return null;

  const effectiveStart =
    startDate && isValidIsoDate(startDate) ? startDate : selectedProperty.localToday;

  const statusBarStyles: Record<string, string> = {
    checked_in: 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700',
    confirmed: 'bg-indigo-600 text-white border-indigo-700 hover:bg-indigo-700',
    pending: 'bg-amber-500 text-slate-950 border-amber-600 hover:bg-amber-600',
    checked_out: 'bg-slate-200 text-slate-700 border-slate-300 hover:bg-slate-300',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-indigo-600 mb-1">
            <Clock className="h-3.5 w-3.5" />
            <span>
              Property Today: {formatDisplayDate(selectedProperty.localToday)} (
              {selectedProperty.timezone})
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-indigo-600" />
            Room-by-Date Reservation Calendar
          </h1>
          <p className="text-sm text-slate-500">
            Interactive room rack across dates (arrival inclusive, departure exclusive). Click any
            available cell from today onward to create a booking.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                viewMode === 'grid'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Tape Chart
            </button>
            <button
              type="button"
              onClick={() => setViewMode('agenda')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                viewMode === 'agenda'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              Mobile / Room List
            </button>
          </div>

          <button
            type="button"
            onClick={() => setBookingSeed({})}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            New Reservation
          </button>
        </div>
      </div>

      {/* Navigation & Filter Toolbar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Date Navigation */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous date range"
              onClick={() => setStartDate(addDays(effectiveStart, -days))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> -{days}d
            </button>
            <button
              type="button"
              aria-label="Previous day"
              onClick={() => setStartDate(addDays(effectiveStart, -1))}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              -1d
            </button>
            <button
              type="button"
              onClick={() => setStartDate(selectedProperty.localToday)}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Next day"
              onClick={() => setStartDate(addDays(effectiveStart, 1))}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              +1d
            </button>
            <button
              type="button"
              aria-label="Next date range"
              onClick={() => setStartDate(addDays(effectiveStart, days))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              +{days}d <ChevronRight className="h-3.5 w-3.5" />
            </button>

            <div className="flex items-center gap-1.5 ml-1">
              <label htmlFor="cal-start-date" className="text-xs font-medium text-slate-500">
                From:
              </label>
              <input
                id="cal-start-date"
                type="date"
                value={effectiveStart}
                onChange={(e) => {
                  if (isValidIsoDate(e.target.value)) setStartDate(e.target.value);
                }}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-800"
              />
            </div>
          </div>

          {/* Window Size */}
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {[7, 14, 21].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                  days === d
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {d} Nights
              </button>
            ))}
          </div>
        </div>

        {/* Filters & Legend */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative min-w-[200px]">
              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search calendar rooms"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter room #, category..."
                className="w-full rounded-lg border border-slate-300 pl-8 pr-3 py-1.5 text-xs"
              />
            </div>

            <select
              aria-label="Filter calendar by category"
              value={roomTypeFilter}
              onChange={(e) => setRoomTypeFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
            >
              <option value="">All Categories</option>
              {roomTypes.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.name} ({rt.code})
                </option>
              ))}
            </select>

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={includeCheckedOut}
                onChange={(e) => setIncludeCheckedOut(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              Show Checked-Out Stays
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-emerald-600" /> Checked In
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-indigo-600" /> Confirmed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-amber-500" /> Pending
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-slate-300" /> Checked Out
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-rose-200 border border-rose-400" /> Maint / OOS
            </span>
          </div>
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={loadCalendar} />}

      {loading && !calendar ? (
        <LoadingState label="Loading room-by-date reservation rack..." />
      ) : !calendar || calendar.rooms.length === 0 ? (
        <EmptyState
          title="No rooms match selected filter"
          description="Clear room filters or add active rooms in Room Inventory."
        />
      ) : viewMode === 'grid' ? (
        /* Tape Chart Grid (Rooms as Rows x Dates as Columns) */
        <div
          className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden"
          data-testid="room-calendar-grid"
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="sticky left-0 z-20 bg-slate-50 border-r border-slate-200 px-3.5 py-2.5 text-left font-bold text-slate-700 min-w-[190px]">
                    Room &amp; Cleanliness
                  </th>
                  {calendar.dates.map((dt) => {
                    const { weekday, dayMonth } = formatShortHeaderDate(dt);
                    const isToday = dt === calendar.propertyToday;
                    return (
                      <th
                        key={dt}
                        data-calendar-date={dt}
                        className={`border-r border-slate-200 px-2 py-2 text-center min-w-[92px] ${
                          isToday ? 'bg-indigo-50 text-indigo-900' : 'text-slate-600'
                        }`}
                      >
                        <span className="block text-[10px] uppercase tracking-wider font-semibold opacity-75">
                          {weekday}
                        </span>
                        <span className="block text-xs font-bold mt-0.5">{dayMonth}</span>
                        {isToday && (
                          <span className="inline-block mt-0.5 rounded bg-indigo-600 px-1.5 py-0.2 text-[9px] font-bold text-white">
                            TODAY
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {calendar.rooms.map((room) => {
                  const roomRes = reservationsByRoom.get(room.id) ?? [];
                  const roomMaint = maintByRoom.get(room.id) ?? [];
                  const segments = buildRoomRowSegments(
                    room,
                    calendar.dates,
                    calendar.startDate,
                    calendar.endDate,
                    calendar.propertyToday,
                    roomRes,
                    roomMaint
                  );
                  const isOos =
                    room.operationalStatus !== 'available' ||
                    room.housekeepingStatus === 'out_of_service';

                  return (
                    <tr
                      key={room.id}
                      data-room-number={room.roomNumber}
                      className={isOos ? 'bg-rose-50/20' : 'hover:bg-slate-50/40'}
                    >
                      {/* Sticky Left Room Column */}
                      <td className="sticky left-0 z-10 bg-white border-r border-slate-200 px-3.5 py-2.5 align-middle">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-slate-900 text-sm">
                            Room {room.roomNumber}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-600">
                            {room.roomTypeCode}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <HousekeepingBadge
                            status={room.housekeepingStatus}
                            cleaningInProgress={room.cleaningInProgress}
                          />
                          {room.operationalStatus !== 'available' && (
                            <OperationalBadge status={room.operationalStatus} />
                          )}
                        </div>
                      </td>

                      {/* Date Cells / Spanning Stays */}
                      {segments.map((seg, sIdx) => {
                        if (seg.kind === 'reservation') {
                          const r = seg.reservation;
                          const barClass =
                            statusBarStyles[r.status] ?? statusBarStyles.confirmed;
                          return (
                            <td
                              key={`res-${r.id}-${sIdx}`}
                              colSpan={seg.colSpan}
                              className="border-r border-slate-200 p-1 align-middle"
                            >
                              <Link
                                to={`/reservations/${r.id}`}
                                title={`${r.bookingReference} • ${r.guestName} (${r.arrivalDate} → ${r.departureDate}, ${r.status})`}
                                className={`block rounded-lg border px-2.5 py-1.5 shadow-2xs transition-colors truncate ${barClass}`}
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <span className="font-bold truncate">
                                    {seg.clippedLeft ? '◀ ' : ''}
                                    {r.guestName}
                                  </span>
                                  <span className="text-[10px] font-mono opacity-90 shrink-0">
                                    {r.nights}n{seg.clippedRight ? ' ▶' : ''}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-1 text-[10px] opacity-90 truncate mt-0.5">
                                  <span className="font-mono truncate">{r.bookingReference}</span>
                                  <span className="capitalize shrink-0">
                                    {r.status.replace('_', ' ')}
                                  </span>
                                </div>
                              </Link>
                            </td>
                          );
                        }

                        if (seg.kind === 'maintenance') {
                          return (
                            <td
                              key={`maint-${seg.block.id}-${sIdx}`}
                              colSpan={seg.colSpan}
                              className="border-r border-slate-200 p-1 align-middle bg-rose-50/50"
                            >
                              <Link
                                to="/housekeeping?tab=maintenance"
                                title={`Unavailable (${seg.block.operationalImpact}): ${seg.block.title}`}
                                className="flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-100/90 px-2.5 py-1.5 text-rose-900 font-semibold truncate hover:bg-rose-200/80"
                              >
                                <Wrench className="h-3.5 w-3.5 text-rose-700 shrink-0" />
                                <span className="truncate">{seg.block.title}</span>
                              </Link>
                            </td>
                          );
                        }

                        const isToday = seg.date === calendar.propertyToday;
                        return (
                          <td
                            key={`empty-${room.id}-${seg.date}`}
                            data-cell-room={room.roomNumber}
                            data-cell-date={seg.date}
                            className={`border-r border-slate-100 p-1 align-middle text-center ${
                              isToday ? 'bg-indigo-50/30' : ''
                            } ${!seg.canBook ? 'bg-slate-50/80' : ''}`}
                          >
                            {seg.canBook ? (
                              <button
                                type="button"
                                aria-label={`Book Room ${room.roomNumber} from ${seg.date}`}
                                onClick={() => openBookForCell(room, seg.date)}
                                className="group w-full h-11 rounded-lg border border-transparent hover:border-indigo-300 hover:bg-indigo-50/80 flex items-center justify-center text-transparent hover:text-indigo-700 font-semibold transition-all"
                              >
                                <Plus className="h-3.5 w-3.5 mr-0.5" />
                                Book
                              </button>
                            ) : (
                              <div
                                title={seg.unavailableReason}
                                className="w-full h-11 flex items-center justify-center text-[10px] text-slate-400 select-none"
                              >
                                {isOos ? 'OOS' : '—'}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Compact Mobile / Room Schedule Cards View */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="room-calendar-agenda">
          {calendar.rooms.map((room) => {
            const roomRes = reservationsByRoom.get(room.id) ?? [];
            const roomMaint = maintByRoom.get(room.id) ?? [];
            const canBookToday =
              room.isActive &&
              room.operationalStatus === 'available' &&
              room.housekeepingStatus !== 'out_of_service';

            return (
              <div
                key={room.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">
                      Room {room.roomNumber}{' '}
                      <span className="text-xs font-normal text-slate-500">
                        • {room.roomTypeName} (Floor {room.floor})
                      </span>
                    </h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <OperationalBadge status={room.operationalStatus} isActive={room.isActive} />
                      <HousekeepingBadge
                        status={room.housekeepingStatus}
                        cleaningInProgress={room.cleaningInProgress}
                      />
                    </div>
                  </div>
                  {canBookToday && (
                    <button
                      type="button"
                      onClick={() =>
                        openBookForCell(
                          room,
                          effectiveStart >= calendar.propertyToday
                            ? effectiveStart
                            : calendar.propertyToday
                        )
                      }
                      className="rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                    >
                      + Book Room
                    </button>
                  )}
                </div>

                {roomMaint.length > 0 && (
                  <div className="space-y-1.5">
                    {roomMaint.map((m) => (
                      <div
                        key={m.id}
                        className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 flex items-center justify-between gap-2"
                      >
                        <span className="font-semibold">
                          Maint/OOS: {m.title} ({m.unavailableFrom} →{' '}
                          {m.unavailableTo ?? 'Until Restored'})
                        </span>
                        <Link
                          to="/housekeeping?tab=maintenance"
                          className="text-rose-700 font-semibold hover:underline shrink-0"
                        >
                          Manage
                        </Link>
                      </div>
                    ))}
                  </div>
                )}

                {roomRes.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2 border-t border-slate-100">
                    No reservations in {formatDisplayDate(calendar.startDate)} –{' '}
                    {formatDisplayDate(calendar.endDate)}.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2">
                    {roomRes.map((r) => (
                      <div
                        key={r.id}
                        className="py-2 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <Link
                            to={`/reservations/${r.id}`}
                            className="font-semibold text-slate-900 hover:text-indigo-600 truncate block"
                          >
                            {r.guestName} ({r.bookingReference})
                          </Link>
                          <span className="text-slate-500">
                            {formatDisplayDate(r.arrivalDate)} →{' '}
                            {formatDisplayDate(r.departureDate)} ({r.nights}n)
                          </span>
                        </div>
                        <ReservationStatusBadge status={r.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Safe Create Reservation Modal pre-filled with selected room & dates */}
      <ReservationFormModal
        open={bookingSeed !== null}
        onClose={() => setBookingSeed(null)}
        mode="create"
        initialRoomId={bookingSeed?.roomId}
        initialArrivalDate={bookingSeed?.arrivalDate}
        initialDepartureDate={bookingSeed?.departureDate}
        onSaved={() => {
          setBookingSeed(null);
          void loadCalendar();
        }}
      />
    </div>
  );
}
