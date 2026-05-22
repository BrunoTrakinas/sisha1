const rawBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export const API_BASE_URL = rawBaseUrl.replace(/\/+$/, '');
export const SESSION_EXPIRED_EVENT = 'sisha:session-expired';
export const LOGIN_NOTICE_KEY = 'sisha_login_notice';

export function buildAuthHeaders(token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function notifySessionExpired(message = 'Sua sessão expirou. Faça login novamente para continuar.') {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(LOGIN_NOTICE_KEY, message);
  } catch {
    // Ignora falhas de storage para não quebrar o fluxo principal.
  }

  window.dispatchEvent(
    new CustomEvent(SESSION_EXPIRED_EVENT, {
      detail: { message },
    }),
  );
}

export async function apiFetch(path, options = {}, token = null) {
  const finalOptions = { ...options };
  finalOptions.headers = buildAuthHeaders(token, options.headers || {});

  const response = await fetch(`${API_BASE_URL}${path}`, finalOptions);

  if (response.status === 401) {
    notifySessionExpired('Sua sessão expirou ou ficou inválida. Faça login novamente para continuar.');
  }

  return response;
}
