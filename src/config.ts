/**
 * The options of `createSiteAgents`, resolved once.
 *
 * The origin is the one address the site key is ever sent to: every call is
 * built from it, never from a URL a response names (the WordPress plugin's
 * rule, includes/class-inite-agents-client.php). It must be https; plain
 * http is taken only for a local service (localhost, 127.0.0.1, ::1), so a
 * key cannot leave in clear text by a typo in production.
 */

export const DEFAULT_ORIGIN = "https://inite.ai";

/** What a site can switch off. Each is on by default once a key is set. */
export interface SiteAgentsFeatures {
  /** /llms.txt and /.well-known/{agent-card.json, mcp.json, api-catalog}. */
  files?: boolean;
  /** The Content-Signal line in robots.txt (robotsSignal, robotsRoute). */
  robots?: boolean;
  /** The <link> tags that tell an agent where the MCP server, llms.txt and the cards live. */
  head?: boolean;
  /** The WebMCP script: read-only tools an agent in the browser can call. */
  webmcp?: boolean;
  /** The JSON-LD (Organization, FAQPage) of the confirmed facts, in the page. */
  jsonLd?: boolean;
  /** The daily-ish ping: package version, served paths, known AI agents counted per day. */
  ping?: boolean;
}

export type FeatureName = keyof SiteAgentsFeatures;
export const FEATURES: readonly FeatureName[] = ["files", "robots", "head", "webmcp", "jsonLd", "ping"];

export interface SiteAgentsOptions {
  /** The site key from the "For agents" tab of the INITE cabinet (isk_…). Usually process.env.INITE_SITE_KEY. */
  key: string | undefined | null;
  /** The INITE service. Default https://inite.ai. */
  origin?: string;
  /** Switch features off; anything not named stays on. */
  features?: SiteAgentsFeatures;
  /** Seconds a copy is used before the service is asked again (with its ETag). Default 3600. */
  revalidate?: number;
  /**
   * Where the copy is kept between requests. "next" (default) keeps the
   * decision in Next's data cache (unstable_cache) so every instance of a
   * deployment shares it, and in memory; "memory" keeps it only in this
   * process. Outside a Next server "next" falls back to memory by itself.
   */
  cache?: "next" | "memory";
  /** Hours between pings from one process. Default 24. */
  pingEveryHours?: number;
  /**
   * The site's own pages, products and events, for INITE to list in llms.txt
   * and llms-full.txt and, once the owner publishes the catalogue, to serve
   * through the MCP (records.ts). Passing a group is sending it; leave out
   * what should not leave the site. Sent at most every `contentEveryMinutes`
   * (default 60), after a response.
   */
  content?: import("./records").ContentProvider;
  contentEveryMinutes?: number;
  /** For tests: the fetch to use. */
  fetch?: typeof fetch;
  /** For tests: the clock. */
  now?: () => number;
}

export interface Resolved {
  key: string | null;
  origin: string;
  features: Required<SiteAgentsFeatures>;
  revalidateMs: number;
  cache: "next" | "memory";
  pingEveryMs: number;
  fetch: typeof fetch;
  now: () => number;
  /** Why nothing is served, when the options themselves say so. */
  problem: string | null;
}

const KEY_SHAPE = /^isk_[A-Za-z0-9_-]{32}$/;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin as `scheme://host[:port]`, or null when it is not one the key may go to. */
export function safeOrigin(raw: string | undefined): string | null {
  let u: URL;
  try {
    u = new URL(raw ?? DEFAULT_ORIGIN);
  } catch {
    // quiet: a malformed origin is the site's configuration; resolve() says why nothing is served
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && LOCAL.has(u.hostname)) return u.origin;
  return null;
}

export function resolve(opts: SiteAgentsOptions): Resolved {
  const key = typeof opts.key === "string" && KEY_SHAPE.test(opts.key.trim()) ? opts.key.trim() : null;
  const origin = safeOrigin(opts.origin);
  const problem = !opts.key
    ? "INITE_SITE_KEY is not set"
    : !key
      ? "the site key does not look like isk_ and 32 characters"
      : !origin
        ? "the origin must be https (http only for localhost)"
        : null;
  const on = !problem;
  const features = Object.fromEntries(FEATURES.map((f) => [f, on && opts.features?.[f] !== false])) as Required<SiteAgentsFeatures>;
  const revalidate = typeof opts.revalidate === "number" && opts.revalidate > 0 ? opts.revalidate : 3600;
  const pingHours = typeof opts.pingEveryHours === "number" && opts.pingEveryHours > 0 ? opts.pingEveryHours : 24;
  return {
    key: on ? key : null,
    origin: origin ?? DEFAULT_ORIGIN,
    features,
    revalidateMs: Math.round(revalidate * 1000),
    cache: opts.cache ?? "next",
    pingEveryMs: Math.round(pingHours * 3_600_000),
    fetch: opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    now: opts.now ?? Date.now,
    problem,
  };
}

/**
 * Options from the environment, for the one-line route files:
 *   INITE_SITE_KEY        the site key
 *   INITE_ORIGIN          the service, default https://inite.ai
 *   INITE_SITE_AGENTS_OFF features to switch off, comma-separated (e.g. "ping,jsonLd")
 *   INITE_SITE_AGENTS_REVALIDATE  seconds a copy is used, default 3600
 */
export function optionsFromEnv(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): SiteAgentsOptions {
  const off = new Set(
    (env.INITE_SITE_AGENTS_OFF ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const features: SiteAgentsFeatures = {};
  for (const f of FEATURES) if (off.has(f.toLowerCase())) features[f] = false;
  const revalidate = Number(env.INITE_SITE_AGENTS_REVALIDATE);
  return { key: env.INITE_SITE_KEY, origin: env.INITE_ORIGIN || undefined, features, ...(revalidate > 0 ? { revalidate } : {}) };
}
