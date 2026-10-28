import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AuthSessionPayload, Property, UserSummary } from '@shared/types';
import {
  ApiClientError,
  SESSION_STORAGE_TOKEN_KEY,
  apiFetch,
  enableRpcTransport,
  getStoredPropertyId,
  setStoredAuthUserId,
  setStoredPropertyId,
  setStoredSessionToken,
  setUnauthorizedHandler,
  syncSessionTokenFromStorage,
} from '../lib/api';

interface AuthContextValue {
  user: UserSummary | null;
  properties: Property[];
  selectedProperty: Property | null;
  isLoading: boolean;
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectProperty: (propertyId: string) => void;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  // Monotonic epoch prevents an older in-flight /api/auth/me response from overwriting
  // a newer login() or logout() state transition.
  const authEpochRef = useRef(0);

  const clearClientAuthState = useCallback(() => {
    setStoredSessionToken(null);
    setStoredAuthUserId(null);
    setUser(null);
    setProperties([]);
    setSelectedPropertyId('');
  }, []);

  const applySessionPayload = useCallback((payload: AuthSessionPayload) => {
    if (payload.sessionToken) {
      setStoredSessionToken(payload.sessionToken);
    }
    setStoredAuthUserId(payload.user.id);
    setSessionNotice(null);
    setUser(payload.user);
    setProperties(payload.properties);

    const savedId = getStoredPropertyId();
    const validSaved = payload.properties.find((p) => p.id === savedId);
    const chosenId = validSaved?.id ?? payload.defaultPropertyId ?? payload.properties[0]?.id ?? '';
    setSelectedPropertyId(chosenId);
    setStoredPropertyId(chosenId);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler((message: string, code: string) => {
      authEpochRef.current += 1;
      clearClientAuthState();
      setIsLoading(false);
      if (code === 'SESSION_EXPIRED' || code === 'SESSION_MISMATCH') {
        setSessionNotice(message || 'Your session has expired. Please sign in again.');
      } else {
        setSessionNotice('Your session is no longer active. Please sign in to continue.');
      }
    });
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [clearClientAuthState]);

  const refreshSession = useCallback(async () => {
    const epoch = ++authEpochRef.current;
    try {
      const payload = await apiFetch<AuthSessionPayload>('/api/auth/me', {
        skipUnauthorizedHandling: true,
      });
      if (authEpochRef.current === epoch) {
        applySessionPayload(payload);
      }
    } catch {
      if (authEpochRef.current === epoch) {
        clearClientAuthState();
      }
    } finally {
      if (authEpochRef.current === epoch) {
        setIsLoading(false);
      }
    }
  }, [applySessionPayload, clearClientAuthState]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Keep open tabs synchronized when another tab logs out or switches accounts
  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_TOKEN_KEY) return;
      syncSessionTokenFromStorage(event.newValue);
      if (!event.newValue) {
        authEpochRef.current += 1;
        clearClientAuthState();
        setIsLoading(false);
        setSessionNotice('Your session was signed out in another tab. Please sign in again.');
        return;
      }
      void refreshSession();
    };
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [clearClientAuthState, refreshSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const epoch = ++authEpochRef.current;
      setSessionNotice(null);
      setStoredSessionToken(null);
      setStoredAuthUserId(null);

      const loginPayload = await apiFetch<AuthSessionPayload>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
        skipUnauthorizedHandling: true,
      });

      if (loginPayload.sessionToken) {
        setStoredSessionToken(loginPayload.sessionToken);
      }
      setStoredAuthUserId(loginPayload.user.id);

      // Immediately verify that the established session is recognized by the backend
      // before transitioning the UI into an authenticated state.
      try {
        let verifiedPayload = await apiFetch<AuthSessionPayload>('/api/auth/me', {
          skipUnauthorizedHandling: true,
        });

        // If an intermediate preview proxy stripped our custom auth headers and Set-Cookie
        // while forwarding a stale browser cookie belonging to another account (e.g. Receptionist),
        // switch immediately to POST /api/rpc envelope transport and re-verify the exact login user.
        if (verifiedPayload.user.id !== loginPayload.user.id && loginPayload.sessionToken) {
          enableRpcTransport();
          setStoredSessionToken(loginPayload.sessionToken);
          setStoredAuthUserId(loginPayload.user.id);
          verifiedPayload = await apiFetch<AuthSessionPayload>('/api/auth/me', {
            skipUnauthorizedHandling: true,
          });
        }

        if (verifiedPayload.user.id !== loginPayload.user.id) {
          throw new ApiClientError(
            502,
            'Session verification returned a mismatched account behind this proxy. Please retry.',
            'SESSION_VERIFY_FAILED'
          );
        }

        if (authEpochRef.current === epoch) {
          applySessionPayload({
            ...verifiedPayload,
            sessionToken: loginPayload.sessionToken ?? verifiedPayload.sessionToken,
          });
          setIsLoading(false);
        }
      } catch (err) {
        if (authEpochRef.current === epoch) {
          clearClientAuthState();
        }
        if (err instanceof ApiClientError && err.status === 401) {
          throw new ApiClientError(
            502,
            'Credentials were accepted, but session persistence could not be verified through this network proxy. Please retry.',
            'SESSION_VERIFY_FAILED'
          );
        }
        throw err;
      }
    },
    [applySessionPayload, clearClientAuthState]
  );

  const logout = useCallback(async () => {
    authEpochRef.current += 1;
    setSessionNotice(null);
    try {
      await apiFetch('/api/auth/logout', {
        method: 'POST',
        skipUnauthorizedHandling: true,
      });
    } catch {
      // Ignore network errors during logout cleanup
    } finally {
      clearClientAuthState();
    }
  }, [clearClientAuthState]);

  const selectProperty = useCallback(
    (propertyId: string) => {
      const exists = properties.some((p) => p.id === propertyId);
      if (exists) {
        setSelectedPropertyId(propertyId);
        setStoredPropertyId(propertyId);
      }
    },
    [properties]
  );

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  const selectedProperty =
    properties.find((p) => p.id === selectedPropertyId) ?? properties[0] ?? null;

  return (
    <AuthContext.Provider
      value={{
        user,
        properties,
        selectedProperty,
        isLoading,
        sessionNotice,
        clearSessionNotice,
        login,
        logout,
        selectProperty,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
