import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL, LOGIN_NOTICE_KEY, SESSION_EXPIRED_EVENT } from '../lib/api';

const AuthContext = createContext(null);
const STORAGE_KEY = 'sisha_session';
const LAST_ACTIVITY_KEY = 'sisha_last_activity_at';
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const PRESENCE_PING_MS = 60 * 1000;
const ACTIVITY_EVENTS = ['click', 'keydown', 'mousemove', 'scroll', 'touchstart', 'wheel'];

function nowMs() {
  return Date.now();
}

function saveLastActivity(timestamp = nowMs()) {
  try {
    sessionStorage.setItem(LAST_ACTIVITY_KEY, String(timestamp));
  } catch {
    // Ignora falhas de storage.
  }
}

function readLastActivity() {
  try {
    const raw = Number(sessionStorage.getItem(LAST_ACTIVITY_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : nowMs();
  } catch {
    return nowMs();
  }
}

function clearSessionStorage() {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(LAST_ACTIVITY_KEY);
}

function normalizeLogoutOptions(options = {}) {
  if (!options || typeof options !== 'object' || options.nativeEvent) return {};
  return options;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const idleTimerRef = useRef(null);
  const lastActivityRef = useRef(nowMs());
  const endingSessionRef = useRef(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setUser(parsed.user || null);
        setToken(parsed.token || null);
        lastActivityRef.current = readLastActivity();
      }
    } catch {
      clearSessionStorage();
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback((session) => {
    const timestamp = nowMs();
    const payload = { user: session.user, token: session.token };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    sessionStorage.removeItem(LOGIN_NOTICE_KEY);
    saveLastActivity(timestamp);
    lastActivityRef.current = timestamp;
    endingSessionRef.current = false;
    setUser(session.user);
    setToken(session.token);
  }, []);

  const logout = useCallback(async (options = {}) => {
    const safeOptions = normalizeLogoutOptions(options);
    const reason = String(safeOptions.reason || 'MANUAL').toUpperCase();
    const message = safeOptions.message || '';
    const notifyBackend = safeOptions.notifyBackend !== false;
    const currentToken = token;

    if (endingSessionRef.current && reason !== 'MANUAL') return;
    endingSessionRef.current = true;

    try {
      if (message) {
        sessionStorage.setItem(LOGIN_NOTICE_KEY, message);
      } else if (reason === 'MANUAL') {
        sessionStorage.removeItem(LOGIN_NOTICE_KEY);
      }
    } catch {
      // Ignora falhas de storage.
    }

    try {
      if (notifyBackend && currentToken) {
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${currentToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason }),
        });
      }
    } catch {
      // Logout local deve funcionar mesmo se o backend estiver indisponível.
    } finally {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      clearSessionStorage();
      setUser(null);
      setToken(null);
      window.setTimeout(() => {
        endingSessionRef.current = false;
      }, 300);
    }
  }, [token]);

  const encerrarPorInatividade = useCallback(() => {
    if (!token || !user) return;
    logout({
      reason: 'INATIVIDADE',
      message: 'Sua sessão foi encerrada por inatividade. Faça login novamente para continuar.',
      notifyBackend: true,
    });
  }, [logout, token, user]);

  useEffect(() => {
    if (!token || !user) return undefined;

    const agendarTimeout = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      const elapsed = nowMs() - lastActivityRef.current;
      const remaining = Math.max(0, IDLE_TIMEOUT_MS - elapsed);
      idleTimerRef.current = window.setTimeout(encerrarPorInatividade, remaining);
    };

    const registrarAtividade = () => {
      const timestamp = nowMs();
      const elapsed = timestamp - lastActivityRef.current;

      if (elapsed >= IDLE_TIMEOUT_MS) {
        encerrarPorInatividade();
        return;
      }

      lastActivityRef.current = timestamp;
      saveLastActivity(timestamp);
      agendarTimeout();
    };

    const validarAoVoltarParaTela = () => {
      if (document.visibilityState !== 'visible') return;
      const elapsed = nowMs() - lastActivityRef.current;
      if (elapsed >= IDLE_TIMEOUT_MS) {
        encerrarPorInatividade();
      }
    };

    const initialElapsed = nowMs() - lastActivityRef.current;
    if (initialElapsed >= IDLE_TIMEOUT_MS) {
      encerrarPorInatividade();
      return undefined;
    }

    agendarTimeout();
    ACTIVITY_EVENTS.forEach((eventName) => {
      window.addEventListener(eventName, registrarAtividade, { passive: true });
    });
    document.addEventListener('visibilitychange', validarAoVoltarParaTela);

    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      ACTIVITY_EVENTS.forEach((eventName) => {
        window.removeEventListener(eventName, registrarAtividade);
      });
      document.removeEventListener('visibilitychange', validarAoVoltarParaTela);
    };
  }, [encerrarPorInatividade, token, user]);

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
    const interval = window.setInterval(ping, PRESENCE_PING_MS);
    return () => window.clearInterval(interval);
  }, [token, user]);

  useEffect(() => {
    const handleSessionExpired = (event) => {
      if (!token || !user) return;
      logout({
        reason: 'SESSAO_EXPIRADA',
        message: event?.detail?.message || 'Sua sessão expirou. Faça login novamente para continuar.',
        notifyBackend: false,
      });
    };

    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [logout, token, user]);

  const value = useMemo(() => ({ user, token, loading, login, logout }), [user, token, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider.');
  return context;
}

export const authStorageKey = STORAGE_KEY;
