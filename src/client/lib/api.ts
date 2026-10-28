export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly fieldErrors?: Record<string, string>;
  public readonly details?: Record<string, any>;

  constructor(
    status: number,
    message: string,
    code = 'API_ERROR',
    fieldErrors?: Record<string, string>,
    details?: Record<string, any>
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}

export const SESSION_STORAGE_TOKEN_KEY = 'staycraft_opaque_session';
const AUTH_USER_ID_STORAGE_KEY = 'staycraft_active_user_id';
const PROPERTY_STORAGE_KEY = 'staycraft_selected_property_id';
const RPC_TRANSPORT_STORAGE_KEY = 'staycraft_use_rpc_transport';

// In-memory primary cache ensures credentials work even inside cross-site live-preview
// iframes where browsers block third-party cookies AND throw SecurityError on Web Storage.
let inMemorySessionToken: string | null = null;
let inMemoryAuthUserId: string | null = null;
let inMemoryPropertyId: string | null = null;
let usePostRpcTransport = false;

type UnauthorizedHandler = (message: string, code: string) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function safeReadStorage(storageType: 'sessionStorage' | 'localStorage', key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const store = window[storageType];
    const value = store.getItem(key);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function safeWriteStorage(
  storageType: 'sessionStorage' | 'localStorage',
  key: string,
  value: string | null
): void {
  try {
    if (typeof window === 'undefined') return;
    const store = window[storageType];
    if (value && value.trim().length > 0) {
      store.setItem(key, value.trim());
    } else {
      store.removeItem(key);
    }
  } catch {
    // Ignore SecurityError / QuotaExceededError in storage-restricted iframe environments
  }
}

function isRpcTransportEnabled(): boolean {
  if (usePostRpcTransport) return true;
  if (safeReadStorage('sessionStorage', RPC_TRANSPORT_STORAGE_KEY) === '1') {
    usePostRpcTransport = true;
    return true;
  }
  return false;
}

export function enableRpcTransport(): void {
  usePostRpcTransport = true;
  safeWriteStorage('sessionStorage', RPC_TRANSPORT_STORAGE_KEY, '1');
}

export function isUsingRpcTransport(): boolean {
  return isRpcTransportEnabled();
}

export function resetApiTransportState(): void {
  usePostRpcTransport = false;
  inMemoryAuthUserId = null;
  safeWriteStorage('sessionStorage', RPC_TRANSPORT_STORAGE_KEY, null);
  safeWriteStorage('sessionStorage', AUTH_USER_ID_STORAGE_KEY, null);
}

export function getStoredSessionToken(): string | null {
  if (inMemorySessionToken && inMemorySessionToken.length > 0) {
    return inMemorySessionToken;
  }
  const persisted =
    safeReadStorage('sessionStorage', SESSION_STORAGE_TOKEN_KEY) ??
    safeReadStorage('localStorage', SESSION_STORAGE_TOKEN_KEY);

  if (persisted) {
    inMemorySessionToken = persisted;
  }
  return persisted;
}

export function setStoredSessionToken(token: string | null): void {
  const normalized = token && token.trim().length > 0 ? token.trim() : null;
  if (normalized !== inMemorySessionToken) {
    inMemoryAuthUserId = null;
    safeWriteStorage('sessionStorage', AUTH_USER_ID_STORAGE_KEY, null);
  }
  inMemorySessionToken = normalized;
  safeWriteStorage('sessionStorage', SESSION_STORAGE_TOKEN_KEY, normalized);
  safeWriteStorage('localStorage', SESSION_STORAGE_TOKEN_KEY, normalized);
}

export function syncSessionTokenFromStorage(token: string | null): void {
  const normalized = token && token.trim().length > 0 ? token.trim() : null;
  inMemorySessionToken = normalized;
  inMemoryAuthUserId = null;
  safeWriteStorage('sessionStorage', SESSION_STORAGE_TOKEN_KEY, normalized);
  safeWriteStorage('sessionStorage', AUTH_USER_ID_STORAGE_KEY, null);
}

export function getStoredAuthUserId(): string | null {
  if (inMemoryAuthUserId && inMemoryAuthUserId.length > 0) {
    return inMemoryAuthUserId;
  }
  const persisted = safeReadStorage('sessionStorage', AUTH_USER_ID_STORAGE_KEY);
  if (persisted) {
    inMemoryAuthUserId = persisted;
  }
  return persisted;
}

export function setStoredAuthUserId(userId: string | null): void {
  const normalized = userId && userId.trim().length > 0 ? userId.trim() : null;
  inMemoryAuthUserId = normalized;
  safeWriteStorage('sessionStorage', AUTH_USER_ID_STORAGE_KEY, normalized);
}

export function getStoredPropertyId(): string | null {
  if (inMemoryPropertyId && inMemoryPropertyId.length > 0) {
    return inMemoryPropertyId;
  }
  const persisted =
    safeReadStorage('localStorage', PROPERTY_STORAGE_KEY) ??
    safeReadStorage('sessionStorage', PROPERTY_STORAGE_KEY);

  if (persisted) {
    inMemoryPropertyId = persisted;
  }
  return persisted;
}

export function setStoredPropertyId(propertyId: string | null): void {
  const normalized = propertyId && propertyId.trim().length > 0 ? propertyId.trim() : null;
  inMemoryPropertyId = normalized;
  safeWriteStorage('localStorage', PROPERTY_STORAGE_KEY, normalized);
  safeWriteStorage('sessionStorage', PROPERTY_STORAGE_KEY, normalized);
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  propertyId?: string | null;
  skipUnauthorizedHandling?: boolean;
}

function resolveRpcTarget(path: string): { rpcUrl: string; targetApiPath: string } | null {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      const parsed = new URL(path);
      if (!parsed.pathname.startsWith('/api/') || parsed.pathname === '/api/rpc') {
        return null;
      }
      return {
        rpcUrl: `${parsed.origin}/api/rpc`,
        targetApiPath: `${parsed.pathname}${parsed.search}`,
      };
    } catch {
      return null;
    }
  }

  if (path.startsWith('/api/') && !path.startsWith('/api/rpc')) {
    return { rpcUrl: '/api/rpc', targetApiPath: path };
  }

  return null;
}

