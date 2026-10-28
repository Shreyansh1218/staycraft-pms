import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { LoadingState } from './components/ui/Feedback';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { DashboardPage } from './pages/DashboardPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { GuestsPage } from './pages/GuestsPage';
import { HousekeepingPage } from './pages/HousekeepingPage';
import { InventoryPage } from './pages/InventoryPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { GuestFoodMenuPage } from './pages/GuestFoodMenuPage';
import { LoginPage } from './pages/LoginPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ReportsPage } from './pages/ReportsPage';
import { ReservationDetailPage } from './pages/ReservationDetailPage';
import { ReservationsPage } from './pages/ReservationsPage';
import { RestaurantPage } from './pages/RestaurantPage';
import { RoomCalendarPage } from './pages/RoomCalendarPage';
import { RoomsPage } from './pages/RoomsPage';
import { ServicesPage } from './pages/ServicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { StaffPage } from './pages/StaffPage';
import { SuppliersPage } from './pages/SuppliersPage';

function ProtectedShell() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <LoadingState label="Verifying staff session..." />
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <AppShell />;
}

function PmsStaffRoutes() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<ProtectedShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="reservations" element={<ReservationsPage />} />
          <Route path="reservations/:id" element={<ReservationDetailPage />} />
          <Route path="calendar" element={<RoomCalendarPage />} />
          <Route path="rooms" element={<RoomsPage />} />
          <Route path="housekeeping" element={<HousekeepingPage />} />
          <Route path="guests" element={<GuestsPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="restaurant" element={<RestaurantPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="services" element={<ServicesPage />} />
          <Route path="staff" element={<StaffPage />} />
          <Route path="settings" element={<SettingsPage />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/guest/menu/:qrToken" element={<GuestFoodMenuPage />} />
          <Route path="/*" element={<PmsStaffRoutes />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
