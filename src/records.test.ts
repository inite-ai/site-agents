import { describe, expect, it } from "vitest";
import { createContentSync, RECORDS_PAGE } from "./records";
import { PACKAGE_VERSION } from "./sync";
import { KNOWN_FILES, ROOT_PATHS } from "./manifest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; exports: Record<string, unknown> };

const KEY = "isk_" + "C".repeat(32);
const ORIGIN = "https://inite.example";

type Call = { url: string; body: Record<string, any>; headers: Record<string, string>; redirect?: string };

function service(answer: (c: Call) => Response = (c) => Response.json({ ok: true, held: c.body.items?.length ?? c.body.present?.length ?? 0 })) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), body: JSON.parse(String(init?.body)), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { calls, fetch: f };
}

const page = (i: number, title = `Page ${i}`) => ({ id: i, type: "page" as const, title, url: `https://acme.com/p${i}/` });

describe("the app's own content, sent to INITE", () => {
  it("sends only the groups the app passed, a hundred items a call, then the ids still there", async () => {
    const svc = service();
    let pages = Array.from({ length: 250 }, (_, i) => page(i));
    const sync = createContentSync({ content: () => pages }, { key: KEY, origin: ORIGIN, fetch: svc.fetch });
    const first = await sync.sync();
    expect(first.ok).toBe(true);
    expect(svc.calls.map((c) => c.body.items?.length ?? `present:${c.body.present.length}`)).toEqual([RECORDS_PAGE, RECORDS_PAGE, 50, "present:250"]);
    expect(svc.calls.every((c) => c.url === `${ORIGIN}/api/site/v1/records` && c.body.group === "content" && c.redirect === "manual")).toBe(true);
    expect(svc.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(svc.calls[0].headers["User-Agent"]).toBe(`INITE-Agents-Next/${PACKAGE_VERSION}`);

    // Unchanged: nothing. One renamed and one gone: that item, then the ids.
    svc.calls.length = 0;
    await sync.sync();
    expect(svc.calls).toHaveLength(0);
    pages = pages.filter((p) => p.id !== 3).map((p) => (p.id === 7 ? page(7, "Renamed") : p));
    await sync.sync();
    expect(svc.calls.map((c) => Object.keys(c.body).sort().join())).toEqual(["group,items", "group,present"]);
    expect(svc.calls[0].body.items).toEqual([{ ...page(7, "Renamed"), id: "7" }]);
    expect(svc.calls[1].body.present).not.toContain("3");
  });

  it("a group passed as null is deleted at INITE; a refused key stops the run", async () => {
    const svc = service((c) => (c.body.group === "content" ? Response.json({ ok: true, held: 0 }) : Response.json({ ok: false, error: "unconfirmed" }, { status: 409 })));
    const got = await createContentSync({ content: null, products: () => [{ id: 1, name: "Kit", url: "https://acme.com/kit" }], events: () => [] }, { key: KEY, origin: ORIGIN, fetch: svc.fetch }).sync();
    expect(svc.calls[0].body).toEqual({ group: "content", clear: true });
    expect(got.groups.content).toEqual({ sent: 0, held: 0, cleared: true });
    expect(got.groups.products).toMatchObject({ status: 409, error: "unconfirmed" });
    expect(got.groups.events).toBeUndefined();
    expect(got.ok).toBe(false);
  });

  it("without a key nothing is sent, and maybeSync waits its period", async () => {
    const svc = service();
    expect((await createContentSync({ content: () => [page(1)] }, { key: undefined, fetch: svc.fetch }).sync()).ok).toBe(false);
    let now = 0;
    const sync = createContentSync({ content: () => [page(1)] }, { key: KEY, origin: ORIGIN, fetch: svc.fetch, now: () => now, everyMinutes: 60 });
    expect(await sync.maybeSync()).not.toBeNull();
    now += 30 * 60_000;
    expect(await sync.maybeSync()).toBeNull();
    now += 31 * 60_000;
    expect(await sync.maybeSync()).not.toBeNull();
    expect(svc.calls.length).toBe(2);
  });

  it("knows llms-full.txt, and states one version", () => {
    expect(KNOWN_FILES).toContain("llms-full.txt");
    expect(ROOT_PATHS).toContain("/llms-full.txt");
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect((pkg.exports as Record<string, unknown>)["./llms-full-txt"]).toBeDefined();
  });
});
