```javascript

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { pickBanatReply, rememberBanatReply } = require("./banat-memory");
const { chooseSocialResponse } = require("./banat-social");
const { startTyping, stopTyping, stopAllTyping } = require("./human-typing");
const { createGcCycle } = require("./gcname");
const commands = require("./commands");
const economy = require("./economy");

const PORT = Number(process.env.PORT) || 3000;
const DATA = process.env.DATA_DIR || __dirname;

fs.mkdirSync(DATA, { recursive: true });
economy.init(DATA, (who, msg) => console.log(`[${who}] ${msg}`));

function safeRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

const rnd = (a, b) => a + Math.random() * (b - a);

function num(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

const hasAdmin = () => Boolean(process.env.ADMIN_PASSWORD);

function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const checkPw = password =>
  hasAdmin() && safeEq(password || "", process.env.ADMIN_PASSWORD);

const CFG_FILE = path.join(DATA, "config.json");

const DEFAULTS = {
  appState: null,
  savedAt: null,
  stateRefreshedAt: null,
  autoReply: false,
  threadId: null,
  threads: [],
  running: false,
  speed: "fast",
  selfReact: true,
  selfReactRate: 0.15,
  markRead: true,
  skipMax: 4,
  senderCooldownS: 0,
  hourlyMax: 0,
  dailyMax: 0,
  threadMax: 0,
  threadWindowS: 300,
  awayBreaks: false,
  quiet: { on: false, start: "00:30", end: "07:30" },
  tz: process.env.BOT_TZ || "Asia/Manila",
  openers: ["hello", "uy"],
  profile: "unlimited-v1",
  troll: true,
  prefix: "!",
  admins: [],
  cmdCooldownS: 2,
  cmdHourlyMax: 0,
  fcaPackage: null,
  reminders: []
};

const MAX_UPTIME_MS = 48 * 60 * 60 * 1000;

const STEALTH_V1 = [
  "speed",
  "selfReact",
  "selfReactRate",
  "skipMax",
  "senderCooldownS",
  "hourlyMax",
  "dailyMax",
  "threadMax",
  "threadWindowS",
  "openers"
];

const cfg = Object.assign({}, DEFAULTS, safeRead(CFG_FILE));
cfg.quiet = Object.assign({}, DEFAULTS.quiet, cfg.quiet);

if (cfg.profile !== DEFAULTS.profile) {
  for (const key of STEALTH_V1) {
    cfg[key] = DEFAULTS[key];
  }

  cfg.quiet = Object.assign({}, DEFAULTS.quiet);
  cfg.profile = DEFAULTS.profile;

  try {
    writeAtomic(CFG_FILE, cfg);
  } catch {}
}

cfg.threads = (Array.isArray(cfg.threads) ? cfg.threads : []).map(String);

if (cfg.threadId && !cfg.threads.includes(String(cfg.threadId))) {
  cfg.threads.push(String(cfg.threadId));
}

cfg.threadId = null;

const save = () => {
  try {
    writeAtomic(CFG_FILE, cfg);
  } catch (error) {
    console.error("[save]", error.message);
  }
};

const envAdmins = new Set(
  String(process.env.ADMIN_IDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const S = {
  api: null,
  uid: null,
  online: false,
  running: false,
  logging: false,
  stopListen: null,
  manualOff: false,
  authDead: false,
  expired: false,
  started: Date.now(),
  botSince: null,
  lastConnected: null,
  lastDisconnected: null,
  attempts: 0,
  nextRetry: null,
  timer: null,
  listenTimer: null,
  listenFails: 0,
  pingFails: 0,
  lastEventAt: null,
  lastPing: null,
  nextPing: 0,
  lastStateJson: cfg.appState ? JSON.stringify(cfg.appState) : null,
  lastError: null,
  replies: [],
  daily: [],
  suppressed: 0,
  awayUntil: 0,
  fcaName: null,
  senders: new Map(),
  threads: new Map(),
  busy: new Set(),
  log: [],
  skipRun: new Map(),
  cmdSenders: new Map(),
  cmdHour: []
};

function log(who, msg) {
  S.log.unshift({
    t: Date.now(),
    who,
    msg: String(msg).slice(0, 300)
  });

  S.log.length = Math.min(S.log.length, 80);
  console.log(`[${who}] ${msg}`);
}

const isAdminId = id =>
  String(id) === String(S.uid) ||
  envAdmins.has(String(id)) ||
  (cfg.admins || []).map(String).includes(String(id));

const RAW_POOL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "replies.json"), "utf8")
);

const POOLS = Array.isArray(RAW_POOL)
  ? { default: RAW_POOL }
  : RAW_POOL;

const ALL_REPLIES = [
  ...new Set(Object.values(POOLS).flat().filter(value => typeof value === "string"))
];

const poolKey = type =>
  Array.isArray(POOLS[type]) && POOLS[type].length
    ? type
    : "default";

const poolFor = type => {
  const pool = POOLS[poolKey(type)];
  return Array.isArray(pool) && pool.length ? pool : ALL_REPLIES;
};

function parseCookie(raw) {
  raw = String(raw || "").trim();

  const cookies = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw.split(";")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
          const index = part.indexOf("=");

          if (index < 1) {
            throw new Error("Invalid cookie");
          }

          return {
            key: part.slice(0, index),
            value: part.slice(index + 1),
            domain: "facebook.com",
            path: "/",
            hostOnly: false
          };
        });

  if (!Array.isArray(cookies)) {
    throw new Error("Cookie must be an array");
  }

  const keys = new Set(cookies.map(cookie => cookie.key || cookie.name));

  if (!keys.has("c_user") || !keys.has("xs")) {
    throw new Error("Missing required cookies");
  }

  return cookies;
}

if (!cfg.appState) {
  try {
    const raw =
      process.env.APPSTATE ||
      (fs.existsSync(path.join(DATA, "appstate.json"))
        ? fs.readFileSync(path.join(DATA, "appstate.json"), "utf8")
        : "");

    if (raw) {
      cfg.appState = parseCookie(raw);
      cfg.savedAt = Date.now();
      S.lastStateJson = JSON.stringify(cfg.appState);
      save();
      log("system", "Session loaded");
    }
  } catch (error) {
    log("error", `Session loading failed: ${error.message}`);
  }
}

function localMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: cfg.tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const hour = Number(parts.find(part => part.type === "hour").value) % 24;
  const minute = Number(parts.find(part => part.type === "minute").value);

  return hour * 60 + minute;
}

const toMin = value => {
  const [hour, minute] = String(value || "0:0").split(":").map(Number);
  return (hour || 0) * 60 + (minute || 0);
};

function inQuiet() {
  if (!cfg.quiet.on) return false;

  try {
    const current = localMinutes();
    const start = toMin(cfg.quiet.start);
    const end = toMin(cfg.quiet.end);

    return start <= end
      ? current >= start && current < end
      : current >= start || current < end;
  } catch {
    return false;
  }
}

const AUTH_RE =
  /checkpoint|not logged in|login[_ ]?(approval|blocked)|expired|appstate|retrieving userid|unknown location|suspended|disabled|locked|invalid.*(cookie|session)/i;

const isAuthError = error =>
  AUTH_RE.test(String(error?.error || error?.message || error || ""));

function captureState(reason) {
  if (!S.api || typeof S.api.getAppState !== "function") return;

  try {
    const state = S.api.getAppState();

    if (!Array.isArray(state) || !state.length) return;

    const json = JSON.stringify(state);
    if (json === S.lastStateJson) return;

    if (cfg.appState) {
      try {
        writeAtomic(path.join(DATA, "appstate.backup.json"), cfg.appState);
      } catch {}
    }

    S.lastStateJson = json;
    cfg.appState = state;
    cfg.stateRefreshedAt = Date.now();
    save();

    log("session", `Session state refreshed (${reason})`);
  } catch (error) {
    log("error", `Session refresh: ${error.message}`);
  }
}

function stopListening() {
  const listener = S.stopListen;
  S.stopListen = null;
  clearTimeout(S.listenTimer);

  try {
    if (typeof listener === "function") listener();
    else if (listener?.stopListening) listener.stopListening();
    else if (listener?.stop) listener.stop();
  } catch {}
}

function teardown() {
  stopListening();
  stopAllTyping();
  S.api = null;
  S.online = false;
  S.busy.clear();
}

async function probeNet() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("https://www.facebook.com/favicon.ico", {
      method: "HEAD",
      signal: controller.signal
    });

    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function realMarkAuthDead(error) {
  S.authDead = true;
  S.lastError =
    "Session expired or requires checkpoint. Update the session before reconnecting.";

  log("watchdog", `Authentication issue: ${String(error?.message || error).slice(0, 100)}`);

  teardown();
  S.lastDisconnected = Date.now();
  clearTimeout(S.timer);

  S.nextRetry = Date.now() + 30 * 60 * 1000;

  S.timer = setTimeout(() => {
    if (S.manualOff || S.expired) return;
    S.authDead = false;
    connect();
  }, 30 * 60 * 1000);
}

function markAuthDead(error) {
  probeNet()
    .then(up => {
      if (up) return realMarkAuthDead(error);

      netUp = false;
      netDownAt = Date.now();
      netMiss = 2;

      S.lastError = "Network unavailable; waiting for connectivity.";
      log("watchdog", "Network outage detected");

      if (S.api) drop();
      else scheduleRetry();
    })
    .catch(() => realMarkAuthDead(error));
}

function loadFca() {
  const names = [
    process.env.FCA_PACKAGE,
    cfg.fcaPackage,
    "@dongdev/fca-unofficial"
  ].filter(Boolean);

  const tried = [];

  for (const name of [...new Set(names)]) {
    try {
      const mod = require(name);
      const login =
        typeof mod === "function" ? mod : mod && (mod.login || mod.default);

      if (typeof login === "function") {
        S.fcaName = name;
        return login;
      }

      tried.push(`${name}: missing login export`);
    } catch (error) {
      tried.push(`${name}: ${String(error.message).split("\n")[0]}`);
    }
  }

  log("error", `FCA unavailable: ${tried.join(" | ")}`);
  return null;
}

function connect() {
  if (S.expired || S.logging || !cfg.appState || S.authDead || S.manualOff) return;

  clearTimeout(S.timer);
  S.nextRetry = null;
  S.logging = true;

  const login = loadFca();

  if (!login) {
    S.logging = false;
    S.lastError = "FCA library unavailable";
    return scheduleRetry();
  }

  login(
    { appState: cfg.appState },
    {
      online: true,
      selfListen: true,
      listenEvents: true,
      autoMarkRead: false,
      logLevel: "error"
    },
    (error, api) => {
      S.logging = false;

      if (error) {
        S.lastError = String(error.message || error.error || error);
        log("error", `Login failed: ${S.lastError}`);

        return isAuthError(error)
          ? markAuthDead(error)
          : scheduleRetry();
      }

      S.api = api;
      S.uid = String(api.getCurrentUserID());
      S.online = true;
      S.attempts = 0;
      S.listenFails = 0;
      S.pingFails = 0;
      S.lastConnected = Date.now();
      S.lastError = null;
      S.authDead = false;
      S.nextPing = Date.now() + rnd(10, 20) * 60 * 1000;

      log("system", `Messenger connected (${S.fcaName})`);
      captureState("login");

      if (cfg.running && !S.running) {
        S.running = true;
        S.botSince = Date.now();
        log("bot", "Resumed after reconnect");
      }

      startListen();
      gc.resume();
    }
  );
}

function startListen() {
  if (!S.api || S.expired) return;

  stopListening();

  S.stopListen = S.api.listenMqtt((error, event) => {
    if (error) return onListenError(error);

    S.listenFails = 0;
    S.lastEventAt = Date.now();

    onEvent(event).catch(error =>
      log("error", `Event handler: ${error?.message || error}`)
    );
  });
}

function onListenError(error) {
  log("error", `Listener: ${error.message || error.error || error}`);

  if (isAuthError(error)) return markAuthDead(error);

  S.listenFails++;

  if (S.listenFails <= 3) {
    clearTimeout(S.listenTimer);

    S.listenTimer = setTimeout(
      startListen,
      4000 * S.listenFails + rnd(0, 2000)
    );

    return;
  }

  drop();
}

function drop() {
  teardown();
  S.lastDisconnected = Date.now();
  scheduleRetry();
}

function scheduleRetry() {
  if (!cfg.appState || S.manualOff || S.authDead || S.expired) return;

  S.attempts++;

  let seconds = Math.min(300, 8 * 2 ** (S.attempts - 1)) + rnd(0, 5);

  if (S.attempts > 10) {
    seconds = 1800;
    S.attempts = 0;
    log("watchdog", "Retry limit reached; next retry in 30 minutes");
  } else {
    log("watchdog", `Reconnect scheduled in ${Math.round(seconds)} seconds`);
  }

  S.nextRetry = Date.now() + seconds * 1000;
  clearTimeout(S.timer);
  S.timer = setTimeout(connect, seconds * 1000);
}

function disconnect() {
  S.manualOff = true;
  clearTimeout(S.timer);
  teardown();

  S.running = false;
  cfg.running = false;
  save();

  S.lastDisconnected = Date.now();
  S.nextRetry = null;
}

function ping() {
  if (!S.api || typeof S.api.getThreadList !== "function") return;

  S.api.getThreadList(1, null, ["INBOX"], error => {
    if (!error) {
      S.pingFails = 0;
      S.lastPing = Date.now();
      return;
    }

    if (isAuthError(error)) return markAuthDead(error);

    if (++S.pingFails >= 3) {
      log("watchdog", "Health check failed; reconnecting");
      S.pingFails = 0;
      drop();
    }
  });
}

setInterval(() => {
  if (!S.api || S.expired) return;

  captureState("periodic");

  if (Date.now() >= S.nextPing) {
    S.nextPing = Date.now() + rnd(20, 40) * 60 * 1000;
    ping();
  }
}, 5 * 60 * 1000);

let netUp = true;
let netDownAt = 0;
let netMiss = 0;

setInterval(async () => {
  if (!cfg.appState || S.manualOff || S.expired) return;

  const up = await probeNet();

  if (!up) {
    if (++netMiss >= 2 && netUp) {
      netUp = false;
      netDownAt = Date.now();
      S.lastError = "Network unavailable; waiting for connectivity.";
      log("watchdog", "Network disconnected");
    }

    return;
  }

  netMiss = 0;

  if (netUp) return;

  netUp = true;
  S.lastError = null;

  log(
    "watchdog",
    `Network restored after ${Math.round((Date.now() - netDownAt) / 1000)} seconds`
  );

  if (S.authDead) return;

  if (S.api) {
    S.listenFails = 0;
    startListen();
    S.nextPing = Date.now() + 5000;
  } else if (!S.logging) {
    S.attempts = 0;
    clearTimeout(S.timer);
    connect();
  }

  gc.resume();
}, 30 * 1000);

if (process.env.SELF_URL) {
  setInterval(() => {
    fetch(`${String(process.env.SELF_URL).replace(/\/+$/, "")}/health`)
      .catch(() => {});
  }, 4 * 60 * 1000);
}

const sendRaw = (api, text, threadID, callback, replyTo) =>
  api.sendMessage(text, threadID, callback, replyTo || undefined);

function sendAssistant(threadID, message, replyTo = null, incomingText = "") {
  if (!S.api) return Promise.resolve(false);

  return sendBanatReplyWithTyping(S.api, message, threadID, replyTo, {
    trafficSendMessage: sendRaw,
    incomingText,
    speed: "fast",
    selfReact: false,
    humanize: false
  });
}

const gc = createGcCycle({
  getApi: () => S.api,
  cfg,
  save,
  log,
  isAuthError,
  onAuthError: markAuthDead
});

commands.startReminderLoop({
  cfg,
  save,
  ready: () => Boolean(S.api),
  send: (threadID, message) => sendAssistant(threadID, message)
});

function allowed(event) {
  const now = Date.now();

  S.replies = S.replies.filter(time => now - time < 3600 * 1000);
  S.daily = S.daily.filter(time => now - time < 86400 * 1000);

  if (
    (cfg.hourlyMax > 0 && S.replies.length >= cfg.hourlyMax) ||
    (cfg.dailyMax > 0 && S.daily.length >= cfg.dailyMax)
  ) {
    return false;
  }

  if (
    cfg.senderCooldownS > 0 &&
    now - (S.senders.get(event.senderID) || 0) < cfg.senderCooldownS * 1000
  ) {
    return false;
  }

  const threadHistory = (S.threads.get(event.threadID) || [])
    .filter(time => now - time < cfg.threadWindowS * 1000);

  S.threads.set(event.threadID, threadHistory);

  if (S.senders.size > 2000) {
    for (const [id, time] of S.senders) {
      if (now - time > 3600 * 1000) S.senders.delete(id);
    }
  }

  if (S.threads.size > 500) {
    for (const [id, history] of S.threads) {
      if (!history.length) S.threads.delete(id);
    }
  }

  return !(cfg.threadMax > 0) || threadHistory.length < cfg.threadMax;
}

const isTarget = event =>
  cfg.autoReply || cfg.threads.includes(String(event.threadID));

async function handleCommand(event, parsed) {
  const command = commands.resolve(parsed.name);
  if (!command) return;

  const admin = isAdminId(event.senderID);

  if (command.admin && !admin) return;

  if (!admin) {
    if (!S.running || !isTarget(event)) return;

    const now = Date.now();

    S.cmdHour = S.cmdHour.filter(time => now - time < 3600 * 1000);

    if (cfg.cmdHourlyMax > 0 && S.cmdHour.length >= cfg.cmdHourlyMax) return;

    if (
      now - (S.cmdSenders.get(event.senderID) || 0) <
      cfg.cmdCooldownS * 1000
    ) {
      return;
    }

    S.cmdSenders.set(event.senderID, now);
    S.cmdHour.push(now);

    if (S.cmdSenders.size > 1000) {
      for (const [id, time] of S.cmdSenders) {
        if (now - time > 3600 * 1000) S.cmdSenders.delete(id);
      }
    }
  }

  const api = S.api;
  if (!api) return;

  if (
    cfg.markRead &&
    typeof api.markAsRead === "function" &&
    String(event.senderID) !== S.uid
  ) {
    try {
      api.markAsRead(event.threadID, true, () => {});
    } catch {}
  }

  startTyping(api, event.threadID);

  let reply;

  try {
    reply = await command.run({
      args: parsed.args,
      ev: event,
      cfg,
      save,
      gc,
      S,
      prefix: cfg.prefix,
      isAdmin: admin
    });
  } catch (error) {
    log("error", `Command ${parsed.name}: ${error.message}`);
    reply = "May error sa command na yan 😭 Subukan ulit mamaya.";
  }

  if (!reply) {
    stopTyping(api, event.threadID);
    return;
  }

  const message = typeof reply === "string" ? { body: reply } : reply;
  const cleanup = message.cleanup;
  delete message.cleanup;

  try {
    const ok = await sendAssistant(
      event.threadID,
      message,
      event.messageID || null,
      event.body
    );

    log(
      "cmd",
      `${cfg.prefix}${parsed.name} -> ${event.threadID}${ok ? "" : " (send failed)"}`
    );
  } finally {
    if (typeof cleanup === "function") cleanup();
    stopTyping(api, event.threadID);
  }
}

async function onEvent(event) {
  if (S.expired) return;

  if (
    !event ||
    (event.type !== "message" && event.type !== "message_reply") ||
    !event.body
  ) {
    return;
  }

  const parsed = commands.parse(event.body, cfg.prefix || "!");
  const isCommand = Boolean(parsed && commands.resolve(parsed.name));
  const own = String(event.senderID) === S.uid;

  if (own && !isCommand) return;

  if (isCommand) return handleCommand(event, parsed);

  if (!S.running || !cfg.troll) return;
  if (!isTarget(event) || inQuiet()) return;
  if (Date.now() < S.awayUntil) return;

  const skipCount = S.skipRun.get(event.threadID) || 0;
  const maxSkips = Math.min(4, Math.max(0, Number(cfg.skipMax) || 0));

  if (skipCount < maxSkips && Math.random() < 0.5) {
    S.skipRun.set(event.threadID, skipCount + 1);
    return;
  }

  if (S.busy.has(event.threadID)) return;

  if (!allowed(event)) {
    S.suppressed++;
    return;
  }

  const api = S.api;
  if (!api) return;

  S.busy.add(event.threadID);
  S.skipRun.set(event.threadID, 0);

  if (S.skipRun.size > 500) S.skipRun.clear();

  try So before declaring the session dead, check that the internet is actually up. If it isn't,
// treat it as an outage: keep everything ON and just keep retrying until the net returns.
function markAuthDead(e) {
  probeNet().then((up) => {
    if (up) return realMarkAuthDead(e);
    if (netUp) { netUp = false; netDownAt = Date.now(); netMiss = 2; }
    S.lastError = "Walang internet — nakaabang pa rin, kusang babalik.";
    log("watchdog", "error during internet outage, NOT a dead session: " + String((e && (e.error || e.message)) || e).slice(0, 80));
    if (S.api) drop(); else scheduleRetry();
  }).catch(() => realMarkAuthDead(e));
}
function realMarkAuthDead(e) {
  S.authDead = true;
  S.lastError = "Session expired / checkpoint — paste a fresh cookie. (" + String((e && (e.error || e.message)) || e).slice(0, 120) + ")";
  log("watchdog", "auth problem: fast retry paused, will probe again in 30 min");
  teardown(); S.lastDisconnected = Date.now(); clearTimeout(S.timer);
  S.nextRetry = Date.now() + 30 * 60e3;
  S.timer = setTimeout(() => { if (S.manualOff) return; S.authDead = false; connect(); }, 30 * 60e3);
}

// FCA library loader. Set FCA_PACKAGE (env) or "fcaPackage" (config.json) to use another
// fork (e.g. your lazymeta build). The bot only needs the standard fca API:
// login, listenMqtt, sendMessage, setTitle, sendTypingIndicator, getAppState, markAsRead...
function loadFca() {
  const names = [process.env.FCA_PACKAGE, cfg.fcaPackage, "@dongdev/fca-unofficial"].filter(Boolean);
  const tried = [];
  for (const name of [...new Set(names)]) {
    try {
      const mod = require(name);
      const login = typeof mod === "function" ? mod : mod && (mod.login || mod.default);
      if (typeof login === "function") { S.fcaName = name; return login; }
      tried.push(`${name} (no login export)`);
    } catch (e) { tried.push(`${name} (${String(e.message).split("\n")[0].slice(0, 80)})`); }
  }
  log("error", "fca library missing: " + tried.join(" | "));
  return null;
}

function connect() {
  if (S.expired || S.logging || !cfg.appState || S.authDead) return;
  clearTimeout(S.timer); S.nextRetry = null; S.logging = true;
  const login = loadFca();
  if (!login) { S.logging = false; S.lastError = "fca library not installed (npm i, or set FCA_PACKAGE)"; return scheduleRetry(); }

  // selfListen:true lets the owner (the bot account itself) type !admin commands in a chat.
  // Own non-command messages are ignored in onEvent.
  login({ appState: cfg.appState }, { online: true, selfListen: true, listenEvents: true, autoMarkRead: false, logLevel: "error" }, (err, api) => {
    S.logging = false;
    if (err) {
      S.lastError = String(err.message || err.error || err);
      log("error", "login: " + S.lastError);
      return isAuthError(err) ? markAuthDead(err) : scheduleRetry();
    }
    S.api = api; S.uid = String(api.getCurrentUserID()); S.online = true; S.attempts = 0; S.listenFails = 0; S.pingFails = 0;
    S.lastConnected = Date.now(); S.lastError = null; S.authDead = false; S.nextPing = Date.now() + rnd(10, 20) * 60e3;
    log("system", `Messenger connected as ${S.uid} (${S.fcaName})`);
    captureState("login");
    if (cfg.running && !S.running) { S.running = true; S.botSince = Date.now(); log("bot", "resumed after reconnect"); }
    startListen();
    gc.resume();                                     // GC name cycle picks up again if it was ON
  });
}

function startListen() {
  if (!S.api) return;
  stopListening();
  S.stopListen = S.api.listenMqtt((e, ev) => {
    if (e) return onListenError(e);
    S.listenFails = 0; S.lastEventAt = Date.now();
    onEvent(ev).catch((err) => log("error", "event: " + (err && err.message || err)));
  });
}
function onListenError(e) {
  log("error", "listen: " + (e.message || e.error || e));
  if (isAuthError(e)) return markAuthDead(e);
  S.listenFails++;
  if (S.listenFails <= 3) {                          // try to re-listen on the SAME login first; fresh logins look suspicious
    clearTimeout(S.listenTimer);
    S.listenTimer = setTimeout(startListen, 4000 * S.listenFails + rnd(0, 2000));
    return;
  }
  drop();
}
function drop() { teardown(); S.lastDisconnected = Date.now(); scheduleRetry(); }
function scheduleRetry() {                           // never gives up: backs off to 5 min, then every 30 min after 10 tries
  if (!cfg.appState || S.manualOff || S.authDead) return;
  S.attempts++;
  let s = Math.min(300, 8 * 2 ** (S.attempts - 1)) + rnd(0, 5);
  if (S.attempts > 10) { s = 1800; S.attempts = 0; log("watchdog", "10 tries failed. Will retry in 30 min"); }
  else log("watchdog", `reconnect #${S.attempts} in ${Math.round(s)}s`);
  S.nextRetry = Date.now() + s * 1000; clearTimeout(S.timer); S.timer = setTimeout(connect, s * 1000);
}
function disconnect() {
  S.manualOff = true; clearTimeout(S.timer); teardown();
  S.running = false; cfg.running = false; save(); S.lastDisconnected = Date.now(); S.nextRetry = null;
}

