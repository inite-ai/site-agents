/**
 * Articles: the content queue of the INITE connector API, for a site that
 * publishes the articles its owner approved in the INITE cabinet into its
 * own CMS (the WordPress plugin's includes/class-inite-agents-content.php
 * does the same).
 *
 *   GET  /api/site/v1/content/queue          approved, not yet published, for this site key
 *   POST /api/site/v1/content/:id/published  { url }     the same URL twice is one publish
 *   POST /api/site/v1/content/:id/failed     { reason }  the article waits for the owner's "send again"
 *
 * Every call goes to the configured origin only, with the key; the report
 * URLs an item names are never called with it (the rule of sync.ts).
 * Redirects are not followed. Nothing here throws: every answer is a value,
 * a refusal or a failure included.
 */

import { optionsFromEnv, resolve, type Resolved, type SiteAgentsOptions } from "./config";
import { MAX_BODY, PACKAGE_VERSION, TIMEOUT_MS } from "./sync";

/** A source the article was written from. */
export interface ContentSource {
  url: string;
  title: string | null;
}

/** One approved article, as the owner approved it. */
export interface QueueItem {
  id: string;
  lang: string;
  title: string;
  slug: string;
  metaDescription: string;
  /** Markdown, as approved. */
  body: string;
  /** The same text as HTML, rendered once on approve. */
  html: string;
  sources: ContentSource[];
  /** ISO 8601. */
  approvedAt: string;
  /** Where the service takes the outcome. Informational: `published()` and `failed()` build the address from the configured origin. */
  report: { published: string; failed: string };
}

/** A call that did not succeed. `status` 0: no answer (no key, network, timeout, a body that does not read). */
export interface ContentFailure {
  ok: false;
  status: number;
  /** The service's code (`unknown_key`, `disabled`, `not_approved`, `invalid_url`, …) or one of ours (`no_key`, `unreachable`, `redirect`, `bad_answer`). */
  error: string;
  message: string;
  /** Seconds to wait, from Retry-After (429, 503). */
  retryAfter?: number;
}

export type QueueResult = { ok: true; enabled: boolean; items: QueueItem[] } | ContentFailure;
export type PublishedResult = { ok: true; status: "published"; url: string; already: boolean } | ContentFailure;
export type FailedResult = { ok: true; status: "failed"; already: boolean } | ContentFailure;

export interface ContentQueue {
  /** The approved articles this site has not published yet, oldest approval first; at most ten an answer. `enabled: false` while the owner has articles switched off. */
  queue(): Promise<QueueResult>;
  /** Report that the article is live at `url` (on the site's own domain or a subdomain). Safe to retry: the same URL again answers `already: true`. */
  published(id: string, url: string): Promise<PublishedResult>;
  /** Report that it could not be published. It leaves the queue until the owner sends it again. */
  failed(id: string, reason: string): Promise<FailedResult>;
}

const str = (v: unknown): v is string => typeof v === "string";

/** One item as the service sends it, or null when it does not read. */
export function parseQueueItem(raw: unknown): QueueItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const fields = ["id", "lang", "title", "slug", "metaDescription", "body", "html", "approvedAt"] as const;
  for (const f of fields) if (!str(r[f])) return null;
  if (!(r.id as string) || !(r.title as string)) return null;
  const rep = r.report && typeof r.report === "object" ? (r.report as Record<string, unknown>) : null;
  const sources: ContentSource[] = [];
  for (const s of Array.isArray(r.sources) ? r.sources : []) {
    const o = s && typeof s === "object" ? (s as Record<string, unknown>) : null;
    if (o && str(o.url)) sources.push({ url: o.url, title: str(o.title) ? o.title : null });
  }
  return {
    id: r.id as string,
    lang: r.lang as string,
    title: r.title as string,
    slug: r.slug as string,
    metaDescription: r.metaDescription as string,
    body: r.body as string,
    html: r.html as string,
    sources,
    approvedAt: r.approvedAt as string,
    report: { published: rep && str(rep.published) ? rep.published : "", failed: rep && str(rep.failed) ? rep.failed : "" },
  };
}

interface Got {
  status: number;
  json: Record<string, unknown> | null;
  retryAfter?: number;
}

