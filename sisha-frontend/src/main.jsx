import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { authStorageKey } from './context/AuthContext.jsx';
import { API_BASE_URL } from './lib/api.js';

const originalFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const managedApiPrefix = `${API_BASE_URL.replace(/\/+$/, '')}/`;
  const isManagedApi = url.startsWith(managedApiPrefix);

  if (!isManagedApi) {
    return originalFetch(input, init);
  }

  let token = null;
  try {
    const raw = sessionStorage.getItem(authStorageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      token = parsed?.token || null;
    }
  } catch {
    token = null;
  }

  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return originalFetch(input, { ...init, headers });
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);