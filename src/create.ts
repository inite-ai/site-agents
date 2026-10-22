/**
 * createSiteAgents: one site's connector to INITE, for a Next.js app.
 *
 * Everything it hands out reads one copy, kept by SiteSync (sync.ts), and
 * no request on the site ever waits on more than one round trip to the
 * service per `revalidate` period. Two calls with the same key and origin
 * share that copy, and so do the separate bundles Next builds for route
 * handlers and pages: it lives on globalThis.
 */

import type { ReactElement } from "react";
import { optionsFromEnv, resolve, type Resolved, type SiteAgentsOptions } from "./config";
import { makeHead, type HeadParts } from "./head";
import { isRootPath, type RootPath } from "./manifest";
import { Visits } from "./ping";
import { renderRobots, signalLines, withContentSignal, type RobotsObject } from "./robots";
import { SiteSync, type CopyFile, type Snapshot } from "./sync";

type Params<T> = { params: Promise<T> | T };
export type RouteHandler = (req: Request) => Promise<Response>;
export type WellKnownHandler = (req: Request, ctx: Params<{ file: string }>) => Promise<Response>;
export type RobotsBase = string | RobotsObject | (() => string | RobotsObject | Promise<string | RobotsObject>);

export interface SiteAgents {
  /** app/llms.txt/route.ts: `export const { GET, HEAD } = agents.llmsTxt` */
  llmsTxt: { GET: RouteHandler; HEAD: RouteHandler };
  /** app/.well-known/[file]/route.ts: agent-card.json, mcp.json, api-catalog. */
  wellKnown: { GET: WellKnownHandler; HEAD: WellKnownHandler };
  /** app/robots.txt/route.ts: your rules (the object app/robots.ts returned, or text) with the Content-Signal line added. */
  robotsRoute(base?: RobotsBase): { GET: RouteHandler };
  /** The Content-Signal line(s) to add to a robots.txt you write yourself, or null. */
  robotsSignal(): Promise<string | null>;
  /** The server component for the root layout. */
  Head: () => Promise<ReactElement | null>;
  /** The head's parts, for rendering them yourself (the pages router's _document, another framework). */
  headParts(): Promise<HeadParts | null>;
  /** The copy held and its state: for a status page or a health check. */
  status(): Promise<Snapshot>;
}

const NOT_FOUND = () => new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const UNAVAILABLE = () =>
  new Response("Service Unavailable\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" } });

/** Whether the caller already holds this ETag (If-None-Match, a list or `*`). */
export function holds(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch || !etag) return false;
  const want = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === "*" || v === want;
  });
}

function serve(req: Request, file: CopyFile): Response {
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
  if (file.etag) headers.ETag = file.etag;
  if (holds(req.headers.get("if-none-match"), file.etag)) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : file.body, { headers });
}

/** Run after the response when Next can (`after`), else in the background. Never throws. */
async function later(task: () => Promise<void>): Promise<void> {
  try {
    const { after } = await import("next/server");
    if (typeof after === "function") {
      after(task);
      return;
    }
  } catch {
    // quiet: outside a request scope or before Next 15; run it in the background instead
  }
  void task().catch(() => {});
}

interface Instance {
  cfg: Resolved;
  sync: SiteSync;
  visits: Visits;
  robotsServed: boolean;
}

const REGISTRY = Symbol.for("@inite/site-agents/instances");

function instanceFor(opts: SiteAgentsOptions): Instance {
  const cfg = resolve(opts);
  // Tests pass their own fetch and clock: those never share.
  if (opts.fetch || opts.now) return { cfg, sync: new SiteSync(cfg), visits: new Visits(cfg), robotsServed: false };
  const g = globalThis as unknown as Record<symbol, Map<string, Instance> | undefined>;
  const all = (g[REGISTRY] ??= new Map());
  const id = JSON.stringify([cfg.origin, cfg.key, cfg.features, cfg.revalidateMs, cfg.cache, cfg.pingEveryMs]);
  let inst = all.get(id);
  if (!inst) {
    if (cfg.problem && typeof console !== "undefined") console.warn(`[@inite/site-agents] nothing is served: ${cfg.problem}`);
    inst = { cfg, sync: new SiteSync(cfg), visits: new Visits(cfg), robotsServed: false };
    all.set(id, inst);
  }
  return inst;
}

