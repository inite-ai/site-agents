/**
 * <SiteAgentsHead />: what goes in the page's head for agents, from the
 * copy held: the WebMCP script, the link tags that say where the MCP
 * server, llms.txt and the cards live, and the JSON-LD of the confirmed
 * facts. Each part has its own switch (webmcp, head, jsonLd); with nothing
 * held, or after a refusal, it renders nothing.
 *
 * Built from the manifest's parts, not printed from its HTML, so React
 * escapes every attribute and nothing the service sends can add markup.
 * React 19 places the async script and the link tags in <head> wherever
 * the component sits; the JSON-LD stays where it is rendered, which search
 * engines read the same.
 */

import type { ReactElement } from "react";
import type { HeadLink } from "./manifest";

export interface HeadParts {
  script: string | null;
  links: HeadLink[];
  jsonLd: Record<string, unknown> | null;
}

/** JSON inside a <script> element: nothing in it may close the element or start markup. */
export function inScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function headElements(parts: HeadParts | null): ReactElement | null {
  if (!parts || (!parts.script && !parts.links.length && !parts.jsonLd)) return null;
  return (
    <>
      {parts.script ? <script src={parts.script} async crossOrigin="anonymous" /> : null}
      {parts.links.map((l) => (
        <link key={`${l.rel} ${l.href}`} rel={l.rel} href={l.href} {...(l.type ? { type: l.type } : {})} />
      ))}
      {parts.jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: inScript(parts.jsonLd) }} /> : null}
    </>
  );
}

/** The server component for one configuration. Never throws into the layout. */
export function makeHead(parts: () => Promise<HeadParts | null>): () => Promise<ReactElement | null> {
  return async function SiteAgentsHead() {
    try {
      return headElements(await parts());
    } catch {
      // quiet: the host page renders without the agent tags rather than failing
      return null;
    }
  };
}