// Light health check every 20-40 min: detects a dead session early and keeps the cookie fresh.
function ping() {
  if (!S.api) return;
  S.api.getThreadList(1, null, ["INBOX"], (e) => {
    if (!e) { S.pingFails = 0; S.lastPing = Date.now(); return; }
    if (isAuthError(e)) return markAuthDead(e);
    if (++S.pingFails >= 3) { log("watchdog", "health check failed 3x, reconnecting"); S.pingFails = 0; drop(); }
  });
}
setInterval(() => {
  if (!S.api) return;
  captureState("periodic");
  if (Date.now() >= S.nextPing) { S.nextPing = Date.now() + rnd(20, 40) * 60e3; ping(); }
}, 5 * 60e3);

// Net watchdog: a dead network usually gives NO error on the MQTT socket, so without this the bot
// can sit "connected" but deaf for up to 40 min. Probe every 30s; when the net comes back after an
// outage, force a fresh listen (or an immediate reconnect) so auto-reply resumes within seconds.
let netUp = true, netDownAt = 0, netMiss = 0;
async function probeNet() {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try { await fetch("https://www.facebook.com/favicon.ico", { method: "HEAD", signal: ctl.signal }); return true; } // any HTTP answer = net is up
  catch { return false; } finally { clearTimeout(t); }
}
setInterval(async () => {
  if (!cfg.appState || S.manualOff) return;
  const up = await probeNet();
  if (!up) {
    if (++netMiss >= 2 && netUp) { netUp = false; netDownAt = Date.now(); S.lastError = "Walang internet — maghihintay, kusang babalik."; log("watchdog", "internet down"); }
    return;
  }
  netMiss = 0;
  if (netUp) return;
  netUp = true; S.lastError = null;
  log("watchdog", `internet back after ${Math.round((Date.now() - netDownAt) / 1000)}s — resuming`);
  if (S.authDead) return;
  if (S.api) { S.listenFails = 0; startListen(); S.nextPing = Date.now() + 5000; }   // fresh MQTT on the SAME login
  else if (!S.logging) { S.attempts = 0; clearTimeout(S.timer); connect(); }          // don't wait out the retry timer
  gc.resume();
}, 30e3);

