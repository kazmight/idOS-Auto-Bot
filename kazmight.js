import { config as dotenv } from "dotenv";
import { setTimeout as sleep } from "node:timers/promises";
import { Wallet } from "ethers";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

dotenv(); 

const BASE_API = "https://app.idos.network/api";
const WAIT_MS = 24 * 60 * 60 * 1000; 

const colors = {
  primary: "#00ff00",
  secondary: "#ffff00",
  info: "#3498db",
  warning: "#f39c12",
  error: "#e74c3c",
  success: "#2ecc71",
  text: "#ffffff",
  background: "#1a1a1a",
  purple: "#9b59b6",
  cyan: "#00ffff",
  pink: "#ff69b4",
  orange: "#ff8c00",
};


const hexToRgb = (hex) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return [255, 255, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
};
const colorize = (hex, s) => {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
};


const log = {
  info: (msg) => console.log(`${colorize(colors.info, "ℹ")} ${msg}`),
  success: (msg) => console.log(`${colorize(colors.success, "✔")} ${msg}`),
  warn: (msg) => console.log(`${colorize(colors.warning, "⚠")} ${msg}`),
  error: (msg) => console.log(`${colorize(colors.error, "✖")} ${msg}`),
  action: (msg) => console.log(`${colorize(colors.purple, "➤")} ${msg}`),
  plain: (msg) => console.log(`${colorize(colors.text, msg)}`),
  divider: (label = "") => {
    const line = "─".repeat(20);
    const title = label ? ` ${label} ` : "";
    console.log(colorize(colors.cyan, `${line}${title}${line}`));
  },
};



const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

async function fetchJSON(url, options = {}, { retries = 3, retryDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60_000);
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      throw lastErr;
    }
  }
}

function baseHeaders() {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://app.idos.network",
    Referer: "https://app.idos.network/",
    "User-Agent": pickUA(),
  };
}

async function getAuthMessage(address) {
  const url = `${BASE_API}/auth/message`;
  const body = JSON.stringify({ publicAddress: address, publicKey: address });
  return fetchJSON(url, { method: "POST", headers: { ...baseHeaders() }, body });
}

async function verifyAuth(payload) {
  const url = `${BASE_API}/auth/verify`;
  const body = JSON.stringify(payload);
  return fetchJSON(url, { method: "POST", headers: { ...baseHeaders() }, body });
}

function decodeUserIdFromJWT(jwt) {
  try {
    const [, payloadPart] = jwt.split(".");
    const json = JSON.parse(
      Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    return json.userId;
  } catch {
    return null;
  }
}

async function getUserPoints(userId, accessToken) {
  const url = `${BASE_API}/user/${userId}/points`;
  return fetchJSON(url, {
    method: "GET",
    headers: { ...baseHeaders(), Authorization: `Bearer ${accessToken}` },
  });
}

async function dailyCheck(userId, accessToken) {
  const url = `${BASE_API}/user-quests/complete`;
  const body = JSON.stringify({ questName: "daily_check", userId });
  try {
    return await fetchJSON(url, {
      method: "POST",
      headers: { ...baseHeaders(), Authorization: `Bearer ${accessToken}` },
      body,
    });
  } catch (err) {
    if (String(err).includes("HTTP 502")) {
      return { alreadyClaimed: true };
    }
    throw err;
  }
}

async function loginAndTokens(privKey) {
  const wallet = new Wallet(privKey);
  const address = await wallet.getAddress();
  const msg = await getAuthMessage(address);
  if (!msg?.message || !msg?.nonce) throw new Error("Failed to fetch auth message/nonce.");
  const signature = await wallet.signMessage(msg.message);
  const payload = {
    publicAddress: address,
    publicKey: address,
    signature,
    message: msg.message,
    nonce: msg.nonce,
    walletType: "evm",
  };
  const verified = await verifyAuth(payload);
  const accessToken = verified?.accessToken;
  const refreshToken = verified?.refreshToken;
  if (!accessToken || !refreshToken) throw new Error("Login failed: missing tokens.");
  const userId = decodeUserIdFromJWT(accessToken);
  if (!userId) throw new Error("Failed to decode userId from access token.");
  return { address, accessToken, userId };
}

async function processAccount(privKey) {
  try {
    const { address, accessToken, userId } = await loginAndTokens(privKey);

    log.divider(maskAddress(address));
    log.success("Login success.");

    const points = await getUserPoints(userId, accessToken);
    const total = points?.totalPoints ?? 0;
    log.info(`idOS Points: ${colorize(colors.primary, `${total} PTS`)}`);

    const check = await dailyCheck(userId, accessToken);
    if (check?.alreadyClaimed) {
      log.warn("Daily check-in: already claimed.");
    } else {
      log.success("Daily check-in: claimed.");
    }
  } catch (err) {
    log.error(String(err));
  }
}

async function refreshPointsForAccount(privKey) {
  try {
    const { address, accessToken, userId } = await loginAndTokens(privKey);
    log.divider(maskAddress(address));
    const points = await getUserPoints(userId, accessToken);
    const total = points?.totalPoints ?? 0;
    log.info(`idOS Points: ${colorize(colors.primary, `${total} PTS`)}`);
  } catch (err) {
    log.error(String(err));
  }
}


function readKeysFromEnv() {
  const single = process.env.PRIVATE_KEY?.trim();
  const multi = process.env.PRIVATE_KEYS;

  let keys = [];
  if (multi && multi.trim().length > 0) {
    keys = multi
      .split(/,|\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (single) {
    keys = [single];
  }
  return keys;
}


async function waitWithAnimationInterruptible(msTotal, shouldStop) {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  const start = Date.now();
  let i = 0;
  process.stdout.write("\x1B[?25l"); 

  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (shouldStop()) {
        clearInterval(iv);
        process.stdout.write("\r\x1b[2K" + colorize(colors.warning, "⚠ Auto loop stopped.") + "\n\x1B[?25h");
        resolve("stopped");
        return;
      }
      const elapsed = Date.now() - start;
      const remain = Math.max(0, msTotal - elapsed);

      const sec = Math.floor(remain / 1000) % 60;
      const min = Math.floor(remain / (1000 * 60)) % 60;
      const hr  = Math.floor(remain / (1000 * 60 * 60));

      const hh = String(hr).padStart(2, "0");
      const mm = String(min).padStart(2, "0");
      const ss = String(sec).padStart(2, "0");
      const spinner = frames[i = (i + 1) % frames.length];

      const line =
        `${colorize(colors.cyan, spinner)} ` +
        `${colorize(colors.text, "Waiting for next daily check-in: ")} ` +
        `${colorize(colors.primary, `${hh}:${mm}:${ss}`)} ` +
        `${colorize(colors.secondary, "(Stop via menu)")}`;

      process.stdout.write("\r\x1b[2K" + line);

      if (remain <= 0) {
        clearInterval(iv);
        process.stdout.write("\r\x1b[2K" + colorize(colors.success, "✔ Starting next cycle...") + "\n\x1B[?25h");
        resolve("done");
      }
    }, 100);
  });
}


