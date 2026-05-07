import { open } from "../../graph/db.js";
import { loadConfig } from "../config.js";

export async function dbInit(): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  process.stdout.write(`initialized ${cfg.dbPath}\n`);
  db.close();
}
