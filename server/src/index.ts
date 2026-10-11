import express from "express";
import cors from "cors";
import { config } from "./config";
import { getProvider } from "./providers";
import router from "./routes";
import { startCleanup } from "./cleanup";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api", router);

// Unknown API routes
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});

// Global error handler (last)
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Never leak secrets in errors.
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
);

startCleanup();

app.listen(config.port, () => {
  // Log provider + port on boot. NEVER log the API key.
  console.log(`passport-studio server listening on :${config.port} (BG_PROVIDER=${getProvider().name})`);
});
