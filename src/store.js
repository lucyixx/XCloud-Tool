const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "sessions.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}), "utf-8");
}

function migrateEntry(entry) {
  if (entry && !entry.accounts && entry.username) {
    return { accounts: { [entry.username]: { ...entry } } };
  }
  return entry && entry.accounts ? entry : { accounts: {} };
}

function readAll() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8") || "{}");
    let changed = false;
    for (const uid of Object.keys(parsed)) {
      const migrated = migrateEntry(parsed[uid]);
      if (migrated !== parsed[uid]) changed = true;
      parsed[uid] = migrated;
    }
    if (changed) writeAll(parsed);
    return parsed;
  } catch (err) {
    const backupPath = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DATA_FILE, backupPath);
      console.error(`sessions.json bị lỗi parse, đã backup sang ${backupPath}: ${err.message}`);
    } catch {}
    return {};
  }
}

function writeAll(sessions) {
  ensureDataFile();
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), "utf-8");
  fs.renameSync(tmpFile, DATA_FILE);
}

function listAccounts(discordUserId) {
  return readAll()[discordUserId]?.accounts || {};
}

function listUsernames(discordUserId) {
  return Object.keys(listAccounts(discordUserId));
}

function getAccount(discordUserId, username) {
  return listAccounts(discordUserId)[username] || null;
}

function setAccount(discordUserId, username, data) {
  const sessions = readAll();
  if (!sessions[discordUserId]) sessions[discordUserId] = { accounts: {} };
  if (!sessions[discordUserId].accounts) sessions[discordUserId].accounts = {};
  sessions[discordUserId].accounts[username] = {
    ...(sessions[discordUserId].accounts[username] || {}),
    ...data,
  };
  writeAll(sessions);
  return sessions[discordUserId].accounts[username];
}

function listAllRunningAccounts() {
  const all = readAll();
  const result = [];
  for (const discordUserId of Object.keys(all)) {
    const accounts = all[discordUserId]?.accounts || {};
    for (const username of Object.keys(accounts)) {
      if (accounts[username]?.running) {
        result.push({ discordUserId, username, account: accounts[username] });
      }
    }
  }
  return result;
}

function clearAccount(discordUserId, username) {
  const sessions = readAll();
  if (sessions[discordUserId]?.accounts) {
    delete sessions[discordUserId].accounts[username];
  }
  writeAll(sessions);
}

function saveSessionCache(discordUserId, username, sessions) {
  const sessionCache = sessions.map((s) => ({
    id: s.id,
    label: s.sessionName || s.shortId || s.id.slice(0, 8),
    remainMinutes: s.remainMinutes,
  }));
  setAccount(discordUserId, username, { sessionCache });
}

function getSessionCache(discordUserId, username) {
  return getAccount(discordUserId, username)?.sessionCache || [];
}

function saveSharedSessionCache(discordUserId, username, sharedSessions) {
  const sharedSessionCache = sharedSessions
    .filter((s) => s.sessionId)
    .map((s) => ({
      id: s.sessionId,
      label: s.sessionName || s.shortId || s.sessionId.slice(0, 8),
      remainMinutes: s.remainMinutes,
    }));
  setAccount(discordUserId, username, { sharedSessionCache });
}

function getSharedSessionCache(discordUserId, username) {
  return getAccount(discordUserId, username)?.sharedSessionCache || [];
}

module.exports = {
  listAccounts,
  listUsernames,
  getAccount,
  setAccount,
  clearAccount,
  listAllRunningAccounts,
  saveSessionCache,
  getSessionCache,
  saveSharedSessionCache,
  getSharedSessionCache,
};
