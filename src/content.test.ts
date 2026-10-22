import { describe, expect, it } from "vitest";
import { createContentQueue } from "./content";
import { PACKAGE_VERSION } from "./sync";

const KEY = "isk_" + "B".repeat(32);
const ORIGIN = "https://inite.example";

/** An item as the service sends it (lib/site-content/publish.ts QueueItem); its report URLs point elsewhere on purpose. */
const ITEM = {
  id: "art_1",
  lang: "en",
  title: "How long a cleaning takes",
  slug: "how-long-a-cleaning-takes",
  metaDescription: "Forty minutes, and what happens in them.",
  body: "# How long\n\nForty minutes.\n",
  html: "<h1>How long</h1>\n<p>Forty minutes.</p>\n",
  sources: [{ url: "https://acme.com/services", title: "Services" }, { url: "https://acme.com/faq", title: null }, { nope: 1 }],
  approvedAt: "2026-10-22T10:00:00.000Z",
  report: { published: "https://evil.example/steal/published", failed: "https://evil.example/steal/failed" },
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string };

function fake(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined, redirect: init?.redirect };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { calls, fetch: f };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("the content queue", () => {
  it("reads the queue and drops what does not read", async () => {
    const svc = fake(() => json(200, { ok: true, enabled: true, items: [ITEM, { id: "x" }, null] }));
    const got = await createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch }).queue();
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.enabled).toBe(true);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ id: "art_1", slug: ITEM.slug, body: ITEM.body, html: ITEM.html, approvedAt: ITEM.approvedAt });
    expect(got.items[0].sources).toEqual([
      { url: "https://acme.com/services", title: "Services" },
      { url: "https://acme.com/faq", title: null },
    ]);
    const c = svc.calls[0];
    expect(c.url).toBe(`${ORIGIN}/api/site/v1/content/queue`);
    expect(c.method).toBe("GET");
    expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(c.headers["User-Agent"]).toBe(`INITE-Agents-Next/${PACKAGE_VERSION}`);
    expect(c.redirect).toBe("manual");
  });

  it("says when articles are switched off", async () => {
    const svc = fake(() => json(200, { ok: true, enabled: false, items: [] }));
    expect(await createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch }).queue()).toEqual({ ok: true, enabled: false, items: [] });
  });

  it("reports to the configured origin only, never to the URL an item names", async () => {
    const svc = fake((c) => (c.url.endsWith("/published") ? json(200, { ok: true, status: "published", url: "https://acme.com/blog/how-long", already: false }) : json(200, { ok: true, status: "failed", already: false })));
    const q = createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch });
    expect(await q.published("art/1", "https://acme.com/blog/how-long")).toEqual({ ok: true, status: "published", url: "https://acme.com/blog/how-long", already: false });
    expect(await q.failed("art_1", "the theme refused the HTML")).toEqual({ ok: true, status: "failed", already: false });
    expect(svc.calls.map((c) => c.url)).toEqual([`${ORIGIN}/api/site/v1/content/art%2F1/published`, `${ORIGIN}/api/site/v1/content/art_1/failed`]);
    expect(svc.calls.every((c) => c.method === "POST" && c.headers.Authorization === `Bearer ${KEY}` && c.headers["Content-Type"] === "application/json")).toBe(true);
    expect(JSON.parse(svc.calls[0].body!)).toEqual({ url: "https://acme.com/blog/how-long" });
    expect(JSON.parse(svc.calls[1].body!)).toEqual({ reason: "the theme refused the HTML" });
    expect(svc.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("passes on a repeat report as already done", async () => {
    const svc = fake(() => json(200, { ok: true, status: "published", url: "https://acme.com/a", already: true }));
    const got = await createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch }).published("art_1", "https://acme.com/a");
    expect(got).toMatchObject({ ok: true, already: true });
  });

  it("returns the service's refusal as it said it", async () => {
    const cases: [number, string][] = [
      [401, "revoked"],
      [403, "disabled"],
      [409, "unconfirmed"],
      [409, "published_elsewhere"],
      [422, "invalid_url"],
      [404, "not_found"],
    ];
    for (const [status, error] of cases) {
      const svc = fake(() => json(status, { ok: false, error, message: `said ${error}` }));
      const got = await createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch }).published("art_1", "https://acme.com/a");
      expect(got).toEqual({ ok: false, status, error, message: `said ${error}` });
    }
  });

  it("carries Retry-After when the door is busy", async () => {
    const svc = fake(() => json(429, { ok: false, error: "Too many requests. Try again shortly.", busy: "rate" }, { "Retry-After": "12" }));
    const got = await createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch }).queue();
    expect(got).toMatchObject({ ok: false, status: 429, retryAfter: 12 });
  });

  it("never throws on a network failure or a body that does not read", async () => {
    const down = fake(() => {
      throw new TypeError("fetch failed");
    });
    expect(await createContentQueue({ key: KEY, origin: ORIGIN, fetch: down.fetch }).queue()).toMatchObject({ ok: false, status: 0, error: "unreachable" });
    const garbage = fake(() => new Response("<html>oops</html>", { status: 502 }));
    expect(await createContentQueue({ key: KEY, origin: ORIGIN, fetch: garbage.fetch }).failed("art_1", "x")).toMatchObject({ ok: false, status: 502, error: "refused" });
    const odd = fake(() => json(200, { hello: true }));
    expect(await createContentQueue({ key: KEY, origin: ORIGIN, fetch: odd.fetch }).queue()).toMatchObject({ ok: false, status: 200, error: "bad_answer" });
  });

  it("does not follow a redirect", async () => {
    const svc = fake(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
    const got = await createContentQueue({ key: KEY, origin: ORIGIN, fetch: svc.fetch }).queue();
    expect(got).toMatchObject({ ok: false, status: 302, error: "redirect" });
    expect(svc.calls).toHaveLength(1);
  });

  it("calls nothing without a key, or with a key sent in clear text", async () => {
    const svc = fake(() => json(200, { ok: true, enabled: true, items: [] }));
    expect(await createContentQueue({ key: undefined, origin: ORIGIN, fetch: svc.fetch }).queue()).toMatchObject({ ok: false, status: 0, error: "no_key", message: "INITE_SITE_KEY is not set" });
    expect(await createContentQueue({ key: KEY, origin: "http://inite.example", fetch: svc.fetch }).published("a", "https://acme.com/a")).toMatchObject({ ok: false, error: "no_key" });
    expect(svc.calls).toHaveLength(0);
  });
});