async function executeRpcRequest(
  rpcUrl: string,
  targetMethod: string,
  targetApiPath: string,
  body: unknown,
  token: string | null,
  activePropId: string | null,
  expectedUserId: string | null,
  signal?: AbortSignal | null
): Promise<Response> {
  const rpcHeaders = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  if (token) {
    rpcHeaders.set('X-Session-Token', token);
    rpcHeaders.set('Authorization', `Bearer ${token}`);
  }
  if (activePropId) {
    rpcHeaders.set('X-Property-Id', activePropId);
  }
  if (expectedUserId) {
    rpcHeaders.set('X-Auth-User-Id', expectedUserId);
  }

  return fetch(rpcUrl, {
    method: 'POST',
    headers: rpcHeaders,
    body: JSON.stringify({
      method: targetMethod,
      path: targetApiPath,
      payload: body,
      sessionToken: token ?? undefined,
      propertyId: activePropId ?? undefined,
      expectedUserId: expectedUserId ?? undefined,
    }),
    credentials: 'include',
    signal,
  });
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body, propertyId, skipUnauthorizedHandling, headers: initHeaders, ...fetchInit } = options;
  const method = (fetchInit.method ?? 'GET').toUpperCase();

  const token = getStoredSessionToken();
  const expectedUserId = getStoredAuthUserId();
  const activePropId = propertyId ?? getStoredPropertyId();
  const rpcTarget = resolveRpcTarget(path);
  const isLoginRequest = rpcTarget?.targetApiPath.startsWith('/api/auth/login') ?? path.startsWith('/api/auth/login');
  const isLogoutRequest = rpcTarget?.targetApiPath.startsWith('/api/auth/logout') ?? path.startsWith('/api/auth/logout');

  let response: Response;

  if (token && rpcTarget && !isLoginRequest && isRpcTransportEnabled()) {
    response = await executeRpcRequest(
      rpcTarget.rpcUrl,
      method,
      rpcTarget.targetApiPath,
      body,
      token,
      activePropId,
      isLogoutRequest ? null : expectedUserId,
      fetchInit.signal
    );
  } else {
    const headers = new Headers(initHeaders);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    if (token) {
      if (!headers.has('X-Session-Token')) {
        headers.set('X-Session-Token', token);
      }
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }

    if (expectedUserId && !isLoginRequest && !isLogoutRequest && !headers.has('X-Auth-User-Id')) {
      headers.set('X-Auth-User-Id', expectedUserId);
    }

    if (activePropId && !headers.has('X-Property-Id')) {
      headers.set('X-Property-Id', activePropId);
    }

    let serializedBody: BodyInit | undefined;
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      serializedBody = JSON.stringify(body);
    }

    response = await fetch(path, {
      ...fetchInit,
      method,
      headers,
      body: serializedBody,
      credentials: 'include',
    });

    // If we attached a non-empty token on the client, yet an intermediate preview proxy
    // stripped our custom auth/property headers (causing either 401 AUTH_TOKEN_MISSING
    // when no cookie is present, or 403 FORBIDDEN when a stale lower-privilege cookie
    // was forwarded instead of our explicit session token), switch to POST /api/rpc
    // JSON envelope transport, which passes through the exact same backend auth + RBAC stack.
    if ((response.status === 401 || response.status === 403) && token && rpcTarget && !isLoginRequest) {
      const probeType = response.headers.get('content-type') ?? '';
      const probeData = probeType.includes('application/json')
        ? await response.clone().json().catch(() => null)
        : null;
      const errCode = probeData?.error?.code;

      if (response.status === 401 && errCode === 'AUTH_TOKEN_MISSING') {
        enableRpcTransport();
        response = await executeRpcRequest(
          rpcTarget.rpcUrl,
          method,
          rpcTarget.targetApiPath,
          body,
          token,
          activePropId,
          isLogoutRequest ? null : expectedUserId,
          fetchInit.signal
        );
      } else if (response.status === 403 && errCode === 'FORBIDDEN') {
        const rpcResponse = await executeRpcRequest(
          rpcTarget.rpcUrl,
          method,
          rpcTarget.targetApiPath,
          body,
          token,
          activePropId,
          isLogoutRequest ? null : expectedUserId,
          fetchInit.signal
        );
        if (rpcResponse.ok) {
          enableRpcTransport();
          response = rpcResponse;
        } else if (rpcResponse.status === 401) {
          response = rpcResponse;
        }
      }
    }
  }

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const errObj = data?.error ?? {};
    const message = errObj.message ?? `Request failed (${response.status})`;
    const code = errObj.code ?? 'API_ERROR';
    const apiError = new ApiClientError(
      response.status,
      message,
      code,
      errObj.fieldErrors,
      errObj.details
    );

    if (
      response.status === 401 &&
      code !== 'INVALID_CURRENT_PASSWORD' &&
      !skipUnauthorizedHandling &&
      !isLoginRequest &&
      !isLogoutRequest
    ) {
      unauthorizedHandler?.(message, code);
    }

    throw apiError;
  }

  return data as T;
}

export async function publicApiFetch<T>(
  path: string,
  options: Omit<RequestInit, 'body'> & { body?: unknown } = {}
): Promise<T> {
  const { body, headers: initHeaders, ...fetchInit } = options;
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  const headers = new Headers(initHeaders);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  let serializedBody: BodyInit | undefined;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    serializedBody = JSON.stringify(body);
  }

  const response = await fetch(path, {
    ...fetchInit,
    method,
    headers,
    body: serializedBody,
    credentials: 'omit',
  });

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : null;

  if (!response.ok) {
    const errObj = data?.error ?? {};
    throw new ApiClientError(
      response.status,
      errObj.message ?? `Request failed (${response.status})`,
      errObj.code ?? 'API_ERROR',
      errObj.fieldErrors,
      errObj.details
    );
  }

  return data as T;
}
