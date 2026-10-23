/**
 * The site's own content, sent to INITE (POST /api/site/v1/records), as the
 * WordPress plugin sends it (includes/class-inite-agents-records.php): the
 * app passes what it publishes, and INITE lists it in llms.txt and
 * llms-full.txt, and serves the products through the company's MCP server
 * once the owner turns on "Publish my catalogue" in the cabinet.
 *
 *   const sync = createContentSync({
 *     content: async () => (await getPages()).map((p) => ({ id: p.slug, type: "page", title: p.title, url: p.url, excerpt: p.summary })),
 *     products: async () => (await getProducts()).map(...),
 *   });
 *   await sync.sync(); // from a cron route, a build step or a webhook of your CMS
 *
 * Nothing is sent for a group the app does not pass: passing it is the
 * owner's yes. Each run sends only the items that changed since this
 * process last sent them, a hundred at a time, and then the ids still there
 * (`present`), so INITE drops what the app no longer lists. Pass a group as
 * `null` to have INITE delete everything it holds of it.
 *
 * Every call goes to the configured origin only, with the key, without
 * following redirects. Nothing here throws: every answer is a value.
 */

import { optionsFromEnv, resolve, type SiteAgentsOptions } from "./config";
import { PACKAGE_VERSION } from "./sync";

/** A published page or post. Only what anyone can read on the site. */
export interface PageItem {
  id: string | number;
  type: "page" | "post";
  title: string;
  url: string;
  /** The excerpt, or the first characters of the text; INITE keeps 300. */
  excerpt?: string;
  /** ISO 8601. */
  modified?: string;
  language?: string;
}

/** A product as the store sells it. */
export interface ProductItem {
  id: string | number;
  name: string;
  url: string;
  /** The price it sells at now. */
  price?: number | string;
  regularPrice?: number | string;
  salePrice?: number | string;
  /** ISO 4217, e.g. "EUR". */
  currency?: string;
  stock?: "instock" | "outofstock" | "onbackorder";
  sku?: string;
  excerpt?: string;
  categories?: string[];
  image?: string;
  modified?: string;
}

/** An upcoming event. */
export interface EventItem {
  id: string | number;
  title: string;
  url: string;
  /** ISO 8601. */
  starts: string;
  ends?: string;
  venue?: string;
  excerpt?: string;
  modified?: string;
}

type Awaitable<T> = T | Promise<T>;

/** What the app publishes, per group. A group left out is never sent; `null` deletes it at INITE. */
export interface ContentProvider {
  content?: (() => Awaitable<PageItem[]>) | null;
  products?: (() => Awaitable<ProductItem[]>) | null;
  events?: (() => Awaitable<EventItem[]>) | null;
}

export type Group = keyof ContentProvider;
const GROUPS: Group[] = ["content", "products", "events"];

/** As the service holds them (https://inite.ai/en/mcp#site-api, records). */
export const RECORDS_PAGE = 100;
export const RECORDS_CAP: Record<Group, number> = { content: 2000, products: 2000, events: 200 };
const PRESENT_MAX = 5000;
const TIMEOUT_MS = 15_000;

export interface GroupResult {
  /** Items sent this run (the changed ones). */
  sent: number;
  /** What INITE holds of the group after the run, when it said. */
  held: number | null;
  cleared?: boolean;
  /** Why the run stopped: the service's code, or `unreachable`, `redirect`, `bad_answer`. */
  error?: string;
  status?: number;
}

export type ContentSyncResult = { ok: boolean; groups: Partial<Record<Group, GroupResult>>; error?: string };

export interface ContentSync {
  /** One run over the groups the app passed. */
  sync(): Promise<ContentSyncResult>;
  /** A run if the last one is older than `everyMinutes` (default 60); otherwise null. */
  maybeSync(): Promise<ContentSyncResult | null>;
}