// Optional: for hosts that sleep idle web services, set SELF_URL=https://your-app.example.com
if (process.env.SELF_URL) {
  setInterval(() => { fetch(String(process.env.SELF_URL).replace(/\/+$/, "") + "/health").catch(() => {}); }, 4 * 60e3);
}

// ---------- sending ----------
const sendRaw = (api, text, tid, cb, replyTo) => api.sendMessage(text, tid, cb, replyTo || undefined);

// Plain assistant send: typing indicator + short human delay, text/attachments sent exactly as written.
function sendAssistant(threadID, message, replyTo = null, incomingText = "") {
  if (!S.api) return Promise.resolve(false);
  return sendBanatReplyWithTyping(S.api, message, threadID, replyTo, {
    trafficSendMessage: sendRaw, incomingText, speed: "fast", selfReact: false, humanize: false,
  });
}

// ---------- GC name cycle ----------
const gc = createGcCycle({ getApi: () => S.api, cfg, save, log, isAuthError, onAuthError: markAuthDead });

commands.startReminderLoop({ cfg, save, ready: () => !!S.api, send: (tid, text) => sendAssistant(tid, text) });

// ---------- Bot ----------
function allowed(ev) {                               // anti-spam gate (troll replies only)
  const now = Date.now();
  S.replies = S.replies.filter((t) => now - t < 3600e3);
  S.daily = S.daily.filter((t) => now - t < 86400e3);
  if ((cfg.hourlyMax > 0 && S.replies.length >= cfg.hourlyMax) || (cfg.dailyMax > 0 && S.daily.length >= cfg.dailyMax)) return false;   // 0 = unlimited
  if (cfg.senderCooldownS > 0 && now - (S.senders.get(ev.senderID) || 0) < cfg.senderCooldownS * 1000) return false;
  const th = (S.threads.get(ev.threadID) || []).filter((t) => now - t < cfg.threadWindowS * 1000);
  S.threads.set(ev.threadID, th);
  if (S.senders.size > 2000) for (const [k, t] of S.senders) if (now - t > 3600e3) S.senders.delete(k);
  if (S.threads.size > 500) for (const [k, v] of S.threads) if (!v.length) S.threads.delete(k);
  return !(cfg.threadMax > 0) || th.length < cfg.threadMax;
}

