const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const BASE_URL = "https://api.xcloudphone.com";
const http = axios.create({ timeout: 15000 });

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: "https://app.xcloudphone.com",
  Referer: "https://app.xcloudphone.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

const accountCookies = new Map();

function saveCookies(accountKey, setCookieArr) {
  if (!Array.isArray(setCookieArr) || !setCookieArr.length) return;
  accountCookies.set(accountKey, setCookieArr.map((c) => c.split(";")[0]).join("; "));
}

function clearCookies(accountKey) {
  accountCookies.delete(accountKey);
}

function buildHeaders(accountKey) {
  const h = { ...BASE_HEADERS };
  const cookie = accountCookies.get(accountKey);
  if (cookie) h.Cookie = cookie;
  return h;
}

async function login(accountKey, { username, password, userDeviceId }) {
  try {
    const res = await http.post(
      `${BASE_URL}/auth/renters/login`,
      { username, password, userDeviceId },
      { headers: buildHeaders(accountKey), withCredentials: true }
    );
    saveCookies(accountKey, res.headers["set-cookie"]);
    return { success: true, data: res.data };
  } catch (err) {
    return {
      success: false,
      status: err.response?.status,
      error:
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message,
    };
  }
}

async function checkSession(accountKey) {
  try {
    const res = await http.get(`${BASE_URL}/auth/renters/me/`, {
      headers: buildHeaders(accountKey),
      withCredentials: true,
    });
    return { valid: true, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      clearCookies(accountKey);
      return { valid: false, expired: true };
    }
    return { valid: false, expired: false, error: err.message };
  }
}

async function getRentalSessions(accountKey, { page = 1, limit = 25 } = {}) {
  try {
    const res = await http.get(`${BASE_URL}/renters/rental-sessions`, {
      headers: buildHeaders(accountKey),
      withCredentials: true,
      params: { page, limit, sortBy: "startTime", sortOrder: "desc" },
    });

    const raw = res.data?.data || res.data?.items || res.data || [];
    return raw.map((s) => {
      const remainMs = s.endTime
        ? new Date(s.endTime).getTime() - Date.now()
        : null;
      return {
        id: s.id,
        sessionName: s.sessionName,
        shortId: s.device?.shortId || s.id?.slice(0, 8),
        endTime: s.endTime,
        remainMs,
        remainMinutes: remainMs != null ? Math.floor(remainMs / 60000) : null,
      };
    });
  } catch {
    return [];
  }
}

// Fetch shared sessions (shared-with-me)
async function getSharedSessions(accountKey, { page = 1, limit = 20 } = {}) {
  try {
    const res = await http.get(
      `${BASE_URL}/renters/session-share-invites/shared-with-me`,
      {
        headers: buildHeaders(accountKey),
        withCredentials: true,
        params: { page, limit, sortOrder: "desc" },
      }
    );

    const raw = res.data?.data || [];
    return raw.map((invite) => {
      const s = invite.session || {};
      const remainMs = s.endTime
        ? new Date(s.endTime).getTime() - Date.now()
        : null;
      return {
        inviteId: invite.id,
        // sessionId may be null/undefined — extend is optional
        sessionId: invite.sessionId || null,
        sessionName: s.sessionName || null,
        shortId: s.device?.shortId || invite.sessionId?.slice(0, 8) || null,
        endTime: s.endTime || null,
        remainMs,
        remainMinutes: remainMs != null ? Math.floor(remainMs / 60000) : null,
        inviterUsername: invite.inviter?.username || null,
      };
    });
  } catch {
    return [];
  }
}

const FAIL_FILE = path.join(__dirname, "..", "data", "extend-fail.json");
const MAX_FAIL = config.MAX_FAIL;

