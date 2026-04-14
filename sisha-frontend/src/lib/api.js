const rawBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export const API_BASE_URL = rawBaseUrl.replace(/\/+$/, '');

export function buildAuthHeaders(token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function apiFetch(path, options = {}, token = null) {
  const finalOptions = { ...options };
  finalOptions.headers = buildAuthHeaders(token, options.headers || {});
  return fetch(`${API_BASE_URL}${path}`, finalOptions);
}