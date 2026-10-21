import express from "express";
import helmet from "helmet";
import cors from "cors";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({ origin(origin, callback) {
  if (!origin || !allowedOrigin || origin === allowedOrigin) return callback(null, true);
  return callback(new Error("origin_not_allowed"));
}}));

const startedAt = Date.now();
const configured = Boolean(process.env.FYERS_APP_ID && process.env.FYERS_APP_SECRET && process.env.FYERS_REDIRECT_URI);
let latestValidTickAt = null;
let socketConnected = false;

app.get("/", (_req, res) => res.json({ service: "DhanPulse clean backend", version: "0.1.0", status: "online" }));
app.get("/health", (_req, res) => res.json({ backend: "online", uptimeSeconds: Math.floor((Date.now()-startedAt)/1000) }));
app.get("/api/status", (_req, res) => {
  const tickAgeMs = latestValidTickAt ? Date.now() - latestValidTickAt : null;
  res.json({
    backend: "online",
    fyersConfigured: configured,
    fyers: "not-verified",
    liveData: tickAgeMs !== null && tickAgeMs <= 15000 ? "streaming" : "waiting-for-verified-tick",
    marketSocketConnected: socketConnected,
    lastTickAt: latestValidTickAt ? new Date(latestValidTickAt).toISOString() : null,
    orderPlacement: "disabled",
    note: "Configuration alone does not prove authentication or live market data."
  });
});
app.get("/api/market/quotes", (_req, res) => res.status(503).json({
  error: "market_data_not_connected",
  message: "No verified FYERS quote provider is active. No placeholder prices are returned.",
  data: []
}));
app.get("/api/market/candles", (_req, res) => res.status(503).json({
  error: "market_data_not_connected",
  message: "No verified FYERS candle provider is active. No synthetic candles are returned.",
  data: []
}));
app.use((err, _req, res, _next) => {
  if (err?.message === "origin_not_allowed") return res.status(403).json({ error: "origin_not_allowed" });
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log("DhanPulse clean backend listening on " + port));
