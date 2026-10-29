const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "economy.json");

function getEconomyData() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, "{}", "utf8");
  try {
    return JSON.parse(fs.readFileSync(dbPath, "utf8"));
  } catch {
    return {};
  }
}

function saveEconomyData(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

module.exports.config = {
  name: "coins",
  version: "1.0.0",
  hasPermission: 0,
  credits: "sinzu",
  description: "Tingnan ang balanse, mag-claim ng daily reward, o magpadala ng coins",
  usePrefix: true,
  commandCategory: "Economy",
  usages: "!coins | !coins daily | !coins pay @mention [halaga]",
  cooldowns: 2
};

module.exports.run = async function({ api, event, args }) {
  const { threadID, messageID, senderID, mentions } = event;
  const eco = getEconomyData();
  if (!eco[senderID]) eco[senderID] = { coins: 1000, lastDaily: 0 };

  const sub = args[0]?.toLowerCase();

  // 1. Daily Claim
  if (sub === "daily") {
    const now = Date.now();
    const cooldown = 24 * 60 * 60 * 1000; // 24 hours
    if (now - eco[senderID].lastDaily < cooldown) {
      const remaining = cooldown - (now - eco[senderID].lastDaily);
      const hours = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return api.sendMessage(`⏳ Nakuha mo na ang iyong daily reward! Maghintay pa ng ${hours} oras at ${mins} minuto bago mag-claim ulit.`, threadID, messageID);
    }

    const reward = 5000;
    eco[senderID].coins += reward;
    eco[senderID].lastDaily = now;
    saveEconomyData(eco);
    return api.sendMessage(`🎉 [ DAILY BONUS ]\n\nMatagumpay kang nakatanggap ng 🪙 5,000 Coins!\n💰 Kasalukuyang Balanse: 🪙 ${eco[senderID].coins.toLocaleString()} Coins`, threadID, messageID);
  }

  // 2. Transfer / Pay
  if (sub === "pay" || sub === "send") {
    if (!mentions || Object.keys(mentions).length === 0) {
      return api.sendMessage("⚠️ I-tag (@mention) ang taong papadalhan ng coins.\nHalimbawa: !coins pay @Sanzu 500", threadID, messageID);
    }
    const targetID = Object.keys(mentions)[0];
    const amount = parseInt(args[args.length - 1]);

    if (isNaN(amount) || amount <= 0) {
      return api.sendMessage("⚠️ Maglagay ng wastong halaga ng coins na ipapadala.", threadID, messageID);
    }
    if (eco[senderID].coins < amount) {
      return api.sendMessage(`❌ Kulang ang iyong coins! Meron ka lamang 🪙 ${eco[senderID].coins.toLocaleString()} Coins.`, threadID, messageID);
    }

    if (!eco[targetID]) eco[targetID] = { coins: 1000, lastDaily: 0 };
    eco[senderID].coins -= amount;
    eco[targetID].coins += amount;
    saveEconomyData(eco);

    const targetName = mentions[targetID];
    return api.sendMessage(`💸 [ TRANSFER SUCCESS ]\n\nMatagumpay kang nagpadala ng 🪙 ${amount.toLocaleString()} Coins kay ${targetName}!\n💰 Iyong Bagong Balanse: 🪙 ${eco[senderID].coins.toLocaleString()} Coins`, threadID, messageID);
  }

  // 3. Check Balance
  let targetID = senderID;
  let targetName = "Iyong";
  if (mentions && Object.keys(mentions).length > 0) {
    targetID = Object.keys(mentions)[0];
    targetName = `Ni ${mentions[targetID]}`;
  }

  if (!eco[targetID]) eco[targetID] = { coins: 1000, lastDaily: 0 };
  saveEconomyData(eco);

  const text = `🏦 [ SANZU BANK & WALLET ]
━━━━━━━━━━━━━━━━━
👤 Account: ${targetName}
🪙 Balanse: ${eco[targetID].coins.toLocaleString()} Coins
🎁 Daily: ${Date.now() - eco[targetID].lastDaily >= 86400000 ? "Ready to claim (!coins daily)" : "Claimed na today"}
━━━━━━━━━━━━━━━━━
💡 Tip: Gamitin ang '!slot [bet]' para magsugal at magpalago ng coins!`;

  api.sendMessage(text, threadID, messageID);
};
module.exports.onStart = module.exports.run;
