const { SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("login")
    .setDescription("Login to XCloudPhone")
    .addStringOption((o) => o.setName("username").setDescription("Username").setRequired(true))
    .addStringOption((o) => o.setName("password").setDescription("Password").setRequired(true))
    .addStringOption((o) => o.setName("userdeviceid").setDescription("User Device ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start keep-alive loop for your account"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the running loop"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show session status"),

  new SlashCommandBuilder()
    .setName("devices")
    .setDescription("List rental devices and remaining time"),

  new SlashCommandBuilder()
    .setName("extend")
    .setDescription("Manually extend a rental session")
    .addStringOption((o) =>
      o.setName("sessionid").setDescription("Session to extend (autocomplete from cached devices)").setRequired(true).setAutocomplete(true)
    )
    .addIntegerOption((o) =>
      o.setName("hours").setDescription("Hours to extend, 0-5 (0 or omitted = default 1)").setRequired(false).setMinValue(0).setMaxValue(5)
    ),

  new SlashCommandBuilder()
    .setName("account")
    .setDescription("Show info about your logged-in account"),

  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete your logged-in account and remove its saved session"),
];

const commandsJSON = commands.map((c) => c.toJSON());

module.exports = { commands, commandsJSON };