async function runOnceForAllAccounts(accounts) {
  log.plain(colorize(colors.cyan, `Loaded ${accounts.length} account(s) from .env`));
  for (const pk of accounts) {
    await processAccount(pk);
  }
  log.divider();
  log.success("Run completed for all accounts.");
}

async function refreshPointsAll(accounts) {
  log.plain(colorize(colors.cyan, `Loaded ${accounts.length} account(s) from .env`));
  for (const pk of accounts) {
    await refreshPointsForAccount(pk);
  }
  log.divider("POINTS");
  log.success("Refresh points completed.");
}


let autoLoop = false;          
let stopFlag = false;          
const rl = readline.createInterface({ input, output });

function showMenu() {
  log.divider("MENU");
  console.log(
    [
      `1) ${colorize(colors.primary, "Daily Check-in")}`,
      `2) ${colorize(colors.primary, "Auto Loop Daily Check-in")}`,
      `3) ${colorize(colors.primary, "Stop Auto Loop Daily Check-in")}`,
      `4) ${colorize(colors.primary, "Refresh Point")}`,
      `5) ${colorize(colors.error, "Exit")}`,
    ].join("\n")
  );
}

async function handleChoice(choice, accounts) {
  switch (choice.trim()) {
    case "1": { 
      if (autoLoop) {
        log.warn("Auto loop is running. Stop it first if you want a single run.");
        break;
      }
      await runOnceForAllAccounts(accounts);
      break;
    }
    case "2": { 
      if (autoLoop) {
        log.warn("Auto loop already running.");
        break;
      }
      autoLoop = true;
      stopFlag = false;
      log.success("Auto Loop Daily Check-in started.");
      
      (async () => {
        try {
          while (autoLoop) {
            await runOnceForAllAccounts(accounts);
            if (!autoLoop) break;
            const res = await waitWithAnimationInterruptible(WAIT_MS, () => stopFlag);
            if (res === "stopped") break;
          }
        } catch (e) {
          log.error(String(e));
        } finally {
          autoLoop = false;
          stopFlag = false;
          
          await promptMenu(accounts);
        }
      })();
      break;
    }
    case "3": { 
      if (!autoLoop) {
        log.warn("Auto loop is not running.");
        break;
      }
      stopFlag = true;
      autoLoop = false;
      log.warn("Stopping auto loop…");
      break;
    }
    case "4": { 
      if (autoLoop) {
        log.warn("Auto loop is running. Stop it first if you want to refresh manually.");
        break;
      }
      await refreshPointsAll(accounts);
      break;
    }
    case "5": { 
      log.warn("Exiting…");
      rl.close();
      
      process.stdout.write("\x1B[?25h");
      process.exit(0);
    }
    default:
      log.error("Invalid choice. Pick 1-5.");
  }
}

async function promptMenu(accounts) {
  
  process.stdout.write("\x1B[?25h");
  showMenu();
  const ans = await rl.question(colorize(colors.cyan, "Select (1-5): "));
  console.log();
  await handleChoice(ans, accounts);
  if (!autoLoop) {
    
    await promptMenu(accounts);
  }
}


(async () => {
  try {
    const accounts = readKeysFromEnv();
    if (accounts.length === 0) {
      log.error("No private keys found. Set PRIVATE_KEY or PRIVATE_KEYS in .env");
      process.exit(1);
    }

    
    const onExit = () => {
      process.stdout.write("\n\x1B[?25h"); 
      rl.close();
      process.exit(0);
    };
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);

    await promptMenu(accounts);
  } catch (err) {
    process.stdout.write("\x1B[?25h"); 
    log.error(String(err));
    process.exit(1);
  }
})();
