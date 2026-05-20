import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { API_BASE_URL } from '../lib/api';

const AuthContext = createContext(null);
const STORAGE_KEY = 'sisha_session';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setUser(parsed.user || null);
        setToken(parsed.token || null);
      }
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    } finally {
      setLoading(false);
    }
  }, []);

  const login = (session) => {
    const payload = { user: session.user, token: session.token };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    setUser(session.user);
    setToken(session.token);
  };

  const logout = useCallback(async () => {
    const currentToken = token;
    try {
      if (currentToken) {
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${currentToken}` },
        });
      }
    } catch {
      // Logout local deve funcionar mesmo se o backend estiver indisponível.
    } finally {
      sessionStorage.removeItem(STORAGE_KEY);
      setUser(null);
      setToken(null);
    }
  }, [token]);

  useEffect(() => {
    if (!token || !user) return undefined;

    const ping = () => {
      fetch(`${API_BASE_URL}/auth/presence/ping`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: window.location?.pathname || '/' }),
      }).catch(() => {});
    };

    ping();
    const interval = window.setInterval(ping, 60000);
    return () => window.clearInterval(interval);
  }, [token, user]);

  const value = useMemo(() => ({ user, token, loading, login, logout }), [user, token, loading, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider.');
  return context;
}

export const authStorageKey = STORAGE_KEY;
