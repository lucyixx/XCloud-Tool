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

  const tick = async () => {
    if (isTicking) return;
    isTicking = true;
    try {
      const { valid, expired } = await checkSession(accountKey);

      if (!valid && expired) {
        onLog("[WARN] Session expired. Re-logging in...");
        const result = await login(accountKey, {
          username: account.username,
          password: account.password,
          userDeviceId: account.userDeviceId,
        });
        if (!result.success) {
          onLog(`[ERROR] Re-login failed: ${result.error}. Stopping loop.`);
          stop(accountKey);
          store.setAccount(discordUserId, username, { running: false });
          return;
        }
        onLog("[OK] Re-login successful. Continuing keep-alive.");
      }

      // Extend owned rental sessions
      const sessions = await getRentalSessions(accountKey);
      store.saveSessionCache(discordUserId, username, sessions);

      const results = await autoExtendExpiringSessions(accountKey, { sessions });
      for (const r of results) {
        const id = r.session.shortId || r.session.id?.slice(0, 8);
        if (r.overLimit) {
          onLog(`[INFO] Skip extend ${id} - ${r.reason}`);
        } else if (r.ok) {
          onLog(`[OK] Extended ${id} +${config.EXTEND_RENTAL_HOURS}h (price: ${r.price ?? "?"})`);
        } else if (r.locked) {
          onLog(`[WARN] ${id} locked after ${r.failCount ?? config.MAX_FAIL} failures`);
        } else if (r.justLocked) {
          onLog(`[ERROR] ${id} now locked - ${r.reason}`);
        } else {
          onLog(`[WARN] Extend failed ${id}: ${r.reason} (${r.failCount}/${config.MAX_FAIL})`);
        }
      }

      // Extend shared sessions (only those with sessionId)
      const sharedSessions = await getSharedSessions(accountKey);
      const sharedResults = await autoExtendExpiringSharedSessions(accountKey, { sessions: sharedSessions });
      for (const r of sharedResults) {
        const id = r.session.shortId || r.session.sessionId?.slice(0, 8);
        const inviter = r.session.inviterUsername ? ` (from ${r.session.inviterUsername})` : "";
        if (r.overLimit) {
          onLog(`[INFO] Skip shared extend ${id}${inviter} - ${r.reason}`);
        } else if (r.ok) {
          onLog(`[OK] Extended shared ${id}${inviter} +${config.EXTEND_RENTAL_HOURS}h (price: ${r.price ?? "?"})`);
        } else if (r.locked) {
          onLog(`[WARN] Shared ${id}${inviter} locked after ${r.failCount ?? config.MAX_FAIL} failures`);
        } else if (r.justLocked) {
          onLog(`[ERROR] Shared ${id}${inviter} now locked - ${r.reason}`);
        } else {
          onLog(`[WARN] Shared extend failed ${id}${inviter}: ${r.reason} (${r.failCount}/${config.MAX_FAIL})`);
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
