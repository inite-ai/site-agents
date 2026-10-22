import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createSiteAgents, type SiteAgentsOptions } from "./create";
import { agentOf, AI_AGENTS } from "./agents";
import { optionsFromEnv, safeOrigin } from "./config";
import { renderRobots, withContentSignal } from "./robots";
import { PACKAGE_VERSION } from "./sync";

const KEY = "isk_" + "A".repeat(32);
const ORIGIN = "https://inite.example";

/** Bodies as the service sends them (app/api/site/v1/files/:name), byte for byte. */
const BODIES = {
  "llms.txt": "# Acme Dental\n\n> Confirmed by Acme Dental on 2026-10-22.\n\n- Cleaning: R$ 200 — à vista\n",
  "agent-card.json": '{\n  "name": "Acme Dental",\n  "url": "https://acme.inite.ai/a2a"\n}\n',
  "mcp.json": '{\n  "name": "ai.inite/acme",\n  "remotes": [{ "type": "streamable-http", "url": "https://acme.inite.ai/mcp" }]\n}\n',
  "api-catalog": '{\n  "linkset": [{ "anchor": "https://acme.inite.ai/mcp" }]\n}\n',
  "robots-signal": "Content-Signal: search=yes, ai-input=yes, ai-train=no\n",
  jsonld: '{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "Acme </script>"\n}\n',
} as const;
type Name = keyof typeof BODIES;

const TYPES: Record<Name, string> = {
  "llms.txt": "text/plain; charset=utf-8",
  "agent-card.json": "application/json; charset=utf-8",
  "mcp.json": "application/json; charset=utf-8",
  "api-catalog": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  "robots-signal": "text/plain; charset=utf-8",
  jsonld: "application/json; charset=utf-8",
};

const PATHS: Record<Name, string | null> = {
  "llms.txt": "/llms.txt",
  "agent-card.json": "/.well-known/agent-card.json",
  "mcp.json": "/.well-known/mcp.json",
  "api-catalog": "/.well-known/api-catalog",
  "robots-signal": null,
  jsonld: null,
};

/** A fake INITE service: the manifest and files of one version, and a switch for how it answers. */
function service(version = 3) {
  const state = { version, mode: "ok" as "ok" | 500 | 401 | 403 | 409 | "network" | "redirect" };
  const calls: { url: string; headers: Record<string, string>; method: string; body?: string }[] = [];
  const manifest = () => ({
    ok: true,
    site: { slug: "acme", domain: "acme.com", version: state.version, confirmedAt: "2026-10-22T10:00:00.000Z" },
    connector: { id: "c1", platform: "next", enabled: true },
    mcp: { url: "https://acme.inite.ai/mcp" },
    files: (Object.keys(BODIES) as Name[]).map((name) => ({
      name,
      path: PATHS[name],
      placement: PATHS[name] ? "path" : name === "jsonld" ? "head" : "robots",
      contentType: TYPES[name],
      // A file's own url is ignored: the key goes only to the configured origin.
      url: `https://evil.example/steal/${name}`,
      available: true,
      etag: `"f${state.version}-${name}"`,
    })),
    head: {
      html: "<script>ignored</script>",
      script: { src: `https://inite.example/api/site/v1/webmcp.js?s=acme&d=acme.com&v=${state.version}`, async: true },
      links: [
        { rel: "mcp", href: "https://acme.inite.ai/mcp" },
        { rel: "service-doc", href: "https://acme.inite.ai/llms.txt", type: "text/plain" },
        { rel: "bad rel", href: "https://x.example" },
        { rel: "describedby", href: "javascript:alert(1)" },
      ],
      jsonLd: { "@context": "https://schema.org", "@type": "Organization", name: "Acme </script><b>" },
    },
    features: { files: true, head: true, webmcp: true, content: { enabled: false } },
    poll: { afterSeconds: 300 },
  });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (state.mode === "network") throw new TypeError("fetch failed");
    if (state.mode === "redirect") return new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
    if (typeof state.mode === "number") {
      const error = { 401: "revoked", 403: "disabled", 409: "unconfirmed", 500: "unavailable" }[state.mode];
      return Response.json({ ok: false, error, message: `said ${error}` }, { status: state.mode });
    }
    const u = new URL(url);
    if (u.pathname === "/api/site/v1/ping") return Response.json({ ok: true });
    if (u.pathname === "/api/site/v1/manifest") {
      const etag = `"m${state.version}-hash"`;
      if (headers["if-none-match"] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return Response.json(manifest(), { headers: { ETag: etag } });
    }
    const m = /^\/api\/site\/v1\/files\/(.+)$/.exec(u.pathname);
    if (m) {
      const name = decodeURIComponent(m[1]) as Name;
      const etag = `"f${state.version}-${name}"`;
      if (headers["if-none-match"] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(BODIES[name], { headers: { "Content-Type": TYPES[name], ETag: etag } });
    }
    return new Response("nope", { status: 404 });
  });
  return { state, calls, fetch: fetchMock as unknown as typeof fetch };
}

