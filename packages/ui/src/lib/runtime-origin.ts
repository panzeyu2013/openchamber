type RuntimeOriginContext = {
  currentOrigin?: string | null;
  localOrigin?: string | null;
};

export const normalizeRuntimeBaseUrl = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
};

const getRuntimeOrigin = (value: string | null | undefined): string => {
  const normalized = normalizeRuntimeBaseUrl(value);
  if (!normalized) return '';
  try {
    return new URL(normalized).origin;
  } catch {
    return '';
  }
};

export const sameRuntimeOrigin = (left: string | null | undefined, right: string | null | undefined): boolean => {
  const leftOrigin = getRuntimeOrigin(left);
  const rightOrigin = getRuntimeOrigin(right);
  return Boolean(leftOrigin && rightOrigin && leftOrigin === rightOrigin);
};

const isLoopbackRuntimeUrl = (value: string | null | undefined): boolean => {
  try {
    const hostname = new URL(normalizeRuntimeBaseUrl(value)).hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '::1'
      || hostname === '[::1]'
      || hostname.startsWith('127.');
  } catch {
    return false;
  }
};

export const readWindowRuntimeOriginContext = (): RuntimeOriginContext => {
  if (typeof window === 'undefined') return {};
  const runtimeWindow = window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string };
  return {
    currentOrigin: window.location?.origin || '',
    localOrigin: runtimeWindow.__OPENCHAMBER_LOCAL_ORIGIN__ || '',
  };
};

export const sanitizeRuntimeKeyPart = (value: string | null | undefined): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]+$/.test(trimmed) ? trimmed : '';
};

export const readInjectedDesktopHostId = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_DESKTOP_HOST_ID__?: string }).__OPENCHAMBER_DESKTOP_HOST_ID__;
  return sanitizeRuntimeKeyPart(injected);
};

export const shouldIgnoreRuntimeApiBaseUrl = (
  apiBaseUrl: string | null | undefined,
  context: RuntimeOriginContext = readWindowRuntimeOriginContext(),
): boolean => {
  const normalizedApiBaseUrl = normalizeRuntimeBaseUrl(apiBaseUrl);
  const currentOrigin = normalizeRuntimeBaseUrl(context.currentOrigin);
  if (!normalizedApiBaseUrl || !currentOrigin) return false;
  if (sameRuntimeOrigin(currentOrigin, normalizedApiBaseUrl)) return false;
  const localOrigin = normalizeRuntimeBaseUrl(context.localOrigin);
  if (localOrigin && sameRuntimeOrigin(normalizedApiBaseUrl, localOrigin)) return false;
  if (localOrigin && sameRuntimeOrigin(currentOrigin, localOrigin)) return false;
  return isLoopbackRuntimeUrl(currentOrigin) && isLoopbackRuntimeUrl(normalizedApiBaseUrl);
};

export const sanitizeRuntimeApiBaseUrl = (
  apiBaseUrl: string | null | undefined,
  context: RuntimeOriginContext = readWindowRuntimeOriginContext(),
): string => {
  const normalized = normalizeRuntimeBaseUrl(apiBaseUrl);
  return shouldIgnoreRuntimeApiBaseUrl(normalized, context) ? '' : normalized;
};
