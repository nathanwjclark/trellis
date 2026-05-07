import path from "node:path";

export interface Config {
  dbPath: string;
  port: number;
  dailyUsdBudget: number;
  openclawPath: string | null;
}

export function loadConfig(): Config {
  return {
    dbPath: process.env.TRELLIS_DB_PATH ?? path.resolve("data/trellis.db"),
    port: Number.parseInt(process.env.TRELLIS_PORT ?? "18810", 10),
    dailyUsdBudget: Number.parseFloat(process.env.TRELLIS_DAILY_USD_BUDGET ?? "10"),
    openclawPath: process.env.OPENCLAW_PATH ?? null,
  };
}
