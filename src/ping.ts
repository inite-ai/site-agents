/**
 * Which AI agents read the served paths, counted per day, and the ping that
 * reports it (POST /api/site/v1/ping), as the WordPress plugin does
 * (includes/class-inite-agents-visitors.php, class-inite-agents-ping.php).
 *
 * A request is counted only when its user agent names an agent in
 * AI_AGENTS and it asked for a path this package served. Nothing else about
 * it is kept: no address, no full user agent, no page, no cookie. The
 * counts are a few numbers per day in this process's memory, the last
 * seven days, and the ping sends them with the package version and the
 * paths served.
 *
 * The service takes each count as the day's total so far, not an
 * increment. A deployment with many instances (serverless) counts per
 * instance, so what reaches the cabinet is a lower bound there; a single
 * self-hosted server counts exactly.
 */

import { agentOf } from "./agents";
import type { Resolved } from "./config";
import { PACKAGE_VERSION, TIMEOUT_MS } from "./sync";

const DAYS = 7;
/** The service takes at most sixty rows a ping (https://inite.ai/en/mcp#site-api, the ping). */
export const VISIT_ROWS = 60;

export interface VisitRow {
  day: string;
  path: string;
  agent: string;
  hits: number;
}

export class Visits {
  private counts = new Map<string, number>();
  private lastPing = 0;
  private sending: Promise<void> | null = null;

  constructor(private readonly cfg: Resolved) {}

  /** Count this request if an agent asked for a served path. */
  count(path: string, userAgent: string | null): void {
    if (!this.cfg.features.ping) return;
    const agent = agentOf(userAgent);
    if (!agent) return;
    const day = new Date(this.cfg.now()).toISOString().slice(0, 10);
    const k = `${day}\n${path}\n${agent}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  /** The counts as the ping sends them: one row per day, path and agent; the last week, the newest rows kept. */
  rows(): VisitRow[] {
    const oldest = new Date(this.cfg.now() - (DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows: VisitRow[] = [];
    for (const [k, hits] of this.counts) {
      const [day, path, agent] = k.split("\n");
      if (day < oldest) {
        this.counts.delete(k);
        continue;
      }
      rows.push({ day, path, agent, hits });
    }
    rows.sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? -1 : 1));
    return rows.slice(-VISIT_ROWS);
  }

  /** Whether a ping is due from this process. */
  due(): boolean {
    return this.cfg.features.ping && !!this.cfg.key && !this.sending && this.cfg.now() - this.lastPing >= this.cfg.pingEveryMs;
  }

  /** Send the ping if one is due. Never throws; a failure waits for the next period. */
  async maybePing(paths: string[]): Promise<void> {
    if (!this.due()) return;
    this.lastPing = this.cfg.now();
    this.sending = this.send(paths).finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async send(paths: string[]): Promise<void> {
    try {
      await this.cfg.fetch(`${this.cfg.origin}/api/site/v1/ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.key}`, "Content-Type": "application/json", "User-Agent": `INITE-Agents-Next/${PACKAGE_VERSION}` },
        body: JSON.stringify({ platform: "next", pluginVersion: PACKAGE_VERSION, paths, visits: this.rows() }),
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // quiet: a ping is a report; the next period sends the counts again
    }
  }
}
