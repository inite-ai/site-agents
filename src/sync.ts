/**
 * The copy of what INITE published for this site, and how it is kept.
 *
 * The same rules as the WordPress plugin (includes/class-inite-agents-sync.php):
 *   200            a new copy, taken only when the manifest and every file
 *                  it names arrived, written whole;
 *   304            nothing changed, the copy is kept;
 *   401, 403, 409  the key is unknown or revoked, the connector is off in the
 *                  cabinet, or nothing is confirmed to publish: the copy is
 *                  dropped and the site stops serving it;
 *   anything else  (a timeout, a 5xx, a redirect, a body that does not read):
 *                  the last good copy stays and keeps being served.
 *
 * The key goes only to the configured origin, never to an address a
 * response names, and a redirect is not followed. Nothing here throws to
 * the caller: `snapshot()` always answers.
 *
 * Kept in two places. In memory, per process, for `revalidate` seconds. And,
 * inside a Next server, in Next's data cache (unstable_cache) under the same
 * lifetime, so every instance of a deployment (a Vercel function's many
 * copies, a self-hosted cluster) reads one decision: a drop reaches all of
 * them, and a cold instance does not ask the service again. A failure is
 * never cached: the data cache keeps the last entry it had.
 */

import type { Resolved } from "./config";
import { parseManifest, safeEtag, safeType, type FileName, type HeadLink, type RootPath } from "./manifest";

export const TIMEOUT_MS = 5_000;
/** Largest body taken from the service, as the plugin's limit. */
export const MAX_BODY = 1_048_576;
/** After a failure with nothing to serve, how soon to ask again. */
export const RETRY_MS = 60_000;

export interface CopyFile {
  body: string;
  type: string;
  etag: string;
  path: RootPath | null;
}

export interface Copy {
  slug: string;
  domain: string;
  version: number;
  /** The manifest's ETag, sent back as If-None-Match. */
  etag: string;
  files: Partial<Record<FileName, CopyFile>>;
  head: { script: string | null; links: HeadLink[]; jsonLd: Record<string, unknown> | null };
  syncedAt: number;
}

export type Snapshot =
  | { state: "ok"; copy: Copy }
  /** The service said this site must not publish (401, 403, 409). */
  | { state: "dropped"; status: number; error: string; message: string }
  /** No key, or the service has never been reached from here. */
  | { state: "none"; error: string };

class Transient extends Error {}

const REFUSED = new Set([401, 403, 409]);

interface Answer {
  status: number;
  body: string;
  etag: string;
  type: string;
}

export class SiteSync {
  private mem: { snap: Snapshot; until: number } | null = null;
  private good: Copy | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private pulling: Promise<Snapshot> | null = null;
  private failUntil = 0;
  private nextCache: "untried" | "on" | "off";

  constructor(readonly cfg: Resolved) {
    this.nextCache = cfg.cache === "next" ? "untried" : "off";
  }

