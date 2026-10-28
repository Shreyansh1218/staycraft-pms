import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarCheck2,
  CalendarRange,
  BedDouble,
  Sparkles,
  Users,
  Receipt,
  UtensilsCrossed,
  ConciergeBell,
  Wallet,
  Package,
  Truck,
  BarChart3,
  UserCog,
  KeyRound,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  Bell,
  Building2,
  ChevronDown,
  LogOut,
  Plus,
  Clock,
} from 'lucide-react';
import type { DashboardSummary, NotificationItem } from '@shared/types';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../lib/api';
import { RoleBadge } from '../ui/StatusBadge';

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  phase2?: boolean;
}

const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Front Office',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard },
      { label: 'Reservations', to: '/reservations', icon: CalendarCheck2 },
      { label: 'Room Calendar', to: '/calendar', icon: CalendarRange },
      { label: 'Rooms & Rates', to: '/rooms', icon: BedDouble },
      { label: 'Housekeeping', to: '/housekeeping', icon: Sparkles },
      { label: 'Guest CRM', to: '/guests', icon: Users },
    ],
  },
  {
    heading: 'Billing & Operations',
    items: [
      { label: 'Invoices', to: '/invoices', icon: Receipt },
      { label: 'Restaurant & POS', to: '/restaurant', icon: UtensilsCrossed },
      { label: 'Services', to: '/services', icon: ConciergeBell },
      { label: 'Expenses', to: '/expenses', icon: Wallet },
      { label: 'Inventory', to: '/inventory', icon: Package },
      { label: 'Suppliers', to: '/suppliers', icon: Truck },
      { label: 'Reports', to: '/reports', icon: BarChart3 },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { label: 'Staff & Users', to: '/staff', icon: UserCog },
      { label: 'Settings', to: '/settings', icon: Settings },
    ],
  },
];

