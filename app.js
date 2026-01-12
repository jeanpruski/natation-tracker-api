// app.js — API Natation (Express + MySQL) + type (swim/run)
// ---------------------------------------------------------
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3001;

/* =========================
   CORS (prod + dev)
   - Exemple: CORS_ORIGIN="https://natrack.prjski.com,http://localhost:3000"
   ========================= */
const WHITELIST = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (WHITELIST.length === 0 || WHITELIST.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());

/* =========================
   MySQL pool
   ========================= */
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
});

/* =========================
   Auth par jeton (édition)
   - HEADER: Authorization: Bearer <EDIT_TOKEN>
     ou     X-API-Key: <EDIT_TOKEN>
   ========================= */
function requireEditAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = req.get("x-api-key") || bearer;
  const expected = process.env.EDIT_TOKEN || "";

  if (token && expected && token === expected) return next();
  return res.status(401).json({ error: "unauthorized" });
}

/* =========================
   Bloquer la navigation directe (GET document) => 204
   ========================= */
function blockBrowserNav(req, res, next) {
  try {
    if (req.method === "GET" && req.path !== "/health") {
      const dest = (req.get("sec-fetch-dest") || "").toLowerCase();
      const mode = (req.get("sec-fetch-mode") || "").toLowerCase();
      const accept = (req.get("accept") || "").toLowerCase();

      const isDocumentNav =
        mode === "navigate" ||
        dest === "document" ||
        (accept.includes("text/html") && !accept.includes("application/json"));

      if (isDocumentNav) {
        return res.status(204).end();
      }
    }
  } catch (e) {
    console.error("blockBrowserNav error:", e);
  }
  return next();
}

/* =========================
   Helpers type validation
   ========================= */
const ALLOWED_TYPES = new Set(["swim", "run"]);

function normalizeType(input) {
  if (!input) return "swim"; // défaut
  const t = String(input).toLowerCase().trim();
  return t;
}

function isValidType(t) {
  return ALLOWED_TYPES.has(t);
}

/* =========================
   Router API
   ========================= */
const api = express.Router();
api.use(blockBrowserNav);

// Healthcheck DB + app
api.get("/health", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Validation de la clé d'édition (utilisée par le front)
api.get("/auth/check", requireEditAuth, (_req, res) => {
  res.json({ ok: true });
});

// Liste des séances (option: ?type=swim|run)
api.get("/sessions", async (req, res) => {
  try {
    const type = req.query?.type ? normalizeType(req.query.type) : null;

    if (type && !isValidType(type)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    let sql =
      "SELECT id, DATE_FORMAT(date, '%Y-%m-%d') AS date, distance, type FROM sessions";
    const params = [];

    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }

    sql += " ORDER BY date ASC";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Création (protégé)
api.post("/sessions", requireEditAuth, async (req, res) => {
  try {
    const { distance, date, id, type } = req.body || {};

    const t = normalizeType(type);

    if (!date) return res.status(400).json({ error: "date requise" });
    if (typeof distance === "undefined" || distance === null || distance === "") {
      return res.status(400).json({ error: "distance requise" });
    }

    const distNum = Number(distance);
    if (!Number.isFinite(distNum) || distNum <= 0) {
      return res.status(400).json({ error: "distance invalide" });
    }

    if (!isValidType(t)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    const newId = id || uuidv4();

    await pool.query(
      "INSERT INTO sessions (id, date, distance, type) VALUES (?, ?, ?, ?)",
      [newId, date, distNum, t]
    );

    res.status(201).json({ id: newId, date, distance: distNum, type: t });
  } catch (e) {
    console.error("POST /sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Mise à jour (protégé)
api.put("/sessions/:id", requireEditAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { distance, date, type } = req.body || {};

    if (typeof distance === "undefined" && !date && typeof type === "undefined") {
      return res.status(400).json({ error: "aucune donnée à mettre à jour" });
    }

    const fields = [];
    const params = [];

    if (date) {
      fields.push("date = ?");
      params.push(date);
    }

    if (typeof distance !== "undefined") {
      const distNum = Number(distance);
      if (!Number.isFinite(distNum) || distNum <= 0) {
        return res.status(400).json({ error: "distance invalide" });
      }
      fields.push("distance = ?");
      params.push(distNum);
    }

    if (typeof type !== "undefined") {
      const t = normalizeType(type);
      if (!isValidType(t)) {
        return res.status(400).json({ error: "type invalide (swim|run)" });
      }
      fields.push("type = ?");
      params.push(t);
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`,
      params
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });

    // renvoie ce qui a été envoyé (simple)
    res.json({ id, date, distance, type });
  } catch (e) {
    console.error("PUT /sessions/:id error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Suppression (protégé)
api.delete("/sessions/:id", requireEditAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM sessions WHERE id = ?", [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (e) {
    console.error("DELETE /sessions/:id error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   Montage: couvre / ET /api
   ========================= */
app.use("/", api);
app.use("/api", api);

// Ping simple
app.get("/", (_req, res) => res.send("API up"));

/* =========================
   Error handler global (JSON)
   ========================= */
app.use((err, req, res, _next) => {
  try {
    console.error("Unhandled error:", err);
  } catch {}
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error" });
});

/* =========================
   Start
   ========================= */
app.listen(PORT, () => {
  console.log("Listening on", PORT);
});