function loadFailTracker() {
  try {
    if (!fs.existsSync(FAIL_FILE)) return {};
    return JSON.parse(fs.readFileSync(FAIL_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveFailTracker(tracker) {
  const dir = path.dirname(FAIL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FAIL_FILE, JSON.stringify(tracker, null, 2));
}

function markFail(sessionId) {
  const tracker = loadFailTracker();
  const entry = tracker[sessionId] || { failCount: 0, locked: false };
  entry.failCount += 1;
  entry.lastFailAt = new Date().toISOString();
  let justLocked = false;
  if (entry.failCount >= MAX_FAIL && !entry.locked) {
    entry.locked = true;
    justLocked = true;
  }
  tracker[sessionId] = entry;
  saveFailTracker(tracker);
  return { entry, justLocked };
}

function markSuccess(sessionId) {
  const tracker = loadFailTracker();
  if (tracker[sessionId]) {
    delete tracker[sessionId];
    saveFailTracker(tracker);
  }
}

function getFailEntry(sessionId) {
  return loadFailTracker()[sessionId] || null;
}

function clearFailEntries(sessionIds = []) {
  if (!sessionIds.length) return;
  const tracker = loadFailTracker();
  let changed = false;
  for (const id of sessionIds) {
    if (tracker[id]) {
      delete tracker[id];
      changed = true;
    }
  }
  if (changed) saveFailTracker(tracker);
}

async function extendSession(
  accountKey,
  sessionId,
  remainMinutes = null,
  rentalHours = config.EXTEND_RENTAL_HOURS,
  paymentMethod = "balance"
) {
  const existing = getFailEntry(sessionId);
  if (existing?.locked) {
    return { ok: false, locked: true };
  }

  if (remainMinutes !== null && remainMinutes >= config.EXTEND_SKIP_THRESHOLD) {
    return { ok: false, overLimit: true, reason: "Tổng thời gian thiết bị không quá 5 giờ" };
  }

  try {
    const res = await http.post(
      `${BASE_URL}/rentals/extend`,
      { listSessionId: [sessionId], rentalHours, paymentMethod },
      { headers: buildHeaders(accountKey), withCredentials: true }
    );

    const data = res.data || {};
    const ok = data.extended === 1;

    if (ok) {
      markSuccess(sessionId);
      return { ok: true, price: data.totalPrice ?? null };
    } else {
      const reason =
        data.message ||
        data.error ||
        data.errorMessage ||
        data.reason ||
        data.msg ||
        (Array.isArray(data.devices) && data.devices.length === 0
          ? "Device not found"
          : "Unknown");
      const { entry, justLocked } = markFail(sessionId);
      return {
        ok: false,
        locked: false,
        justLocked,
        reason,
        failCount: entry.failCount,
        raw: data,
      };
    }
  } catch (err) {
    const errMsg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    const { entry, justLocked } = markFail(sessionId);
    return {
      ok: false,
      locked: false,
      justLocked,
      reason: errMsg,
      failCount: entry.failCount,
    };
  }
}

async function autoExtendExpiringSessions(accountKey, {
  thresholdMinutes = config.EXTEND_THRESHOLD_MINUTES,
  rentalHours = config.EXTEND_RENTAL_HOURS,
  sessions = null,
} = {}) {
  if (!sessions) sessions = await getRentalSessions(accountKey);

  const expiring = sessions.filter(
    (s) => s.remainMinutes != null && s.remainMinutes < thresholdMinutes
  );

  const results = [];
  for (const s of expiring) {
    const result = await extendSession(accountKey, s.id, s.remainMinutes, rentalHours);
    results.push({ session: s, ...result });
  }
  return results;
}

// Auto extend shared sessions — only extends if sessionId is present
async function autoExtendExpiringSharedSessions(accountKey, {
  thresholdMinutes = config.EXTEND_THRESHOLD_MINUTES,
  rentalHours = config.EXTEND_RENTAL_HOURS,
  sessions = null,
} = {}) {
  if (!sessions) sessions = await getSharedSessions(accountKey);

  // Only process entries that have a sessionId (extend is optional)
  const expiring = sessions.filter(
    (s) => s.sessionId && s.remainMinutes != null && s.remainMinutes < thresholdMinutes
  );

  const results = [];
  for (const s of expiring) {
    const result = await extendSession(accountKey, s.sessionId, s.remainMinutes, rentalHours);
    results.push({ session: s, ...result });
  }
  return results;
}

module.exports = {
  login,
  checkSession,
  getRentalSessions,
  getSharedSessions,
  extendSession,
  autoExtendExpiringSessions,
  autoExtendExpiringSharedSessions,
  clearCookies,
  clearFailEntries,
  MAX_FAIL,
};
