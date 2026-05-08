import type { Repo } from "../graph/repo.js";
import type { Event } from "../graph/schema.js";

/**
 * Poll-based pub/sub for the events table. The server polls SQLite for new
 * rows every `intervalMs` and pushes them to subscribed listeners. We poll
 * (rather than tail an in-memory event bus) so a separate process — like
 * `trellis loop` — can write events that the server picks up too.
 */
export class EventBus {
  private subscribers = new Set<(event: Event) => void>();
  private timer: NodeJS.Timeout | null = null;
  private lastSeenAt = 0;
  private lastSeenIds = new Set<string>();

  constructor(
    private readonly repo: Repo,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    // Seed lastSeenAt so the first tick doesn't flood subscribers with
    // historical events.
    const recent = this.repo.recentEvents(1);
    if (recent[0]) {
      this.lastSeenAt = recent[0].created_at;
      this.lastSeenIds.add(recent[0].id);
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Allow the process to exit even with the timer pending.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subscribers.clear();
  }

  subscribe(fn: (event: Event) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Useful for tests: force a tick without waiting for the timer. */
  tickNow(): void {
    this.tick();
  }

  private tick(): void {
    // Pull events created at-or-after the last seen timestamp. We use
    // `lastSeenIds` to dedupe events that share the same ms timestamp.
    const events = this.repo
      .recentEvents(500)
      .filter((e) => e.created_at >= this.lastSeenAt && !this.lastSeenIds.has(e.id))
      .sort((a, b) => a.created_at - b.created_at);
    if (events.length === 0) return;
    for (const e of events) {
      this.lastSeenAt = Math.max(this.lastSeenAt, e.created_at);
      this.lastSeenIds.add(e.id);
      for (const fn of this.subscribers) {
        try {
          fn(e);
        } catch {
          // Don't let a bad subscriber kill the bus.
        }
      }
    }
    // Trim the seen-id set so it doesn't grow unboundedly.
    if (this.lastSeenIds.size > 1024) {
      this.lastSeenIds = new Set(events.slice(-256).map((e) => e.id));
    }
  }
}