const isTarget = (ev) => cfg.autoReply || cfg.threads.includes(String(ev.threadID));

async function handleCommand(ev, parsed) {
  const cmd = commands.resolve(parsed.name);
  if (!cmd) return;
  const admin = isAdminId(ev.senderID);
  if (cmd.admin && !admin) return;

  if (!admin) {                                      // public users: only in the target chat, rate limited
    if (!S.running || !isTarget(ev)) return;
    const now = Date.now();
    S.cmdHour = S.cmdHour.filter((t) => now - t < 3600e3);
    if (cfg.cmdHourlyMax > 0 && S.cmdHour.length >= cfg.cmdHourlyMax) return;
    if (now - (S.cmdSenders.get(ev.senderID) || 0) < cfg.cmdCooldownS * 1000) return;
    S.cmdSenders.set(ev.senderID, now); S.cmdHour.push(now);
    if (S.cmdSenders.size > 1000) for (const [k, t] of S.cmdSenders) if (now - t > 3600e3) S.cmdSenders.delete(k);
  }

  const api = S.api;
  if (!api) return;
  if (cfg.markRead && typeof api.markAsRead === "function" && String(ev.senderID) !== S.uid) {
    try { api.markAsRead(ev.threadID, true, () => {}); } catch {}
  }

  startTyping(api, ev.threadID);                     // "typing..." while the command works (music search, !ask...)
  let reply;
  try {
    reply = await cmd.run({ args: parsed.args, ev, cfg, save, gc, S, prefix: cfg.prefix, isAdmin: admin });
  } catch (e) {
    log("error", `cmd ${parsed.name}: ${e && e.message || e}`);
    reply = "May error sa command na yan 😭 subukan ulit mamaya.";
  }
  if (!reply) { stopTyping(api, ev.threadID); return; }

  const message = typeof reply === "string" ? { body: reply } : reply;
  const cleanup = message.cleanup; delete message.cleanup;
  const ok = await sendAssistant(ev.threadID, message, ev.messageID || null, ev.body);
  if (typeof cleanup === "function") cleanup();
  stopTyping(api, ev.threadID);
  log("cmd", `${cfg.prefix}${parsed.name} -> ${ev.threadID}${ok ? "" : " (send failed)"}`);
}