  /** The copy to serve now. Asks the service when the held one is older than `revalidate`. Never throws. */
  async snapshot(): Promise<Snapshot> {
    if (!this.cfg.key) return { state: "none", error: this.cfg.problem ?? "no_key" };
    // Inside Next every read goes through the data cache, even when this
    // process holds a fresh copy: that call is what tells a prerendered page
    // its revalidate period and tag, so a confirm reaches a static page.
    if (this.nextCache !== "off") {
      const got = await this.viaNext();
      if (got) return got;
    }
    const now = this.cfg.now();
    if (this.mem && now < this.mem.until) return this.mem.snap;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the copy held in this process (tests; a deploy hook). */
  reset(): void {
    this.mem = null;
    this.good = null;
    this.failUntil = 0;
  }

  /** Memory only: the service at most once per `revalidate`, sooner after a failure with nothing held. */
  private async load(): Promise<Snapshot> {
    let snap: Snapshot;
    try {
      snap = await this.pullOnce();
    } catch (err) {
      snap = this.fallback(err);
      const wait = this.good ? this.cfg.revalidateMs : Math.min(RETRY_MS, this.cfg.revalidateMs);
      this.mem = { snap, until: this.cfg.now() + wait };
      return snap;
    }
    this.mem = { snap, until: this.cfg.now() + this.cfg.revalidateMs };
    return snap;
  }

  /**
   * The decision through Next's data cache (unstable_cache): shared by every
   * instance, fresh for `revalidate` seconds, then served stale while one
   * request asks again. A failure is not stored, so the cache keeps its last
   * entry. Null when there is no Next server here (a test, a script): the
   * caller falls back to memory, from then on.
   */
  private async viaNext(): Promise<Snapshot | null> {
    let cached: () => Promise<Snapshot>;
    try {
      const { unstable_cache } = await import("next/cache");
      const id = await fingerprint(`${this.cfg.origin}\n${this.cfg.key}`);
      cached = unstable_cache(() => this.pullOnce(), ["@inite/site-agents", this.cfg.origin, id], {
        revalidate: Math.max(1, Math.round(this.cfg.revalidateMs / 1000)),
        tags: ["inite-site-agents"],
      });
    } catch {
      // quiet: no next/cache to import; memory only from now on
      this.nextCache = "off";
      return null;
    }
    try {
      const snap = await cached();
      this.nextCache = "on";
      // A copy another instance wrote is this one's last good copy too.
      this.good = snap.state === "ok" ? snap.copy : null;
      return snap;
    } catch (err) {
      if (err instanceof Transient) return this.fallback(err);
      // Not inside a Next request or build (the incremental cache is missing): memory only.
      if (this.nextCache === "untried") {
        this.nextCache = "off";
        return null;
      }
      return this.fallback(err);
    }
  }

  private fallback(err: unknown): Snapshot {
    // quiet: a failure keeps the last good copy, which is the point; nothing to tell the host page
    if (!(err instanceof Transient)) console.warn("[@inite/site-agents] sync:", err instanceof Error ? err.message : err);
    return this.good ? { state: "ok", copy: this.good } : { state: "none", error: "unreachable" };
  }

  /**
   * One pull at a time per process. A failure with a good copy held answers
   * that copy, so the data cache keeps it for another period instead of
   * retrying (and logging) on every request while the service is down; with
   * nothing held it throws, and nothing is stored. After a failure the
   * service is not asked again for RETRY_MS. One warning per outage.
   */
  private pullOnce(): Promise<Snapshot> {
    const kept = (): Snapshot => {
      if (this.good) return { state: "ok", copy: this.good };
      throw new Transient("unreachable, nothing held");
    };
    if (this.cfg.now() < this.failUntil) return Promise.resolve().then(kept);
    this.pulling ??= this.pull()
      .then((snap) => {
        this.good = snap.state === "ok" ? snap.copy : null;
        this.failUntil = 0;
        return snap;
      })
      .catch((err: unknown) => {
        if (!this.failUntil) console.warn(`[@inite/site-agents] the INITE service did not answer (${err instanceof Error ? err.message : String(err)}); ${this.good ? "the last good copy is still served" : "nothing to serve yet"}`);
        this.failUntil = this.cfg.now() + Math.min(RETRY_MS, this.cfg.revalidateMs);
        return kept();
      })
      .finally(() => {
        this.pulling = null;
      });
    return this.pulling;
  }

  /** One sync with the service. Throws Transient when the last good copy should stay. */
  private async pull(): Promise<Snapshot> {
    const held = this.good;
    const res = await this.get("/api/site/v1/manifest", held?.etag);
    if (res.status === 304 && held) return { state: "ok", copy: { ...held, syncedAt: this.cfg.now() } };
    if (REFUSED.has(res.status)) return dropped(res);
    if (res.status !== 200) throw new Transient(`manifest answered ${res.status}`);
    let raw: unknown;
    try {
      raw = JSON.parse(res.body);
    } catch {
      throw new Transient("manifest is not JSON");
    }
    const m = parseManifest(raw);
    if (!m) throw new Transient("manifest does not read");

    const files: Copy["files"] = {};
    for (const meta of m.files) {
      const had = held?.files[meta.name];
      // The body is reused when its tag did not move; where and how it is served is always the new manifest's.
      if (had && meta.etag && had.etag === meta.etag) {
        files[meta.name] = { ...had, type: meta.type, path: meta.path };
        continue;
      }
      const got = await this.get(`/api/site/v1/files/${encodeURIComponent(meta.name)}`, had?.etag);
      if (got.status === 304 && had) {
        files[meta.name] = { ...had, type: meta.type, path: meta.path };
        continue;
      }
      if (REFUSED.has(got.status)) return dropped(got);
      if (got.status !== 200) throw new Transient(`${meta.name} answered ${got.status}`);
      files[meta.name] = { body: got.body, type: meta.type, path: meta.path, etag: got.etag || meta.etag };
    }

    return {
      state: "ok",
      copy: { slug: m.site.slug, domain: m.site.domain, version: m.site.version, etag: res.etag, files, head: m.head, syncedAt: this.cfg.now() },
    };
  }

  /** GET a connector path at the configured origin, with the key. Never follows a redirect. */
  private async get(path: string, etag?: string): Promise<Answer> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      Authorization: `Bearer ${this.cfg.key}`,
      "User-Agent": `INITE-Agents-Next/${PACKAGE_VERSION}`,
    };
    if (etag) headers["If-None-Match"] = etag;
    let res: Response;
    try {
      res = await this.cfg.fetch(`${this.cfg.origin}${path}`, { headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Transient(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = res.status === 304 ? "" : await readBody(res);
    return { status: res.status, body, etag: safeEtag(res.headers.get("etag")), type: safeType(res.headers.get("content-type")) };
  }
}

/** Kept in step with package.json by a test. */
export const PACKAGE_VERSION = "0.3.0";

function dropped(res: Answer): Snapshot {
  let error = "refused";
  let message = "";
  try {
    const said = JSON.parse(res.body) as { error?: unknown; message?: unknown };
    if (typeof said.error === "string") error = said.error.slice(0, 60);
    if (typeof said.message === "string") message = said.message.slice(0, 300);
  } catch {
    // quiet: a refusal without a JSON body is still a refusal
  }
  return { state: "dropped", status: res.status, error, message };
}

async function readBody(res: Response): Promise<string> {
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) throw new Transient("body too large");
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new Transient(`body: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (text.length > MAX_BODY) throw new Transient("body too large");
  return text;
}

/** A short hash of the origin and key, for the cache key: the key itself is never written to a cache. */
async function fingerprint(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
