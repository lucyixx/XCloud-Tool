const _log = console.log.bind(console);
const _error = console.error.bind(console);
console.log = (...args) => _log(`[${new Date().toISOString()}]`, ...args);
console.error = (...args) => _error(`[${new Date().toISOString()}]`, ...args);

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  REST,
  Routes,
  EmbedBuilder,
  Colors,
} = require("discord.js");
const config = require("./config");
const {
  login,
  checkSession,
  getRentalSessions,
  getSharedSessions,
  extendSession,
  clearCookies,
  clearFailEntries,
  MAX_FAIL,
} = require("./api");
const store = require("./store");
const runner = require("./runner");
const { commandsJSON } = require("./commands");

if (!config.BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}

const path = require("path");
const fs = require("fs");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const HEARTBEAT_FILE = path.join(__dirname, "..", "data", "heartbeat");

function writeHeartbeat() {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {}
}

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

client.on(Events.Error, (err) => console.error("[DISCORD ERROR]", err));
client.on(Events.ShardError, (err) => console.error("[DISCORD SHARD ERROR]", err));

function lines(pairs) {
  return pairs.map(([label, value]) => `${label} : ${value}`).join("\n");
}

function embed(color, title, description) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (description) e.setDescription(description);
  return e;
}

const ok   = (title, desc) => embed(Colors.Green,    title, desc);
const fail = (title, desc) => embed(Colors.Red,       title, desc);
const warn = (title, desc) => embed(Colors.Yellow,    title, desc);
const info = (title, desc) => embed(config.COLOR_BOT, title, desc);

function reply(interaction, color, title, description, ephemeral = true) {
  const payload = { embeds: [embed(color, title, description)] };
  if (ephemeral) payload.flags = MessageFlags.Ephemeral;
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply(payload);
}

function getAccountData(uid) {
  const usernames = store.listUsernames(uid);
  if (usernames.length === 0) return { error: "You have no logged-in account. Use /login first." };
  const username = usernames[0];
  const account = store.getAccount(uid, username);
  return { username, account, accountKey: `${uid}:${username}` };
}

async function sendLog(discordUserId, username, msg) {
  const account = store.getAccount(discordUserId, username);
  const channelId = account?.logChannelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({ content: `\`${msg}\`` });
  } catch {}
}

async function registerCommands(c) {
  const clientId = client.application?.id || client.user?.id;
  if (!clientId) return;
  const rest = new REST().setToken(config.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commandsJSON });
    console.log(`Logged in as ${c.user.tag}. Slash commands registered.`);
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

client.once(Events.ClientReady, async (c) => {
  await registerCommands(c);
  await resumeRunningAccounts();
  writeHeartbeat();
  setInterval(writeHeartbeat, 30_000);
});

async function resumeRunningAccounts() {
  for (const { discordUserId, username, account } of store.listAllRunningAccounts()) {
    const accountKey = `${discordUserId}:${username}`;
    if (runner.isRunning(accountKey)) continue;
    if (typeof account.username !== "string" || typeof account.password !== "string") {
      store.setAccount(discordUserId, username, { running: false });
      continue;
    }
    runner.start(
      accountKey,
      account,
      (msg) => sendLog(discordUserId, username, msg),
      config.POLL_INTERVAL_MS
    );
    console.log(`Resumed loop for ${username} (discord: ${discordUserId})`);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
  if (!interaction.isChatInputCommand()) return;
  const uid = interaction.user.id;

  try {
    switch (interaction.commandName) {
      case "login":   return await handleLogin(interaction, uid);
      case "start":   return await handleStart(interaction, uid);
      case "stop":    return await handleStop(interaction, uid);
      case "status":  return await handleStatus(interaction, uid);
      case "devices": return await handleDevices(interaction, uid);
      case "extend":  return await handleExtend(interaction, uid);
      case "account": return await handleAccount(interaction, uid);
      case "delete":  return await handleDelete(interaction, uid);
    }
  } catch (err) {
    console.error("Command error:", err);
    await reply(interaction, Colors.Red, "Unexpected Error", err.message).catch(() => {});
  }
});