async function onEvent(ev) {
  if (S.expired) return;                             // 11h limit: dead, ignore everything (commands too)
  if (!ev || (ev.type !== "message" && ev.type !== "message_reply") || !ev.body) return;

  const parsed = commands.parse(ev.body, cfg.prefix || "!");
  const isCmd = !!(parsed && commands.resolve(parsed.name));
  const own = String(ev.senderID) === S.uid;

  if (own && !isCmd) return;                         // selfListen is on: never react to our own chatter
  if (isCmd) return handleCommand(ev, parsed);

  if (!S.running || !cfg.troll) return;
  if (!isTarget(ev) || inQuiet()) return;
  if (Date.now() < S.awayUntil) return;              // "away" break: a real person isn't glued to the phone
  // "Lazy" skipping: sometimes ignore a message, but NEVER more than skipMax in a row per chat,
  // so replies keep coming (at most skipMax messages go unanswered, then it always replies).
  const run = S.skipRun.get(ev.threadID) || 0;
  if (run < Math.min(4, Math.max(0, Number(cfg.skipMax) || 0)) && Math.random() < 0.5) { S.skipRun.set(ev.threadID, run + 1); return; }
  if (S.busy.has(ev.threadID)) return;               // don't talk over ourselves in the same chat
  if (!allowed(ev)) { S.suppressed++; return; }

  const api = S.api;
  if (!api) return;
  S.busy.add(ev.threadID);
  S.skipRun.set(ev.threadID, 0);                     // we are replying now: the skip streak starts over
  if (S.skipRun.size > 500) S.skipRun.clear();
  try {
    const social = chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
    const key = poolKey(social.type);
    const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "reply-pool:" + key);
    const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];

    const now = Date.now();
    S.replies.push(now); S.daily.push(now); S.senders.set(ev.senderID, now); S.threads.get(ev.threadID).push(now);

    if (cfg.markRead && typeof api.markAsRead === "function") {   // "seen" shortly after it arrives, like a person
      setTimeout(() => { try { api.markAsRead(ev.threadID, true, () => {}); } catch {} }, rnd(250, 1200));
    }

    const ok = await sendBanatReplyWithTyping(api, text, ev.threadID, null, {
      trafficSendMessage: sendRaw,
      incomingText: ev.body,
      speed: cfg.speed,
      selfReact: cfg.selfReact ? { rate: cfg.selfReactRate } : false,   // only reacts to its OWN replies
    });
    if (ok) {
      rememberBanatReply(ev.threadID, text, ev.senderID); log("bot", `reply [${social.type}] -> ${ev.threadID}`);
      if (cfg.awayBreaks && Math.random() < 0.06) { S.awayUntil = Date.now() + rnd(20, 90) * 60e3; log("bot", `away break ${Math.round((S.awayUntil - Date.now()) / 60e3)} min`); }
    }
  } finally { S.busy.delete(ev.threadID); }
}