/** A stable string of an item, keys sorted: an item sent unchanged is not sent again. */
function print(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(print).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${print((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function createContentSync(provider: ContentProvider, opts: SiteAgentsOptions & { everyMinutes?: number } = optionsFromEnv()): ContentSync {
  const cfg = resolve(opts);
  const everyMs = Math.max(1, opts.everyMinutes ?? 60) * 60_000;
  const sent = new Map<Group, Map<string, string>>();
  let last = Number.NEGATIVE_INFINITY;
  let running: Promise<ContentSyncResult> | null = null;

  const post = async (group: Group, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> | null } | { error: string }> => {
    let res: Response;
    try {
      res = await cfg.fetch(`${cfg.origin}/api/site/v1/records`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": `INITE-Agents-Next/${PACKAGE_VERSION}` },
        body: JSON.stringify({ group, ...body }),
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // quiet: the run reports it as unreachable and the next run sends again
      return { error: "unreachable" };
    }
    if (res.status >= 300 && res.status < 400) return { error: "redirect" };
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // quiet: a body that is not JSON is judged by its status
    }
    return { status: res.status, json };
  };

  const failed = (got: Awaited<ReturnType<typeof post>>, sentCount: number): GroupResult | null => {
    if ("error" in got) return { sent: sentCount, held: null, error: got.error };
    if (got.status === 200 && got.json?.ok === true) return null;
    return { sent: sentCount, held: null, status: got.status, error: typeof got.json?.error === "string" ? got.json.error.slice(0, 60) : "bad_answer" };
  };

  const runGroup = async (group: Group, list: () => Awaitable<unknown[]>): Promise<GroupResult> => {
    let items: { id: string }[];
    try {
      items = ((await list()) ?? [])
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map((i) => ({ ...i, id: String(i.id) }))
        .slice(0, RECORDS_CAP[group]);
    } catch (err) {
      return { sent: 0, held: null, error: `provider: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120) };
    }
    const had = sent.get(group) ?? new Map<string, string>();
    const now = new Map(items.map((i) => [i.id, print(i)]));
    const changed = items.filter((i) => had.get(i.id) !== now.get(i.id));
    let held: number | null = null;
    let count = 0;
    for (let at = 0; at < changed.length; at += RECORDS_PAGE) {
      const page = changed.slice(at, at + RECORDS_PAGE);
      const got = await post(group, { items: page });
      const bad = failed(got, count);
      if (bad) return bad;
      count += page.length;
      for (const i of page) had.set(i.id, now.get(i.id)!);
      if (!("error" in got) && typeof got.json?.held === "number") held = got.json.held;
    }
    // What went: anything this process sent before and the app no longer lists.
    const gone = Array.from(had.keys()).some((id) => !now.has(id));
    if (items.length <= PRESENT_MAX && (gone || !sent.has(group))) {
      const got = await post(group, { present: items.map((i) => i.id) });
      const bad = failed(got, count);
      if (bad) return bad;
      if (!("error" in got) && typeof got.json?.held === "number") held = got.json.held;
      for (const id of Array.from(had.keys())) if (!now.has(id)) had.delete(id);
    }
    sent.set(group, had);
    return { sent: count, held };
  };

  const run = async (): Promise<ContentSyncResult> => {
    if (!cfg.key) return { ok: false, groups: {}, error: cfg.problem ?? "no site key" };
    const groups: Partial<Record<Group, GroupResult>> = {};
    let ok = true;
    for (const group of GROUPS) {
      if (!(group in provider)) continue;
      const list = provider[group];
      if (list === null) {
        const got = await post(group, { clear: true });
        const bad = failed(got, 0);
        groups[group] = bad ?? { sent: 0, held: 0, cleared: true };
        if (!bad) sent.delete(group);
      } else if (typeof list === "function") {
        groups[group] = await runGroup(group, list as () => Awaitable<unknown[]>);
      }
      const g = groups[group];
      if (g?.error) ok = false;
      // A refused key stops the run: every other group would be refused the same way.
      if (g?.status === 401 || g?.status === 403 || g?.status === 409) break;
    }
    return { ok, groups };
  };

  return {
    sync() {
      if (running) return running;
      last = cfg.now();
      running = run().finally(() => {
        running = null;
      });
      return running;
    },
    async maybeSync() {
      if (running || cfg.now() - last < everyMs) return null;
      return this.sync();
    },
  };
}
