const express = require("express");
const path = require("path");
const crypto = require("crypto");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

// Baileys
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");

// import functions (make sure public/function.js exports the functions)
const functionsPath = path.join(__dirname, "public", "function.js");
let functions = {};
try {
  functions = require(functionsPath);
} catch {
  console.warn("⚠️ Warning: public/function.js not found.");
}

const app = express();
const PORT = process.env.PORT || 3000;

// 👉 URL database JSON GitHub (RAW link)
const DB_URL = "https://raw.githubusercontent.com/AlwaysPrimess/App_website_cosmos/refs/heads/main/databes.json";

// session store
const sessions = {};
let sock = null;
let currentQRDataUrl = null;
let connectionState = { connected: false, user: null, lastConnect: null };

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ----- LOGIN pakai database di GitHub -----
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Missing credentials" });
    }

    // fetch database dari GitHub
    const response = await fetch(DB_URL);
    if (!response.ok) {
      return res.status(500).json({ success: false, message: "Failed to fetch database.json" });
    }

    const db = await response.json();
    const users = Array.isArray(db.users) ? db.users : [];

    const user = users.find(u => u.username === username && u.password === password);
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    // create token & store session
    const token = crypto.randomBytes(16).toString("hex");
    sessions[token] = { username: user.username, role: user.role || "user", createdAt: Date.now() };

    return res.json({ success: true, token, username: user.username, role: user.role || "user" });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ----- middleware auth -----
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/Bearer\s*/i, "");
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  req.sessionUser = sessions[token];
  next();
}

// ----- serve pages -----
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

// ----- Baileys init -----
async function startBaileys() {
  try {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2304, 6] }));
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_info_multi"));

    sock = makeWASocket({ auth: state, version, printQRInTerminal: false });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      if (update.qr) {
        try {
          currentQRDataUrl = await qrcode.toDataURL(update.qr);
        } catch (e) {
          console.error("QR convert error:", e);
          currentQRDataUrl = null;
        }
      }

      if (update.connection === "open") {
        connectionState.connected = true;
        connectionState.user = sock?.user?.id || null;
        connectionState.lastConnect = new Date().toISOString();
        currentQRDataUrl = null;
        console.log("✅ WhatsApp connected:", connectionState.user);
      }

      if (update.connection === "close") {
        connectionState.connected = false;
        console.warn("⚠️ WhatsApp connection closed, retrying...");
        setTimeout(() => startBaileys().catch(e => console.error("Reconnect failed", e)), 3000);
      }
    });

    console.log("📡 Baileys socket initialized");
  } catch (err) {
    console.error("startBaileys error:", err);
    setTimeout(() => startBaileys().catch(() => {}), 5000);
  }
}
startBaileys().catch(err => console.error("Baileys fatal error", err));

// ----- API -----
app.get("/status", (req, res) => res.json(connectionState));
app.get("/api/qr", (req, res) => currentQRDataUrl ? res.json({ ok: true, dataUrl: currentQRDataUrl }) : res.json({ ok: false, msg: "no_qr" }));
app.get("/api/generate/code", (req, res) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const token = Math.random().toString(36).slice(2, 10);
  res.json({ ok: true, code, token, both: `${code}-${token}` });
});

// kirim pesan pakai fungsi
app.post("/execute", requireAuth, async (req, res) => {
  try {
    const { target, func } = req.body || {};
    if (!target || !func) return res.status(400).json({ success: false, message: "Missing target or func" });

    if (!sock || !connectionState.connected) {
      return res.status(500).json({ success: false, message: "WhatsApp not connected" });
    }

    let normalized = target.toString().replace(/\D/g, "");
    if (normalized.startsWith("0")) normalized = "62" + normalized.slice(1);
    const jid = normalized + "@s.whatsapp.net";

    const fn = functions[func];
    if (!fn || typeof fn !== "function") {
      return res.status(400).json({ success: false, message: "Function not found" });
    }

    const result = await fn(normalized);

    try {
      if (result && typeof result === "object" && !Array.isArray(result)) {
        await sock.sendMessage(jid, result);
      } else {
        await sock.sendMessage(jid, { text: String(result) });
      }
      return res.json({ success: true, message: "Sent", func, target });
    } catch (sendErr) {
      console.error("sendMessage error:", sendErr);
      return res.status(500).json({ success: false, message: "Failed to send message", detail: sendErr.toString() });
    }
  } catch (err) {
    console.error("execute error:", err);
    return res.status(500).json({ success: false, message: "Server error", detail: err.toString() });
  }
});

// logout
app.post("/logout", requireAuth, (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/Bearer\s*/i, "");
  delete sessions[token];
  res.json({ success: true });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}

module.exports = app;