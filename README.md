# `@inite/site-agents`

A Next.js site serves the facts its company confirmed in INITE to AI agents, from its own domain:

- `/llms.txt`, `/llms-full.txt` and `/.well-known/agent-card.json`, `/.well-known/mcp.json`, `/.well-known/api-catalog`, byte for byte what INITE publishes for the confirmed version, with the same content types;
- the `Content-Signal` line for `robots.txt`;
- in the page's head: the WebMCP script (read-only tools for an agent in the browser), `<link>` tags to the company's MCP server, llms.txt and cards, and the JSON-LD of the facts.

It is the Next.js connector of the INITE connector API (`/api/site/v1/*`) and follows the same rules as the [WordPress plugin](https://github.com/inite-ai/inite-agents-wordpress). No runtime dependencies beyond Next and React.

INITE Agents promises one narrow thing: an AI agent that comes to your site gets the facts your business confirmed, and nothing you did not confirm. Docs for every platform, webhook examples and issues: [inite-ai/inite-agents](https://github.com/inite-ai/inite-agents). The API reference: https://inite.ai/en/mcp#site-api.

## Install in three steps

```bash
npm install @inite/site-agents
```

**1. The key.** Make a site key in the INITE cabinet, tab "For agents", platform Next.js, and set it:

```bash
INITE_SITE_KEY=isk_...
```

**2. Two route files.**

```ts
// app/llms.txt/route.ts
export { GET, HEAD } from "@inite/site-agents/llms-txt";
```

```ts
// app/.well-known/[file]/route.ts
export { GET, HEAD } from "@inite/site-agents/well-known";
```

**3. One component** in the root layout:

```tsx
// app/layout.tsx
import { SiteAgentsHead } from "@inite/site-agents/head";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <SiteAgentsHead />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

That is all. Until the facts are confirmed (or with no key) the routes answer 404 and the component renders nothing.

## robots.txt

Next's `app/robots.ts` returns a `MetadataRoute.Robots` object, and that type has no field for `Content-Signal`. So:

- **No robots.txt yet:** add `app/robots.txt/route.ts` with `export { GET } from "@inite/site-agents/robots-txt";` (`User-agent: *`, `Allow: /` and the line).
- **You have `app/robots.ts`:** rename it to a route handler and pass it the same object. The package renders it as Next would and puts the line in the `User-agent: *` group:

  ```ts
  // app/robots.txt/route.ts (instead of app/robots.ts)
  import { defaultSiteAgents } from "@inite/site-agents";
  import robots from "./rules"; // the object your robots.ts returned

  export const { GET } = defaultSiteAgents().robotsRoute(robots);
  ```

- **A static `public/robots.txt` or your own text:** `await defaultSiteAgents().robotsSignal()` gives the line (or null); `withContentSignal(text, line)` places it.

## Configuration

The one-line files read the environment:

| Variable | Default | What |
|---|---|---|
| `INITE_SITE_KEY` | (none) | The site key. Without it nothing is served and INITE is never called. |
| `INITE_ORIGIN` | `https://inite.ai` | The service. Must be https; plain http only for localhost. |
| `INITE_SITE_AGENTS_OFF` | (none) | Features to switch off, comma-separated: `files,robots,head,webmcp,jsonLd,ping`. |
| `INITE_SITE_AGENTS_REVALIDATE` | `3600` | Seconds a copy is used before INITE is asked again. |

Or configure an instance in code:

```ts
// lib/inite.ts
import { createSiteAgents } from "@inite/site-agents";

export const inite = createSiteAgents({
  key: process.env.INITE_SITE_KEY,
  origin: "https://inite.ai",
  features: { jsonLd: false }, // e.g. your SEO setup already prints an Organization
  revalidate: 3600,
});

// app/llms.txt/route.ts
export const { GET, HEAD } = inite.llmsTxt;
// app/.well-known/[file]/route.ts
export const { GET, HEAD } = inite.wellKnown;
// app/layout.tsx: <inite.Head />
```

## What each feature does

| Feature | Serves | Off |
|---|---|---|
| `files` | `/llms.txt`, `/.well-known/agent-card.json`, `/.well-known/mcp.json`, `/.well-known/api-catalog` | the routes answer 404 |
| `robots` | the `Content-Signal` line in robots.txt | robots.txt is your rules unchanged |
| `head` | `<link rel="mcp">`, `service-doc`, `describedby`, `api-catalog` | no link tags |
| `webmcp` | `<script src=".../api/site/v1/webmcp.js" async>`: read-only tools (business facts, services, hours, locations, FAQ) for an agent in the browser; does nothing in a browser without WebMCP and sets no cookie | no script |
| `jsonLd` | `<script type="application/ld+json">` with Organization and FAQPage | no JSON-LD |
| `ping` | about once a day per server process: the package version, the paths served, and how many times known AI agents (`AI_AGENTS`) read them per day | nothing counted, nothing sent |

A switched-off feature claims nothing: its route answers 404 as if it were not there, and it asks INITE for nothing. To give a path back entirely, delete its route file.

## How the copy is kept

- Every request to INITE goes to the configured origin only, with the key; a URL named in a response is never called with it, and redirects are not followed. Five-second timeout, 1 MB at most.
- **200**: a new copy, taken only when the manifest and every file arrived. **304**: nothing changed (the ETags are sent back). **401, 403, 409** (unknown or revoked key, switched off in the cabinet, nothing confirmed): the copy is dropped and nothing is served. **Anything else** (timeout, 5xx, a body that does not read): the last good copy stays, one warning is logged per outage, and INITE is asked again on the next period (after a minute when nothing is held yet).
- Inside Next the decision lives in Next's data cache (`unstable_cache`, tag `inite-site-agents`) for `revalidate` seconds, so every instance of a deployment shares it (Vercel and self-hosted alike), and a page that renders `<SiteAgentsHead />` is regenerated on the same period (ISR). `revalidateTag("inite-site-agents")` refreshes it now. Outside Next it is kept in memory.
- Runs on the Node runtime; it uses only `fetch` and Web Crypto, so the routes also run on the Edge runtime (`export const runtime = "edge"` beside the re-export).
- Nothing it does throws into your app: a failure renders nothing, or a 404 or 503 on the agent paths.

## The ping and the agent list

`AI_AGENTS` (src/agents.ts) is the one list of agents counted. It **must match** the WordPress plugin's `Inite_Agents_Visitors::AGENTS`, in the same order, so the cabinet adds up the same names from both. No address, user agent string, page or cookie is kept or sent. Counts are per server process: on a serverless deployment with many instances the cabinet shows a lower bound.

## Articles: the content queue

When the owner switches articles on in the cabinet, INITE writes articles for the site on measured demand, and the owner approves each one. An approved article waits in the site's queue until the site reports what became of it. `createContentQueue` reads that queue and reports back, with the same site key:

```ts
// app/api/inite-articles/route.ts: called by your scheduler (Vercel Cron, a GitHub workflow, crontab)
import { createContentQueue } from "@inite/site-agents";
import { createPost } from "@/lib/cms"; // your CMS: writes a post, returns its public URL

export async function GET() {
  const inite = createContentQueue(); // INITE_SITE_KEY and INITE_ORIGIN from the environment
  const q = await inite.queue();
  if (!q.ok) return Response.json({ error: q.error, message: q.message }, { status: 502 });
  for (const a of q.items) {
    try {
      // a.title, a.slug, a.metaDescription, a.body (Markdown), a.html, a.lang, a.sources
      const url = await createPost({ title: a.title, slug: a.slug, html: a.html, description: a.metaDescription, lang: a.lang });
      await inite.published(a.id, url);
    } catch (err) {
      await inite.failed(a.id, err instanceof Error ? err.message : "could not publish");
    }
  }
  return Response.json({ enabled: q.enabled, handled: q.items.length });
}
```

- `queue()` answers `{ ok: true, enabled, items }`. While the owner has articles switched off, `enabled` is `false` and `items` is empty. At most ten items come in one answer, oldest approval first; the rest come on the next call.
- `published(id, url)`: the URL must be http(s) on the site's own domain or a subdomain of it, or the service answers 422 `invalid_url`. Reporting the same URL again answers `already: true`, so a retry after a lost answer is safe; a different URL for an article already published is 409 `published_elsewhere`.
- `failed(id, reason)`: the article leaves the queue until the owner sends it again from the cabinet. The reason (300 characters at most) is shown to the owner.
- Nothing throws. A refusal or a failure is `{ ok: false, status, error, message }`: `status` 0 means no answer (no key, network, timeout); 401, 403 and 409 are the connector refusals the manifest has; 429 and 503 carry `retryAfter` in seconds.
- As everywhere in this package, only the configured origin is called with the key: the `report` URLs an item carries are for reading, and `published()`/`failed()` build their own. Redirects are not followed.

Instead of polling, a site can take the same article by webhook: the event `content.approved` posts it, signed, the moment the owner approves (see https://inite.ai/en/mcp#site-api). It still reports the outcome with `published()` or `failed()`.

## Your pages, products and events

INITE can list your site's own pages, articles and upcoming events in `llms.txt` and `llms-full.txt`, and serve your products to agents through your MCP server (tools `products` and `product`) once the company's owner turns on "Publish my catalogue" in the cabinet. Nothing is sent unless you pass it: pass only the groups you mean to send, and only what anyone can already read on your site.

```ts
// app/llms-full.txt/route.ts
export { GET, HEAD } from "@inite/site-agents/llms-full-txt";
```

```ts
// lib/site-agents.ts
import { createSiteAgents, optionsFromEnv } from "@inite/site-agents";
import { getPages, getProducts } from "./cms";

export const agents = createSiteAgents({
  ...optionsFromEnv(),
  content: {
    content: async () => (await getPages()).map((p) => ({ id: p.id, type: "page", title: p.title, url: p.url, excerpt: p.summary, modified: p.updatedAt })),
    products: async () => (await getProducts()).map((p) => ({ id: p.id, name: p.name, url: p.url, price: p.price, currency: "EUR", stock: p.inStock ? "instock" : "outofstock", sku: p.sku })),
  },
});
```

With `content` set, the package sends at most once an hour (`contentEveryMinutes`), after a response: only the items that changed since the process last sent them, a hundred at a time, then the ids still there, so INITE drops what you removed. A group passed as `null` (`products: null`) makes INITE delete everything it holds of it. To send from a cron route or a CMS webhook instead, call it yourself:

```ts
import { createContentSync } from "@inite/site-agents";
const result = await createContentSync({ events: () => upcomingEvents() }).sync();
```

INITE holds up to 2,000 pages and posts, 2,000 products and 200 events per site. The fields, the caps and the answers: https://inite.ai/en/mcp#site-api (POST /api/site/v1/records).

## Source, releases, issues

- The code is developed in INITE's private monorepo and mirrored, read-only, to [github.com/inite-ai/site-agents](https://github.com/inite-ai/site-agents) on every change. Pull requests there are read and ported by hand, then arrive with the next mirror.
- Published to npm as [`@inite/site-agents`](https://www.npmjs.com/package/@inite/site-agents) from that public repository, with npm provenance, whenever its `main` carries a version npm does not have yet; each version gets a GitHub Release.
- Issues and questions: [inite-ai/inite-agents](https://github.com/inite-ai/inite-agents/issues). Security reports: security@inite.ai.
- MIT licensed (LICENSE).
