// ==========================================================
// 👑 SOONERS — MAKUNAT V1.1 ✨
// ==========================================================

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "sooners_makunat.json");

const ADMIN_IDS = new Set([
  "61595714227886",
]);

const MIN_DELAY = 28000;
const MAX_DELAY = 45000;

const LINES = [
 "antaba ng kasama mo at mama mo"
 "sopsopen mo ttko beles na"
 "kakaenen mona ba ttkelsko huy"
 "ayoko balakajan HAHAHAHA"
 "aasarin lang kita alam moyan
 "yombuten mopa ttko ha"
 "kakanaen siguro neto ttko yaks"
 "manyakels kaba batakua"
 "luh batakita jan sa partenh yan"
 "ewan ko kung bkit ganun"
 "wala kang pame sosopaen mubako"
 "lasmo naman batakita hahaha"
 "pagod kana siguro jan no?
 "bata kit pagod really?"
 "lasneto feel ko napapagod kana saken"
 "bataen ko ulo mojan palotokan ko hehe"
];

const SELF_REACTS = ["❤️" , "😆"

let lineIndex = 0;
const activeLoops = new Map();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function isAdmin(id) {
  return ADMIN_IDS.has(String(id));
}

function nextLine() {
  const line = LINES[lineIndex];
  lineIndex = (lineIndex + 1) % LINES.length;
  return line;
}

function getRandomDelay() {
  return MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
}

// SOONERS LOOP
function startLoop(api, threadID) {
  stopLoop(threadID);

  async function sendNext() {
    if (!activeLoops.has(threadID)) return;

    try {
      const text = nextLine();

      api.sendMessage(text, threadID, (err, info) => {
        if (!err && info?.messageID) {
          setTimeout(() => {
            const emoji = SELF_REACTS[
              Math.floor(Math.random() * SELF_REACTS.length)
            ];

            api.setMessageReaction(
              emoji,
              info.messageID,
              () => {},
              true
            );
          }, 1000);
        }
      });
    } catch (e) {}

    const nextDelay = getRandomDelay();
    const timer = setTimeout(sendNext, nextDelay);

    activeLoops.set(threadID, { timer });
  }

  activeLoops.set(threadID, { timer: null });
  sendNext();
}

function stopLoop(threadID) {
  const existing = activeLoops.get(threadID);

  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    activeLoops.delete(threadID);
  }
}

module.exports.handleEvent = async function ({ api, event }) {
  // Walang auto-reply sa ibang messages.
};

module.exports.config = {
  name: "sooners",
  version: "1.1.0",
  hasPermission: 0,
  credits: "SOONERS — MAKUNAT ✅",
  description: "Tuluy-tuloy kahit walang chat | Sarili lang naglalapag",
  usePrefix: true,
  commandCategory: "👑 SOONERS",
  usages: "/sooners on — Simula\n/sooners off — Hinto"
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;

  if (!isAdmin(senderID)) {
    return api.sendMessage(
      "👑 Hindi mo hawak ang kapangyarihan dito!",
      threadID,
      messageID
    );
  }

  const cmd = (args[0] || "").toLowerCase();

  if (cmd === "on") {
    startLoop(api, threadID);

    return api.sendMessage(
      "👑 SOONERS — NAKA-ON NA! ✨\n\n" +
      "✅ Sarili lang naglalapag\n" +
      "✅ Auto-react sa sariling mensahe\n" +
      "✅ Gamitin ang /sooners off para huminto\n\n" +
      "💎 SOONERS BOSS",
      threadID,
      messageID
    );
  }

  if (cmd === "off") {
    stopLoop(threadID);

    return api.sendMessage(
      "🛑 SOONERS — HUMINTO NA 👑",
      threadID,
      messageID
    );
  }

  return api.sendMessage(
    "👑 SOONERS — MAKUNAT ✨\n\n" +
    "/sooners on — Simulan\n" +
    "/sooners off — Huminto\n\n" +
    "💎 SOONERS BOSS",
    threadID,
    messageID
  );
};
