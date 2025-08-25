// app.js — API Natation (Express + MySQL)
// --------------------------------------
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3001;

/* =========================
   CORS (prod + dev)
   - Définis CORS_ORIGIN="https://natrack.prjski.com,http://localhost:3000"
   ========================= */
const WHITELIST = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // Autorise aussi les requêtes sans origin (curl, server-to-server)
    if (!origin) return cb(null, true);
    if (WHITELIST.length === 0 || WHITELIST.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
};

app.use(cors(corsOptions));
// Important pour que le préflight OPTIONS passe avec Authorization
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
   Router API
   ========================= */
const api = express.Router();

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

// Liste des séances
api.get("/sessions", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, DATE_FORMAT(date, '%Y-%m-%d') AS date, distance FROM sessions ORDER BY date ASC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Création (protégé)
api.post("/sessions", requireEditAuth, async (req, res) => {
  try {
    const { distance, date, id } = req.body || {};
    if (!distance || !date) {
      return res.status(400).json({ error: "distance et date requis" });
    }
    const newId = id || uuidv4();
    await pool.query(
      "INSERT INTO sessions (id, date, distance) VALUES (?, ?, ?)",
      [newId, date, Number(distance)]
    );
    res.status(201).json({ id: newId, date, distance: Number(distance) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mise à jour (protégé)
api.put("/sessions/:id", requireEditAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { distance, date } = req.body || {};
    if (typeof distance === "undefined" && !date) {
      return res.status(400).json({ error: "aucune donnée à mettre à jour" });
    }

    const fields = [];
    const params = [];
    if (date) { fields.push("date = ?"); params.push(date); }
    if (typeof distance !== "undefined") { fields.push("distance = ?"); params.push(Number(distance)); }
    params.push(id);

    const [result] = await pool.query(
      `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`,
      params
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });

    res.json({ id, date, distance });
  } catch (e) {
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
   Start
   ========================= */
app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