async function startBot() {
  if (S.expired) return log("error", "11h limit reached");
  if (!S.online) return log("error", "Connect first");
  S.running = true; cfg.running = true; save(); S.botSince = Date.now(); log("bot", "started");
  cfg.threads.forEach((tid, i) => {                  // one opener per enabled GC, spread out so they don't land together
    setTimeout(() => {
      if (!S.api || !S.running) return;
      const o = cfg.openers[Math.floor(Math.random() * cfg.openers.length)];
      sendBanatReplyWithTyping(S.api, o, tid, null, { trafficSendMessage: sendRaw, incomingText: "", speed: cfg.speed, selfReact: false });
    }, i * rnd(4000, 9000));
  });
}

// ---------- HARD 11h LIMIT ----------
// Counts from server start (S.started). Nothing in the dashboard, config.json or env can change it.
// After 11h the bot is dead: logged out of Messenger, GC cycle stopped, and Start / Reconnect /
// !on / commands are all blocked. The process stays up (so the host does not auto-restart it
// and hand out a fresh 11h); only a redeploy/restart of the server starts a new window.
function expireNow() {
  if (!S.expired) {
    S.expired = true;
    log("bot", "11h uptime reached: bot is DEAD. Restart/redeploy the server to run again.");
  }
  S.manualOff = true; S.running = false; cfg.running = false;
  try { gc.stop(); } catch {}
  clearTimeout(S.timer); teardown();
  save();
}
function limitCheck() {
  if (!S.expired && Date.now() - S.started >= MAX_UPTIME_MS) return expireNow();
  if (S.expired && (S.running || S.api)) expireNow();  // something tried to revive it
}
setInterval(limitCheck, 5e3);

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));   // only index.html is public
app.get("/health", (q, r) => r.json({ ok: true }));

