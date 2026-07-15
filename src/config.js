const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  POLL_INTERVAL_MS: 60_000,
  EXTEND_THRESHOLD_MINUTES: 240,
  EXTEND_RENTAL_HOURS: 1,
  EXTEND_SKIP_THRESHOLD: 240,
  MAX_FAIL: 3,
  COLOR_BOT: 0x5865f2,
};