async function handleAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    const uid = interaction.user.id;

    if (focused.name === "sessionid") {
      const { username, error } = getAccountData(uid);
      if (error) return interaction.respond([]);

      const cached = store.getSessionCache(uid, username);
      const allSessions = cached.map((s) => ({
        name: `${s.label}${s.remainMinutes != null ? ` (${s.remainMinutes}m)` : ""}`,
        value: s.id,
      }));

      const query = String(focused.value).toLowerCase();
      const filtered = allSessions
        .filter((s) => s.name.toLowerCase().includes(query) || s.value.toLowerCase().includes(query))
        .slice(0, 25);

      return interaction.respond(filtered);
    }

    await interaction.respond([]);
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}

async function handleLogin(interaction, uid) {
  const username     = interaction.options.getString("username", true);
  const password     = interaction.options.getString("password", true);
  const userDeviceId = interaction.options.getString("userdeviceid", true);
  const accountKey   = `${uid}:${username}`;

  const existing = store.getAccount(uid, username);
  if (existing?.loggedIn) {
    const { valid } = await checkSession(accountKey);
    if (valid) {
      const devices = await getRentalSessions(accountKey);
      store.saveSessionCache(uid, username, devices);
      return reply(
        interaction,
        Colors.Blurple,
        "Already Logged In",
        lines([
          ["Username", existing.username],
          ["Devices", devices.length],
        ])
      );
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await login(accountKey, { username, password, userDeviceId });

  if (!result.success) {
    return interaction.editReply({
      embeds: [
        fail(
          "Login Failed",
          lines(
            result.status
              ? [["Reason", result.error], ["Status", result.status]]
              : [["Reason", result.error]]
          )
        ),
      ],
    });
  }

  const user = result.data.user;
  const returnedDeviceId = result.data.userDeviceId || userDeviceId;

  store.setAccount(uid, username, {
    username: user.username,
    password,
    userDeviceId: returnedDeviceId,
    loggedInAt: new Date().toISOString(),
    loggedIn: true,
  });

  const devices = await getRentalSessions(accountKey);
  store.saveSessionCache(uid, username, devices);

  console.log(`Login OK: ${user.username} (discord: ${interaction.user.tag})`);

  return interaction.editReply({
    embeds: [
      ok(
        "Login Success",
        lines([
          ["Username", user.username],
          ["Devices", devices.length],
        ])
      ),
    ],
  });
}

async function handleStart(interaction, uid) {
  const { username, account, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "Not Logged In", error);

  const intervalSec = Math.round(config.POLL_INTERVAL_MS / 1000);

  if (runner.isRunning(accountKey)) {
    return reply(
      interaction,
      config.COLOR_BOT,
      "Already Running",
      lines([["Username", username], ["Status", "Running"]])
    );
  }

  const started = runner.start(
    accountKey,
    account,
    (msg) => sendLog(uid, username, msg),
    config.POLL_INTERVAL_MS
  );

  if (!started) {
    return reply(interaction, Colors.Red, "Start Failed", "Could not start the loop. Please try again.");
  }

  store.setAccount(uid, username, {
    running: true,
    startedAt: new Date().toISOString(),
    logChannelId: interaction.channelId,
  });

  return reply(
    interaction,
    Colors.Green,
    "Loop Started",
    lines([["Username", username], ["Interval", `${intervalSec}s`]]),
    false
  );
}

async function handleStop(interaction, uid) {
  const { username, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "Not Logged In", error);

  const stopped = runner.stop(accountKey);
  store.setAccount(uid, username, { running: false });

  if (stopped) {
    return reply(interaction, Colors.Orange, "Loop Stopped", lines([["Username", username]]), false);
  }

  return reply(interaction, Colors.Yellow, "Not Running", lines([["Username", username]]));
}

async function handleStatus(interaction, uid) {
  const { username, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "No Session", error);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { valid } = await checkSession(accountKey);
  const loopActive = runner.isRunning(accountKey);

  return interaction.editReply({
    embeds: [
      info(
        "Status",
        lines([
          ["Username", username],
          ["Cookie", valid ? "Valid" : "Expired"],
          ["Loop", loopActive ? "Running" : "Stopped"],
        ])
      ),
    ],
  });
}

async function handleDevices(interaction, uid) {
  const { username, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "Not Logged In", error);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [devices, sharedSessions] = await Promise.all([
    getRentalSessions(accountKey),
    getSharedSessions(accountKey),
  ]);
  store.saveSessionCache(uid, username, devices);

  if (!devices.length && !sharedSessions.length) {
    return interaction.editReply({ embeds: [info("No Devices", "No active rental sessions found.")] });
  }

  const sections = [];

  if (devices.length) {
    const mainBody = devices
      .slice(0, 10)
      .map((d) =>
        lines([
          ["Name", d.sessionName || d.id],
          ["ID", d.id],
          ["Remaining", d.remainMinutes != null ? `${d.remainMinutes}m` : "N/A"],
        ])
      )
      .join("\n\n");
    sections.push(`**── Main Devices (${devices.length}) ──**\n${mainBody}`);
  }

  if (sharedSessions.length) {
    const sharedBody = sharedSessions
      .slice(0, 10)
      .map((s) =>
        lines([
          ["Name", s.sessionName || s.sessionId || s.inviteId],
          ["ID", s.sessionId || "N/A"],
          ["Remaining", s.remainMinutes != null ? `${s.remainMinutes}m` : "N/A"],
          ["From", s.inviterUsername || "Unknown"],
        ])
      )
      .join("\n\n");
    sections.push(`**── Shared Devices (${sharedSessions.length}) ──**\n${sharedBody}`);
  }

  const totalCount = devices.length + sharedSessions.length;
  return interaction.editReply({ embeds: [info(`Devices : ${totalCount}`, sections.join("\n\n"))] });
}

async function handleExtend(interaction, uid) {
  const { username, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "Not Logged In", error);

  const sessionId = interaction.options.getString("sessionid", true);

  const hoursOption = interaction.options.getInteger("hours");
  let hours = hoursOption == null || hoursOption === 0 ? config.EXTEND_RENTAL_HOURS : hoursOption;
  hours = Math.min(hours, 5);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const cached = store.getSessionCache(uid, username);
  const sessionInfo = cached.find((s) => s.id === sessionId);
  const remainMinutes = sessionInfo?.remainMinutes ?? null;

  const result = await extendSession(accountKey, sessionId, remainMinutes, hours);

  if (result.ok) {
    const devices = await getRentalSessions(accountKey);
    store.saveSessionCache(uid, username, devices);

    return interaction.editReply({
      embeds: [
        ok(
          "Extended",
          lines([
            ["Session ID", sessionId],
            ["Hours", `+${hours}h`],
            ["Price", result.price ?? "?"],
          ])
        ),
      ],
    });
  }

  if (result.overLimit) {
    return interaction.editReply({
      embeds: [
        warn(
          "Extend Skipped",
          lines([
            ["Session ID", sessionId],
            ["Reason", result.reason],
            ...(remainMinutes != null ? [["Remaining", `${remainMinutes}m`]] : []),
          ])
        ),
      ],
    });
  }

  if (result.locked) {
    return interaction.editReply({
      embeds: [
        fail(
          "Extend Locked",
          lines([
            ["Session ID", sessionId],
            ["Reason", `Locked after ${MAX_FAIL} consecutive failures`],
          ])
        ),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      warn(
        "Extend Failed",
        lines([
          ["Session ID", sessionId],
          ["Reason", result.reason],
          ["Failures", `${result.failCount}/${MAX_FAIL}`],
          ...(result.justLocked ? [["Note", "Session is now locked"]] : []),
        ])
      ),
    ],
  });
}

async function handleAccount(interaction, uid) {
  const { username, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "No Account", error);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const account = store.getAccount(uid, username);
  const { valid } = await checkSession(accountKey);
  const loopActive = runner.isRunning(accountKey);

  return interaction.editReply({
    embeds: [
      info(
        "Account",
        lines([
          ["Username", username],
          ["Logged In At", account?.loggedInAt ?? "N/A"],
          ["Cookie", valid ? "Valid" : "Expired"],
          ["Loop", loopActive ? "Running" : "Stopped"],
        ])
      ),
    ],
  });
}

async function handleDelete(interaction, uid) {
  const { username, accountKey, error } = getAccountData(uid);
  if (error) return reply(interaction, Colors.Yellow, "No Account", error);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  runner.stop(accountKey);

  const devices = await getRentalSessions(accountKey);
  clearFailEntries(devices.map((d) => d.id));

  clearCookies(accountKey);
  store.clearAccount(uid, username);

  console.log(`Account deleted: ${username} (discord: ${interaction.user.tag})`);

  return interaction.editReply({ embeds: [ok("Account Deleted", lines([["Username", username]]))] });
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  runner.stopAll();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(config.BOT_TOKEN);
