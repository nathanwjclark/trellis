import fs from "node:fs";
import path from "node:path";

const LOG_DIR =
  process.env.TRELLIS_LOG_DIR ?? path.resolve("data/logs");

export interface CallLogger {
  /** Append a structured event line. */
  event(kind: string, data?: Record<string, unknown>): void;
  /** Final dump of any object — pretty JSON. */
  dump(name: string, obj: unknown): void;
  /** Path of the per-call log file. */
  path: string;
  /** Close the underlying handle. */
  close(): void;
}

/**
 * Open a per-call log file under data/logs/ (or TRELLIS_LOG_DIR). Each call
 * gets its own newline-delimited JSON log plus a sidecar pretty dump for the
 * tool_use input. Pass `cycleId` so files for the same cycle group together.
 */
export function openCallLogger(args: {
  cycleId: string;
  purpose: string;
}): CallLogger {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${ts}__${args.purpose}__${args.cycleId.slice(0, 8)}`;
  const logPath = path.join(LOG_DIR, `${base}.ndjson`);
  const fd = fs.openSync(logPath, "a");

  const writeLine = (line: string): void => {
    fs.writeSync(fd, line + "\n");
  };

  const event: CallLogger["event"] = (kind, data) => {
    writeLine(
      JSON.stringify({ t: Date.now(), kind, ...(data ?? {}) }),
    );
  };

  const dump: CallLogger["dump"] = (name, obj) => {
    const dumpPath = path.join(LOG_DIR, `${base}__${name}.json`);
    fs.writeFileSync(dumpPath, JSON.stringify(obj, null, 2));
    event("dump_written", { name, path: dumpPath });
  };

  const close = (): void => {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  };

  event("logger_opened", { purpose: args.purpose, cycle_id: args.cycleId });

  return { event, dump, close, path: logPath };
}