export function AppShell() {
  const { user, properties, selectedProperty, selectProperty, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const location = useLocation();
  const navigate = useNavigate();
  const notifRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, location.search]);

  // Fetch live operational notifications whenever property or route changes
  useEffect(() => {
    if (!selectedProperty) return;
    let active = true;
    apiFetch<DashboardSummary>('/api/dashboard', { propertyId: selectedProperty.id })
      .then((res) => {
        if (active) setNotifications(res.notifications ?? []);
      })
      .catch(() => {
        if (active) setNotifications([]);
      });
    return () => {
      active = false;
    };
  }, [selectedProperty?.id, location.pathname]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const renderSidebarContent = (isMobile = false) => {
    const isNarrow = !isMobile && collapsed;
    return (
      <div className="flex h-full flex-col bg-slate-950 text-slate-200 select-none">
        {/* Brand header */}
        <div className="flex h-16 items-center justify-between px-4 border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-teal-400 text-white shadow-md font-bold text-base">
              SC
            </div>
            {!isNarrow && (
              <div className="truncate">
                <span className="block text-sm font-bold tracking-tight text-white">
                  StayCraft PMS
                </span>
                <span className="block text-[11px] text-slate-400 truncate">
                  Hospitality Operations
                </span>
              </div>
            )}
          </div>
          {isMobile && (
            <button
              type="button"
              aria-label="Close navigation menu"
              onClick={() => setMobileOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6" aria-label="Main navigation">
          {NAV_GROUPS.map((group) => (
            <div key={group.heading}>
              {!isNarrow && (
                <p className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {group.heading}
                </p>
              )}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.to === '/'}
                        title={isNarrow ? item.label : undefined}
                        className={({ isActive }) =>
                          `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                            isActive
                              ? 'bg-indigo-600 text-white shadow-sm'
                              : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                          } ${isNarrow ? 'justify-center' : ''}`
                        }
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isNarrow && (
                          <span className="flex-1 truncate">{item.label}</span>
                        )}
                        {!isNarrow && item.phase2 && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 group-hover:bg-slate-700 group-hover:text-slate-200">
                            Ph.2
                          </span>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Desktop Collapse Footer */}
        {!isMobile && (
          <div className="border-t border-slate-800/80 p-3 shrink-0">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-900 hover:text-white transition-colors"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <>
                  <PanelLeftClose className="h-4 w-4" />
                  <span>Collapse Sidebar</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50">
      {/* Desktop Sidebar */}
      <aside
        className={`hidden lg:block shrink-0 transition-all duration-200 border-r border-slate-800 ${
          collapsed ? 'w-20' : 'w-64'
        }`}
      >
        {renderSidebarContent(false)}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] h-full shadow-2xl">
            {renderSidebarContent(true)}
          </aside>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top Navigation Bar */}
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:px-6 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Property Selector */}
            {selectedProperty && (
              <div className="flex items-center gap-2 min-w-0">
                <div className="hidden sm:flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 shrink-0">
                  <Building2 className="h-4 w-4" />
                </div>
                {properties.length > 1 ? (
                  <div className="relative">
                    <label htmlFor="property-selector" className="sr-only">
                      Select active property
                    </label>
                    <select
                      id="property-selector"
                      value={selectedProperty.id}
                      onChange={(e) => selectProperty(e.target.value)}
                      className="appearance-none rounded-lg border border-slate-200 bg-slate-50/70 pl-3 pr-8 py-1.5 text-sm font-semibold text-slate-900 hover:border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 max-w-[220px] sm:max-w-xs truncate"
                    >
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.code})
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  </div>
                ) : (
                  <div className="truncate">
                    <span className="text-sm font-semibold text-slate-900 truncate">
                      {selectedProperty.name}
                    </span>
                    <span className="ml-2 hidden md:inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                      {selectedProperty.code}
                    </span>
                  </div>
                )}

                <div
                  title="Property configured date & timezone"
                  className="hidden xl:flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 ml-2"
                >
                  <Clock className="h-3.5 w-3.5 text-indigo-600" />
                  <span>{selectedProperty.localToday}</span>
                  <span className="text-slate-300">•</span>
                  <span>{selectedProperty.timezone}</span>
                </div>
              </div>
            )}
          </div>

          {/* Right Header Controls */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => navigate('/reservations?new=1')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Booking</span>
            </button>

            {/* Notifications Dropdown */}
            <div className="relative" ref={notifRef}>
              <button
                type="button"
                aria-label="Operational notifications"
                onClick={() => setNotifOpen((o) => !o)}
                className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <Bell className="h-5 w-5" />
                {notifications.length > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">
                    {notifications.length}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border border-slate-200 bg-white shadow-xl z-40 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                    <span className="text-sm font-semibold text-slate-900">
                      Front Desk Alerts
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      {notifications.length} active
                    </span>
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                    {notifications.length === 0 ? (
                      <div className="px-4 py-8 text-center text-xs text-slate-500">
                        All caught up — no pending operational alerts right now.
                      </div>
                    ) : (
                      notifications.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            setNotifOpen(false);
                            navigate(n.href);
                          }}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-start gap-3"
                        >
                          <span
                            className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                              n.severity === 'urgent'
                                ? 'bg-rose-500'
                                : n.severity === 'warning'
                                  ? 'bg-amber-500'
                                  : 'bg-indigo-500'
                            }`}
                          />
                          <div>
                            <p className="text-xs font-semibold text-slate-900">{n.title}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{n.description}</p>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* User Profile Menu */}
            {user && (
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  aria-label="User account menu"
                  onClick={() => setUserMenuOpen((o) => !o)}
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                    {user.fullName
                      .split(' ')
                      .map((p) => p[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div className="hidden md:block text-left">
                    <p className="text-xs font-semibold text-slate-900 leading-none">
                      {user.fullName}
                    </p>
                    <p className="text-[11px] text-slate-500 capitalize mt-0.5">{user.role}</p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                </button>

                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-slate-200 bg-white shadow-xl z-40 overflow-hidden">
                    <div className="border-b border-slate-100 px-4 py-3 space-y-1.5">
                      <p className="text-sm font-semibold text-slate-900">{user.fullName}</p>
                      <p className="text-xs text-slate-500 truncate">{user.email}</p>
                      <div>
                        <RoleBadge role={user.role} />
                      </div>
                    </div>
                    <div className="p-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setUserMenuOpen(false);
                          navigate('/settings?section=account');
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <KeyRound className="h-4 w-4 text-slate-400" />
                        Account & Security
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setUserMenuOpen(false);
                          navigate('/settings');
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Settings className="h-4 w-4 text-slate-400" />
                        Property Settings
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setUserMenuOpen(false);
                          void logout();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50"
                      >
                        <LogOut className="h-4 w-4" />
                        Sign Out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Page Main Viewport */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