function failure(got: Got | null, fallback: { status: number; error: string; message: string }): ContentFailure {
  const said = got?.json;
  const out: ContentFailure = {
    ok: false,
    status: got?.status ?? fallback.status,
    error: said && str(said.error) ? said.error.slice(0, 60) : fallback.error,
    message: said && str(said.message) ? said.message.slice(0, 300) : fallback.message,
  };
  if (got?.retryAfter !== undefined) out.retryAfter = got.retryAfter;
  return out;
}

async function call(cfg: Resolved, method: "GET" | "POST", path: string, body?: unknown): Promise<Got | ContentFailure> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${cfg.key}`,
    "User-Agent": `INITE-Agents-Next/${PACKAGE_VERSION}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await cfg.fetch(`${cfg.origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, error: "unreachable", message: err instanceof Error ? err.message : String(err) };
  }
  // A redirect is not followed: the key goes to the configured origin and nowhere else.
  if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: "redirect", message: "The service answered with a redirect; it is not followed." };
  const ra = Number(res.headers.get("retry-after"));
  const retryAfter = Number.isFinite(ra) && ra >= 0 && res.headers.get("retry-after") !== null ? ra : undefined;
  let text = "";
  try {
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BODY) return { ok: false, status: res.status, error: "bad_answer", message: "The answer is too large." };
    text = await res.text();
  } catch (err) {
    return { ok: false, status: res.status, error: "unreachable", message: err instanceof Error ? err.message : String(err) };
  }
  if (text.length > MAX_BODY) return { ok: false, status: res.status, error: "bad_answer", message: "The answer is too large." };
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    // quiet: a body that is not JSON is judged by its status below
  }
  return { status: res.status, json, ...(retryAfter !== undefined ? { retryAfter } : {}) };
}

const isFailure = (v: Got | ContentFailure): v is ContentFailure => "ok" in v && v.ok === false;

/**
 * The content queue of one site key. With no options it reads the
 * environment as the route files do (INITE_SITE_KEY, INITE_ORIGIN).
 */
export function createContentQueue(opts: SiteAgentsOptions = optionsFromEnv()): ContentQueue {
  const cfg = resolve(opts);
  const noKey = (): ContentFailure => ({ ok: false, status: 0, error: "no_key", message: cfg.problem ?? "no site key" });
  const outcome = (id: string, which: "published" | "failed") => `/api/site/v1/content/${encodeURIComponent(id)}/${which}`;

  return {
    async queue() {
      if (!cfg.key) return noKey();
      const got = await call(cfg, "GET", "/api/site/v1/content/queue");
      if (isFailure(got)) return got;
      const j = got.json;
      if (got.status !== 200 || !j || j.ok !== true) return failure(got, { status: got.status, error: got.status === 200 ? "bad_answer" : "refused", message: `The queue answered ${got.status}.` });
      const items = (Array.isArray(j.items) ? j.items : []).map(parseQueueItem).filter((i): i is QueueItem => i !== null);
      return { ok: true, enabled: j.enabled === true, items };
    },

    async published(id, url) {
      if (!cfg.key) return noKey();
      if (!str(id) || !id) return { ok: false, status: 0, error: "not_found", message: "No article id." };
      const got = await call(cfg, "POST", outcome(id, "published"), { url });
      if (isFailure(got)) return got;
      const j = got.json;
      if (got.status !== 200 || !j || j.ok !== true || !str(j.url)) return failure(got, { status: got.status, error: got.status === 200 ? "bad_answer" : "refused", message: `The report answered ${got.status}.` });
      return { ok: true, status: "published", url: j.url, already: j.already === true };
    },

    async failed(id, reason) {
      if (!cfg.key) return noKey();
      if (!str(id) || !id) return { ok: false, status: 0, error: "not_found", message: "No article id." };
      const got = await call(cfg, "POST", outcome(id, "failed"), { reason });
      if (isFailure(got)) return got;
      const j = got.json;
      if (got.status !== 200 || !j || j.ok !== true) return failure(got, { status: got.status, error: got.status === 200 ? "bad_answer" : "refused", message: `The report answered ${got.status}.` });
      return { ok: true, status: "failed", already: j.already === true };
    },
  };
}