app.get("/api/needsetup", (q, r) => r.json({ setup: false, open: !hasAdmin() }));

const fails = new Map();
app.use("/api", (req, res, next) => {
  if (!hasAdmin()) return next();                   // open dashboard (walang password)
  const ip = req.ip, now = Date.now(), given = req.get("x-admin");
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  if (f.length >= 10) return res.status(429).json({ error: "Too many wrong tries. Wait 15 min." });
  if (hasAdmin() && given !== undefined && checkPw(given)) { fails.delete(ip); return next(); }
  if (given !== undefined) { f.push(now); fails.set(ip, f); }
  if (fails.size > 500) for (const [k, v] of fails) if (!v.some((t) => now - t < 900e3)) fails.delete(k);
  res.status(401).json({ error: "unauthorized" });
});

const status = () => ({
  online: S.online, running: S.running, uid: S.uid, authDead: S.authDead, fca: S.fcaName,
  serverUptime: (Date.now() - S.started) / 1000 | 0, botUptime: S.running && S.botSince ? (Date.now() - S.botSince) / 1000 | 0 : 0,
  lastConnected: S.lastConnected, lastDisconnected: S.lastDisconnected, lastPing: S.lastPing, lastEventAt: S.lastEventAt,
  stateRefreshedAt: cfg.stateRefreshedAt, savedAt: cfg.savedAt,
  autoReply: cfg.autoReply, threads: cfg.threads, repliesHour: S.replies.length, repliesDay: S.daily.length, suppressed: S.suppressed,
  attempts: S.attempts, nextRetry: S.nextRetry, lastError: S.lastError, cookieSaved: !!cfg.appState,
  prefix: cfg.prefix, gc: gc.status(), admins: (cfg.admins || []).map(String),
  expired: !!S.expired, expiresAt: S.started + MAX_UPTIME_MS,
  settings: {
    speed: cfg.speed, selfReact: cfg.selfReact, selfReactRate: cfg.selfReactRate, markRead: cfg.markRead, troll: cfg.troll,
    skipMax: cfg.skipMax, hourlyMax: cfg.hourlyMax, dailyMax: cfg.dailyMax, quiet: cfg.quiet, tz: cfg.tz,
  },
  quietNow: inQuiet(), log: S.log.slice(0, 40),
});
app.get("/api/status", (q, r) => r.json(status()));
app.post("/api/auto", (q, r) => { cfg.autoReply = !!q.body.on; save(); r.json(status()); });
// turn the bot ON/OFF for one GC (body: { threadId, on })
app.post("/api/threadset", (q, r) => {
  const id = String((q.body && q.body.threadId) || "").trim();
  if (!/^\d{5,25}$/.test(id)) return r.status(400).json({ error: "Invalid GC id" });
  const has = cfg.threads.includes(id);
  if (q.body.on && !has) cfg.threads.push(id);
  if (!q.body.on && has) { cfg.threads = cfg.threads.filter((t) => t !== id); gc.stop(id); }
  save(); r.json(status());
});
app.post("/api/start", async (q, r) => { await startBot(); r.json(status()); });
app.post("/api/stop", (q, r) => { S.running = false; cfg.running = false; save(); log("bot", "stopped"); r.json(status()); });
app.post("/api/reconnect", (q, r) => {
  S.manualOff = false; S.authDead = false; if (S.online) { teardown(); }
  S.attempts = 0; clearTimeout(S.timer); connect(); r.json(status());
});
app.post("/api/disconnect", (q, r) => { disconnect(); r.json(status()); });
app.post("/api/session", (q, r) => {
  try {
    cfg.appState = parseCookie(q.body.cookie); cfg.savedAt = Date.now(); cfg.stateRefreshedAt = null; S.lastStateJson = JSON.stringify(cfg.appState); save();
    S.manualOff = false; S.authDead = false; S.attempts = 0; S.lastError = null;
    if (S.online) teardown();
    connect(); r.json(status());
  } catch (e) { r.status(400).json({ error: "Invalid cookie (need a JSON array or c_user=...; xs=...)" }); }
});
app.post("/api/settings", (q, r) => {
  const b = q.body || {};
  if (["fast", "normal", "slow"].includes(b.speed)) cfg.speed = b.speed;
  if (typeof b.selfReact === "boolean") cfg.selfReact = b.selfReact;
  if (typeof b.markRead === "boolean") cfg.markRead = b.markRead;
  if (typeof b.troll === "boolean") cfg.troll = b.troll;
  cfg.selfReactRate = num(b.selfReactRate, 0, 1, cfg.selfReactRate);
  cfg.skipMax = Math.round(num(b.skipMax, 0, 4, cfg.skipMax));
  cfg.hourlyMax = Math.round(num(b.hourlyMax, 0, 1e6, cfg.hourlyMax));
  cfg.dailyMax = Math.round(num(b.dailyMax, 0, 1e7, cfg.dailyMax));
  if (b.quiet && typeof b.quiet === "object") {
    const ok = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s));
    cfg.quiet = { on: !!b.quiet.on, start: ok(b.quiet.start) ? b.quiet.start : cfg.quiet.start, end: ok(b.quiet.end) ? b.quiet.end : cfg.quiet.end };
  }
  save(); log("system", "settings updated"); r.json(status());
});

