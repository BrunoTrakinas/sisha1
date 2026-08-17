const DEFAULT_PROFILES = Object.freeze({
  CONSULT: {
    windowMs: 60_000,
    maxRequests: 20,
    burstWindowMs: 10_000,
    burstMax: 5,
    perUserConcurrency: 2,
    globalConcurrency: 8,
  },
  DOCUMENT_ANALYSIS: {
    windowMs: 10 * 60_000,
    maxRequests: 5,
    burstWindowMs: 60_000,
    burstMax: 2,
    perUserConcurrency: 1,
    globalConcurrency: 2,
  },
  RAG_REINDEX: {
    windowMs: 15 * 60_000,
    maxRequests: 2,
    burstWindowMs: 5 * 60_000,
    burstMax: 1,
    perUserConcurrency: 1,
    globalConcurrency: 1,
  },
  ACTION_CONFIRM: {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    burstWindowMs: 60_000,
    burstMax: 4,
    perUserConcurrency: 1,
    globalConcurrency: 4,
  },
});

const profileState = new Map();
const reauthFailures = new Map();

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function positiveIntEnv(name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function profileConfig(name) {
  const base = DEFAULT_PROFILES[name];
  if (!base) throw new Error(`Perfil de abuso desconhecido: ${name}`);

  const prefix = `CHAT_LINCE_${name}`;
  return {
    windowMs: positiveIntEnv(`${prefix}_WINDOW_MS`, base.windowMs, { min: 1_000, max: 24 * 60 * 60_000 }),
    maxRequests: positiveIntEnv(`${prefix}_MAX`, base.maxRequests, { min: 1, max: 10_000 }),
    burstWindowMs: positiveIntEnv(`${prefix}_BURST_WINDOW_MS`, base.burstWindowMs, { min: 1_000, max: 60 * 60_000 }),
    burstMax: positiveIntEnv(`${prefix}_BURST_MAX`, base.burstMax, { min: 1, max: 10_000 }),
    perUserConcurrency: positiveIntEnv(`${prefix}_USER_CONCURRENCY`, base.perUserConcurrency, { min: 1, max: 100 }),
    globalConcurrency: positiveIntEnv(`${prefix}_GLOBAL_CONCURRENCY`, base.globalConcurrency, { min: 1, max: 1_000 }),
  };
}

function nowMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function pruneTimes(times = [], cutoff) {
  return times.filter((value) => value >= cutoff);
}

function stateFor(profileName) {
  if (!profileState.has(profileName)) {
    profileState.set(profileName, {
      users: new Map(),
      globalConcurrent: 0,
    });
  }
  return profileState.get(profileName);
}

function userStateFor(profileName, subject) {
  const state = stateFor(profileName);
  const key = normalizeKey(subject) || 'unknown';
  if (!state.users.has(key)) {
    state.users.set(key, {
      times: [],
      concurrent: 0,
      lastSeenAt: 0,
    });
  }
  return { state, key, user: state.users.get(key) };
}

function retryAfterSeconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function inspectRateLimit(profileName, subject, at = Date.now()) {
  const config = profileConfig(profileName);
  const now = nowMs(at);
  const { state, key, user } = userStateFor(profileName, subject);

  user.times = pruneTimes(user.times, now - config.windowMs);
  user.lastSeenAt = now;

  const burstTimes = user.times.filter((value) => value >= now - config.burstWindowMs);

  if (user.concurrent >= config.perUserConcurrency) {
    return {
      allowed: false,
      code: 'USER_CONCURRENCY_LIMIT',
      retryAfterSeconds: 1,
      profileName,
      subject: key,
    };
  }

  if (state.globalConcurrent >= config.globalConcurrency) {
    return {
      allowed: false,
      code: 'GLOBAL_CONCURRENCY_LIMIT',
      retryAfterSeconds: 1,
      profileName,
      subject: key,
    };
  }

  if (user.times.length >= config.maxRequests) {
    const oldest = Math.min(...user.times);
    return {
      allowed: false,
      code: 'WINDOW_RATE_LIMIT',
      retryAfterSeconds: retryAfterSeconds((oldest + config.windowMs) - now),
      profileName,
      subject: key,
    };
  }

  if (burstTimes.length >= config.burstMax) {
    const oldestBurst = Math.min(...burstTimes);
    return {
      allowed: false,
      code: 'BURST_RATE_LIMIT',
      retryAfterSeconds: retryAfterSeconds((oldestBurst + config.burstWindowMs) - now),
      profileName,
      subject: key,
    };
  }

  return {
    allowed: true,
    code: 'ALLOW',
    retryAfterSeconds: 0,
    profileName,
    subject: key,
  };
}

function acquireRatePermit(profileName, subject, at = Date.now()) {
  const inspection = inspectRateLimit(profileName, subject, at);
  if (!inspection.allowed) return inspection;

  const now = nowMs(at);
  const { state, user } = userStateFor(profileName, subject);
  user.times.push(now);
  user.concurrent += 1;
  user.lastSeenAt = now;
  state.globalConcurrent += 1;

  let released = false;
  return {
    ...inspection,
    release() {
      if (released) return;
      released = true;
      user.concurrent = Math.max(0, user.concurrent - 1);
      state.globalConcurrent = Math.max(0, state.globalConcurrent - 1);
    },
  };
}

function cleanupRateState(at = Date.now()) {
  const now = nowMs(at);
  for (const [profileName, state] of profileState.entries()) {
    const config = profileConfig(profileName);
    for (const [key, user] of state.users.entries()) {
      user.times = pruneTimes(user.times, now - config.windowMs);
      if (user.concurrent === 0 && user.times.length === 0 && user.lastSeenAt < now - config.windowMs) {
        state.users.delete(key);
      }
    }
  }
}

function reauthConfig() {
  return {
    windowMs: positiveIntEnv('CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS', 15 * 60_000, { min: 10_000, max: 24 * 60 * 60_000 }),
    maxFailures: positiveIntEnv('CHAT_LINCE_REAUTH_MAX_FAILURES', 5, { min: 2, max: 50 }),
    lockMs: positiveIntEnv('CHAT_LINCE_REAUTH_LOCK_MS', 15 * 60_000, { min: 10_000, max: 24 * 60 * 60_000 }),
  };
}

function reauthStateFor(subject) {
  const key = normalizeKey(subject) || 'unknown';
  if (!reauthFailures.has(key)) {
    reauthFailures.set(key, {
      failures: [],
      lockedUntil: 0,
    });
  }
  return { key, state: reauthFailures.get(key) };
}

function inspectReauth(subject, at = Date.now()) {
  const now = nowMs(at);
  const config = reauthConfig();
  const { key, state } = reauthStateFor(subject);
  state.failures = pruneTimes(state.failures, now - config.windowMs);

  if (state.lockedUntil > now) {
    return {
      allowed: false,
      code: 'REAUTH_TEMPORARILY_LOCKED',
      retryAfterSeconds: retryAfterSeconds(state.lockedUntil - now),
      subject: key,
    };
  }

  if (state.lockedUntil && state.lockedUntil <= now) state.lockedUntil = 0;

  return {
    allowed: true,
    code: 'ALLOW',
    retryAfterSeconds: 0,
    subject: key,
    failuresInWindow: state.failures.length,
  };
}

function recordReauthFailure(subject, at = Date.now()) {
  const now = nowMs(at);
  const config = reauthConfig();
  const { key, state } = reauthStateFor(subject);
  state.failures = pruneTimes(state.failures, now - config.windowMs);
  state.failures.push(now);

  if (state.failures.length >= config.maxFailures) {
    state.lockedUntil = now + config.lockMs;
    return {
      locked: true,
      code: 'REAUTH_TEMPORARILY_LOCKED',
      retryAfterSeconds: retryAfterSeconds(config.lockMs),
      subject: key,
      failuresInWindow: state.failures.length,
    };
  }

  return {
    locked: false,
    code: 'REAUTH_FAILURE_RECORDED',
    retryAfterSeconds: 0,
    subject: key,
    failuresInWindow: state.failures.length,
  };
}

function clearReauthFailures(subject) {
  const key = normalizeKey(subject) || 'unknown';
  reauthFailures.delete(key);
}

function resetAbuseGuardStateForTests() {
  profileState.clear();
  reauthFailures.clear();
}

module.exports = {
  DEFAULT_PROFILES,
  profileConfig,
  inspectRateLimit,
  acquireRatePermit,
  cleanupRateState,
  reauthConfig,
  inspectReauth,
  recordReauthFailure,
  clearReauthFailures,
  resetAbuseGuardStateForTests,
};
