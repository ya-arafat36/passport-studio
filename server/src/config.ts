import dotenv from "dotenv";

dotenv.config();

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: num("PORT", 4000),
  bgProvider: (process.env.BG_PROVIDER || "rembg-local").toLowerCase(),
  removebgApiKey: process.env.REMOVEBG_API_KEY || "",
  maxFileMB: num("MAX_FILE_MB", 15),
  maxFiles: num("MAX_FILES", 100),
  cleanupHours: num("CLEANUP_HOURS", 24),
};