export function createSiteAgents(opts: SiteAgentsOptions): SiteAgents {
  const inst = instanceFor(opts);
  const { cfg, sync, visits } = inst;

  const servedPaths = (snap: Snapshot): string[] => {
    const out: string[] = [];
    if (snap.state === "ok" && cfg.features.files) for (const f of Object.values(snap.copy.files)) if (f?.path) out.push(f.path);
    if (inst.robotsServed && cfg.features.robots) out.push("/robots.txt");
    return out;
  };

  const counted = (req: Request, path: string, snap: Snapshot) => {
    visits.count(path, req.headers.get("user-agent"));
    if (visits.due()) void later(() => visits.maybePing(servedPaths(snap)));
  };

  const fileAt = async (req: Request, path: RootPath): Promise<Response> => {
    if (!cfg.features.files) return NOT_FOUND();
    const snap = await sync.snapshot();
    if (snap.state === "none") return snap.error === "unreachable" ? UNAVAILABLE() : NOT_FOUND();
    if (snap.state === "dropped") return NOT_FOUND();
    const file = Object.values(snap.copy.files).find((f) => f?.path === path);
    if (!file) return NOT_FOUND();
    counted(req, path, snap);
    return serve(req, file);
  };

  const llms: RouteHandler = (req) => fileAt(req, "/llms.txt");
  const wellKnown: WellKnownHandler = async (req, ctx) => {
    const { file } = await ctx.params;
    const path = `/.well-known/${file}`;
    return isRootPath(path) ? fileAt(req, path) : NOT_FOUND();
  };

  const robotsSignal = async (): Promise<string | null> => {
    if (!cfg.features.robots) return null;
    const snap = await sync.snapshot();
    if (snap.state !== "ok") return null;
    return signalLines(snap.copy.files["robots-signal"]?.body) || null;
  };

  const headParts = async (): Promise<HeadParts | null> => {
    if (!cfg.features.head && !cfg.features.webmcp && !cfg.features.jsonLd) return null;
    const snap = await sync.snapshot();
    if (snap.state !== "ok") return null;
    const h = snap.copy.head;
    return {
      script: cfg.features.webmcp ? h.script : null,
      links: cfg.features.head ? h.links : [],
      jsonLd: cfg.features.jsonLd ? h.jsonLd : null,
    };
  };

  return {
    llmsTxt: { GET: llms, HEAD: llms },
    wellKnown: { GET: wellKnown, HEAD: wellKnown },
    robotsRoute(base) {
      return {
        GET: async (req) => {
          let text = "User-agent: *\nAllow: /\n";
          try {
            const b = typeof base === "function" ? await base() : base;
            if (typeof b === "string") text = b;
            else if (b) text = renderRobots(b);
          } catch (err) {
            // quiet: the site's own rules failed to build; robots.txt still answers, open, and the log says why
            console.warn("[@inite/site-agents] robots base:", err instanceof Error ? err.message : err);
          }
          const line = await robotsSignal();
          if (line) {
            inst.robotsServed = true;
            text = withContentSignal(text, line);
            counted(req, "/robots.txt", await sync.snapshot());
          }
          return new Response(req.method === "HEAD" ? null : text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
        },
      };
    },
    robotsSignal,
    Head: makeHead(headParts),
    headParts,
    status: () => sync.snapshot(),
  };
}

const DEFAULT = Symbol.for("@inite/site-agents/default");

/** The instance the one-line route files and <SiteAgentsHead /> use: configured from the environment (config.ts optionsFromEnv). */
export function defaultSiteAgents(): SiteAgents {
  const g = globalThis as unknown as Record<symbol, SiteAgents | undefined>;
  return (g[DEFAULT] ??= createSiteAgents(optionsFromEnv()));
}