// GC name cycle (also controllable from chat with !gcname)
app.post("/api/gcsave", (q, r) => {
  const b = q.body || {};
  if (Array.isArray(b.names)) gc.setNames(b.names, false);
  if (b.intervalS != null) gc.setInterval(b.intervalS, false);
  save(); r.json(status());
});
app.post("/api/gcstart", (q, r) => {
  const b = q.body || {};
  const ids = [...new Set([...(Array.isArray(b.threadIds) ? b.threadIds : []), ...(b.threadId ? [b.threadId] : [])].map(String))];
  const use = ids.length ? ids : cfg.threads.length ? cfg.threads : gc.status().threads;   // default: every GC the bot is ON in
  if (!use.length) return r.status(400).json({ error: "I-ON muna ang bot sa kahit isang GC (Group chat card)." });
  gc.start({ threadIds: use, names: Array.isArray(b.names) ? b.names : undefined, intervalS: b.intervalS });
  r.json(status());
});
app.post("/api/gcstop", (q, r) => { gc.stop(q.body && q.body.threadId ? q.body.threadId : undefined); r.json(status()); });

// Admin IDs (can use !gcname, !troll, !eco in chat). The bot's own account is always admin.
app.post("/api/admins", (q, r) => {
  const raw = (q.body && q.body.ids) || [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
  const ids = [...new Set(list.map((x) => String(x).trim()).filter((x) => /^\d{5,25}$/.test(x)))].slice(0, 50);
  cfg.admins = ids; save(); log("system", `admins updated (${ids.length})`);
  r.json(status());
});

app.get("/api/threads", (q, r) => {
  if (!S.api) return r.json([]);
  S.api.getThreadList(50, null, ["INBOX"], (e, l) => r.json(e ? [] : l.filter((t) => t.isGroup).map((t) => ({ id: t.threadID, name: t.name || t.threadID }))));
});

// A long-running process must not die on one stray exception, and must save the
// freshest cookie when the host (Railway) sends SIGTERM on redeploy.
process.on("uncaughtException", (e) => log("fatal", (e && e.stack) || e));
process.on("unhandledRejection", (e) => log("fatal", (e && e.stack) || e));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { economy.flush(); stopAllTyping(); captureState("shutdown"); save(); process.exit(0); });

app.listen(PORT, () => { log("system", "server on " + PORT); if (cfg.appState) connect(); });