function setup(opts: Partial<SiteAgentsOptions> = {}, version = 3) {
  const svc = service(version);
  let now = Date.parse("2026-10-22T12:00:00Z");
  const agents = createSiteAgents({ key: KEY, origin: ORIGIN, cache: "memory", fetch: svc.fetch, now: () => now, ...opts });
  const tick = (ms: number) => (now += ms);
  return { svc, agents, tick };
}

const req = (path: string, headers: Record<string, string> = {}, method = "GET") => new Request(`https://acme.com${path}`, { headers, method });
const wk = (file: string) => ({ params: Promise.resolve({ file }) });
const HOUR = 3_600_000;

describe("serving the files", () => {
  it("serves the service's bytes and content types at the root paths", async () => {
    const { agents } = setup();
    const llms = await agents.llmsTxt.GET(req("/llms.txt"));
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toBe(TYPES["llms.txt"]);
    expect(new Uint8Array(await llms.arrayBuffer())).toEqual(new TextEncoder().encode(BODIES["llms.txt"]));
    expect(llms.headers.get("etag")).toBe('"f3-llms.txt"');
    expect(llms.headers.get("x-content-type-options")).toBe("nosniff");
    expect(llms.headers.get("access-control-allow-origin")).toBe("*");

    for (const name of ["agent-card.json", "mcp.json", "api-catalog"] as const) {
      const res = await agents.wellKnown.GET(req(`/.well-known/${name}`), wk(name));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(TYPES[name]);
      expect(await res.text()).toBe(BODIES[name]);
    }
  });

  it("claims only the four root paths", async () => {
    const { agents } = setup();
    for (const file of ["openid-configuration", "jsonld", "robots-signal", "..%2Fllms.txt", "security.txt"]) {
      expect((await agents.wellKnown.GET(req(`/.well-known/${file}`), wk(file))).status).toBe(404);
    }
  });

  it("answers 304 to a reader holding the file, and HEAD without a body", async () => {
    const { agents } = setup();
    const res = await agents.llmsTxt.GET(req("/llms.txt", { "if-none-match": '"f3-llms.txt"' }));
    expect(res.status).toBe(304);
    const head = await agents.llmsTxt.HEAD(req("/llms.txt", {}, "HEAD"));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("sends the key only to the configured origin, never following a redirect", async () => {
    const { agents, svc } = setup();
    await agents.llmsTxt.GET(req("/llms.txt"));
    expect(svc.calls.length).toBeGreaterThan(1);
    for (const c of svc.calls) {
      expect(c.url.startsWith(`${ORIGIN}/api/site/v1/`)).toBe(true);
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
    }
    const init = (svc.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  it("refuses an origin the key must not go to", () => {
    expect(safeOrigin("http://inite.ai")).toBeNull();
    expect(safeOrigin("https://user:pw@inite.ai")).toBeNull();
    expect(safeOrigin("not a url")).toBeNull();
    expect(safeOrigin("http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(safeOrigin(undefined)).toBe("https://inite.ai");
  });
});

describe("keeping the copy", () => {
  it("asks again after revalidate with the ETag, and a 304 fetches no file", async () => {
    const { agents, svc, tick } = setup({ revalidate: 60 });
    await agents.llmsTxt.GET(req("/llms.txt"));
    const first = svc.calls.length;
    expect(first).toBe(1 + 6);

    await agents.llmsTxt.GET(req("/llms.txt"));
    expect(svc.calls.length).toBe(first); // inside the period: no call at all

    tick(61_000);
    const res = await agents.llmsTxt.GET(req("/llms.txt"));
    expect(await res.text()).toBe(BODIES["llms.txt"]);
    expect(svc.calls.length).toBe(first + 1);
    expect(svc.calls[first].headers["if-none-match"]).toBe('"m3-hash"');
  });

  it("a new version is fetched whole and replaces the copy", async () => {
    const { agents, svc, tick } = setup({ revalidate: 60 });
    await agents.llmsTxt.GET(req("/llms.txt"));
    svc.state.version = 4;
    tick(61_000);
    const res = await agents.llmsTxt.GET(req("/llms.txt"));
    expect(res.headers.get("etag")).toBe('"f4-llms.txt"');
    expect(svc.calls.filter((c) => c.url.endsWith("/files/llms.txt")).at(-1)?.headers["if-none-match"]).toBe('"f3-llms.txt"');
  });

  it.each([500, "network", "redirect"] as const)("a failure (%s) keeps the last good copy", async (mode) => {
    const { agents, svc, tick } = setup({ revalidate: 60 });
    await agents.llmsTxt.GET(req("/llms.txt"));
    svc.state.mode = mode;
    tick(61_000);
    const res = await agents.llmsTxt.GET(req("/llms.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODIES["llms.txt"]);
    expect(renderToStaticMarkup((await agents.Head())!)).toContain("webmcp.js");
    expect((await agents.status()).state).toBe("ok");
  });

  it("a failure before any copy serves nothing and asks again within a minute", async () => {
    const { agents, svc, tick } = setup();
    svc.state.mode = 500;
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(503);
    expect(await agents.Head()).toBeNull();
    svc.state.mode = "ok";
    tick(30_000);
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(503);
    tick(31_000);
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(200);
  });

  it.each([401, 403, 409] as const)("%s drops the copy: the paths 404 and the head renders nothing", async (status) => {
    const { agents, svc, tick } = setup({ revalidate: 60 });
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(200);
    svc.state.mode = status;
    tick(61_000);
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(404);
    expect((await agents.wellKnown.GET(req("/.well-known/mcp.json"), wk("mcp.json"))).status).toBe(404);
    expect(await agents.Head()).toBeNull();
    expect(await agents.robotsSignal()).toBeNull();
    const snap = await agents.status();
    expect(snap).toMatchObject({ state: "dropped", status });
    // Dropped for good: no stale copy comes back when the service then fails.
    svc.state.mode = 500;
    tick(61_000);
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(503);
  });
});

describe("a file whose fetch fails mid-sync", () => {
  it("keeps serving the previous version whole", async () => {
    const svc = service(3);
    let now = 0;
    let failMcp = false;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
      failMcp && String(input).endsWith("/files/mcp.json") ? new Response("down", { status: 502 }) : svc.fetch(input, init)) as typeof fetch;
    const agents = createSiteAgents({ key: KEY, origin: ORIGIN, cache: "memory", revalidate: 60, fetch: fetchFn, now: () => now });
    await agents.llmsTxt.GET(req("/llms.txt"));
    svc.state.version = 4;
    failMcp = true;
    now += 61_000;
    const llms = await agents.llmsTxt.GET(req("/llms.txt"));
    expect(llms.headers.get("etag")).toBe('"f3-llms.txt"');
    const mcp = await agents.wellKnown.GET(req("/.well-known/mcp.json"), wk("mcp.json"));
    expect(mcp.headers.get("etag")).toBe('"f3-mcp.json"');
  });
});

describe("switches", () => {
  it("without a key nothing is served and the service is never called", async () => {
    const svc = service();
    const agents = createSiteAgents({ key: undefined, origin: ORIGIN, cache: "memory", fetch: svc.fetch });
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(404);
    expect((await agents.wellKnown.GET(req("/.well-known/mcp.json"), wk("mcp.json"))).status).toBe(404);
    expect(await agents.Head()).toBeNull();
    expect(await agents.robotsSignal()).toBeNull();
    expect(svc.calls).toHaveLength(0);
  });

  it("a malformed key or a plain-http origin serves nothing", async () => {
    for (const o of [{ key: "isk_short" }, { key: KEY, origin: "http://inite.ai" }]) {
      const svc = service();
      const agents = createSiteAgents({ origin: ORIGIN, cache: "memory", fetch: svc.fetch, ...o });
      expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(404);
      expect(svc.calls).toHaveLength(0);
    }
  });

  it("files off: the root paths 404 and the service is not asked for them", async () => {
    const { agents, svc } = setup({ features: { files: false } });
    expect((await agents.llmsTxt.GET(req("/llms.txt"))).status).toBe(404);
    expect((await agents.wellKnown.GET(req("/.well-known/agent-card.json"), wk("agent-card.json"))).status).toBe(404);
    expect(svc.calls).toHaveLength(0);
  });

  it("each head part has its own switch, and all off renders nothing", async () => {
    const html = async (f: SiteAgentsOptions["features"]) => {
      const el = await setup({ features: f }).agents.Head();
      return el ? renderToStaticMarkup(el) : "";
    };
    const all = await html({});
    expect(all).toContain('<script src="https://inite.example/api/site/v1/webmcp.js?s=acme&amp;d=acme.com&amp;v=3" async="" crossorigin="anonymous"></script>');
    expect(all).toContain('<link rel="mcp" href="https://acme.inite.ai/mcp"/>');
    expect(all).toContain('<link rel="service-doc" href="https://acme.inite.ai/llms.txt" type="text/plain"/>');
    expect(all).not.toContain("javascript:");
    expect(all).not.toContain("bad rel");
    expect(all).not.toContain("ignored");
    expect(all).toContain('<script type="application/ld+json">');
    expect(all).not.toContain("</script><b>");
    expect(all).toContain("\\u003c/script\\u003e\\u003cb\\u003e");

    const noScript = await html({ webmcp: false });
    expect(noScript).not.toContain("webmcp.js");
    expect(noScript).toContain('rel="mcp"');
    const noLinks = await html({ head: false });
    expect(noLinks).not.toContain("<link");
    expect(noLinks).toContain("webmcp.js");
    const noLd = await html({ jsonLd: false });
    expect(noLd).not.toContain("ld+json");
    expect(await html({ head: false, webmcp: false, jsonLd: false })).toBe("");
  });

  it("robots off: no line, and the robots route serves the rules unchanged", async () => {
    const { agents } = setup({ features: { robots: false } });
    expect(await agents.robotsSignal()).toBeNull();
    const res = await agents.robotsRoute({ rules: { userAgent: "*", allow: "/" } }).GET(req("/robots.txt"));
    expect(await res.text()).toBe("User-Agent: *\nAllow: /\n\n");
  });

  it("reads the switches from the environment", () => {
    const o = optionsFromEnv({ INITE_SITE_KEY: KEY, INITE_SITE_AGENTS_OFF: "ping, jsonld ,webmcp" });
    expect(o.key).toBe(KEY);
    expect(o.features).toEqual({ ping: false, jsonLd: false, webmcp: false });
    expect(o.origin).toBeUndefined();
    expect(o.revalidate).toBeUndefined();
    expect(optionsFromEnv({ INITE_SITE_AGENTS_REVALIDATE: "60" }).revalidate).toBe(60);
    expect(optionsFromEnv({ INITE_SITE_AGENTS_REVALIDATE: "" }).revalidate).toBeUndefined();
  });
});

describe("robots.txt", () => {
  it("puts the Content-Signal line in the User-agent: * group of the site's own rules", async () => {
    const { agents } = setup();
    expect(await agents.robotsSignal()).toBe("Content-Signal: search=yes, ai-input=yes, ai-train=no");
    const res = await agents
      .robotsRoute(() => ({ rules: [{ userAgent: "GPTBot", disallow: "/private" }, { userAgent: "*", allow: "/", disallow: "/admin" }], sitemap: "https://acme.com/sitemap.xml" }))
      .GET(req("/robots.txt"));
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(
      "User-Agent: GPTBot\nDisallow: /private\n\nUser-Agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\nDisallow: /admin\n\nSitemap: https://acme.com/sitemap.xml\n",
    );
  });

  it("adds a group of its own when there is no User-agent: *, and never twice", () => {
    const line = "Content-Signal: search=yes, ai-input=yes, ai-train=no";
    expect(withContentSignal("User-agent: GPTBot\nDisallow: /\n", line)).toBe(`User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\n${line}\n`);
    const once = withContentSignal("User-agent: *\nAllow: /\n", line);
    expect(withContentSignal(once, line)).toBe(once);
    expect(withContentSignal("", line)).toBe(`User-agent: *\n${line}\n`);
  });

  it("renders a MetadataRoute.Robots object as Next does", () => {
    expect(renderRobots({ rules: { userAgent: ["a", "b"], allow: ["/x", "/y"], crawlDelay: 2 }, host: "https://h", sitemap: ["s1", "s2"] })).toBe(
      "User-Agent: a\nUser-Agent: b\nAllow: /x\nAllow: /y\nCrawl-delay: 2\n\nHost: https://h\nSitemap: s1\nSitemap: s2\n",
    );
  });
});

describe("the ping", () => {
  it("counts known AI agents on served paths, with no address or user agent, and pings once a period", async () => {
    const { agents, svc, tick } = setup({ revalidate: 3600 });
    const pings = () => svc.calls.filter((c) => c.url.endsWith("/api/site/v1/ping"));
    await agents.llmsTxt.GET(req("/llms.txt", { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "x-forwarded-for": "203.0.113.9" }));
    // The ping leaves after the response and carries the counts as they are
    // when it is sent: wait for it before the next visits, so it holds one.
    await vi.waitFor(() => expect(pings()).toHaveLength(1));
    await agents.llmsTxt.GET(req("/llms.txt", { "user-agent": "Mozilla/5.0 Chrome/120" }));
    await agents.wellKnown.GET(req("/.well-known/mcp.json", { "user-agent": "GPTBot/1.2" }), wk("mcp.json"));
    await new Promise((r) => setTimeout(r, 10));
    expect(pings()).toHaveLength(1);
    const body = JSON.parse(pings()[0].body!);
    expect(body).toEqual({
      platform: "next",
      pluginVersion: PACKAGE_VERSION,
      paths: ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/mcp.json", "/.well-known/api-catalog"],
      visits: [{ day: "2026-10-22", path: "/llms.txt", agent: "ClaudeBot", hits: 1 }],
    });
    expect(pings()[0].body).not.toContain("203.0.113.9");
    expect(pings()[0].body).not.toContain("Mozilla");

    tick(25 * HOUR);
    await agents.llmsTxt.GET(req("/llms.txt", { "user-agent": "ClaudeBot" }));
    await vi.waitFor(() => expect(pings()).toHaveLength(2));
    const second = JSON.parse(pings()[1].body!);
    expect(second.visits).toEqual([
      { day: "2026-10-22", path: "/llms.txt", agent: "ClaudeBot", hits: 1 },
      { day: "2026-10-22", path: "/.well-known/mcp.json", agent: "GPTBot", hits: 1 },
      { day: "2026-10-23", path: "/llms.txt", agent: "ClaudeBot", hits: 1 },
    ]);
  });

  it("ping off: nothing is counted or sent", async () => {
    const { agents, svc } = setup({ features: { ping: false } });
    await agents.llmsTxt.GET(req("/llms.txt", { "user-agent": "ClaudeBot" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.calls.some((c) => c.url.endsWith("/ping"))).toBe(false);
  });

  it("names agents by the plugin's list, the specific token first", () => {
    expect(agentOf("Mozilla/5.0 AppleWebKit (KHTML, like Gecko); compatible; ChatGPT-User/1.0")).toBe("ChatGPT-User");
    expect(agentOf("Claude-User/1.0 claudebot")).toBe("Claude-User");
    expect(agentOf("Googlebot/2.1")).toBeNull();
    expect(agentOf("")).toBeNull();
    expect(AI_AGENTS).toHaveLength(22);
  });
});

describe("the package", () => {
  it("reports the version package.json carries", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("falls back to memory outside a Next server, and a failure there is not thrown", async () => {
    const { svc } = setup();
    const agents = createSiteAgents({ key: KEY, origin: ORIGIN, cache: "next", fetch: svc.fetch, now: () => 0 });
    const res = await agents.llmsTxt.GET(req("/llms.txt"));
    expect(res.status).toBe(200);
  });
});
