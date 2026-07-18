const {
  checkSession,
  login,
  getRentalSessions,
  getSharedSessions,
  autoExtendExpiringSessions,
  autoExtendExpiringSharedSessions,
} = require("./api");
const store = require("./store");
const config = require("./config");

const runningLoops = new Map();

function isRunning(accountKey) {
  return runningLoops.has(accountKey);
}

function start(accountKey, account, onLog, intervalMs = config.POLL_INTERVAL_MS) {
  if (isRunning(accountKey)) return false;

  const [discordUserId, username] = accountKey.split(":");
  let isTicking = false;
  let loginFailCount = 0;

  const tick = async () => {
    if (isTicking) return;
    isTicking = true;
    try {
      const { valid, expired } = await checkSession(accountKey);

      if (!valid && expired) {
        const current = store.getAccount(discordUserId, username) || account;
        if (typeof current.username !== "string" || typeof current.password !== "string") {
          onLog("[ERROR] Missing username/password. Please /login again. Stopping loop.");
          stop(accountKey);
          store.setAccount(discordUserId, username, { running: false });
          return;
        }

        const result = await login(accountKey, {
          username: current.username,
          password: current.password,
          userDeviceId: current.userDeviceId,
        });

        if (!result.success) {
          loginFailCount++;
          if (loginFailCount === 1 || loginFailCount % 5 === 0) {
            onLog(`[WARN] Re-login failed (${loginFailCount}x): ${result.error}. Will keep retrying.`);
          }
          return;
        }

        if (loginFailCount > 0) onLog("[OK] Re-login successful. Continuing keep-alive.");
        loginFailCount = 0;
      }

      const sessions = await getRentalSessions(accountKey);
      store.saveSessionCache(discordUserId, username, sessions);

      const results = await autoExtendExpiringSessions(accountKey, { sessions });
      for (const r of results) {
        const id = r.session.shortId || r.session.id?.slice(0, 8);
        if (r.ok) {
          onLog(`[OK] Extended ${id} +${config.EXTEND_RENTAL_HOURS}h (price: ${r.price ?? "?"})`);
        } else if (r.justLocked) {
          onLog(`[ERROR] ${id} now locked - ${r.reason}`);
        }
      }

      const sharedSessions = await getSharedSessions(accountKey);
      const sharedResults = await autoExtendExpiringSharedSessions(accountKey, { sessions: sharedSessions });
      for (const r of sharedResults) {
        const id = r.session.shortId || r.session.sessionId?.slice(0, 8);
        const inviter = r.session.inviterUsername ? ` (from ${r.session.inviterUsername})` : "";
        if (r.ok) {
          onLog(`[OK] Extended shared ${id}${inviter} +${config.EXTEND_RENTAL_HOURS}h (price: ${r.price ?? "?"})`);
        } else if (r.justLocked) {
          onLog(`[ERROR] Shared ${id}${inviter} now locked - ${r.reason}`);
        }
      }
    } catch (err) {
      onLog(`[ERROR] Loop tick failed: ${err.message}`);
    } finally {
      isTicking = false;
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  runningLoops.set(accountKey, handle);
  return true;
}

function stop(accountKey) {
  const handle = runningLoops.get(accountKey);
  if (!handle) return false;
  clearInterval(handle);
  runningLoops.delete(accountKey);
  return true;
}

function stopAll() {
  for (const [accountKey, handle] of runningLoops) {
    clearInterval(handle);
    runningLoops.delete(accountKey);
  }
}

module.exports = { isRunning, start, stop, stopAll };
