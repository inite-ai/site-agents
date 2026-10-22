/**
 * app/.well-known/[file]/route.ts, configured from the environment
 * (INITE_SITE_KEY): agent-card.json, mcp.json and api-catalog; any other
 * name is a 404, and a static route of your own under .well-known wins.
 *
 *   export { GET, HEAD } from "@inite/site-agents/well-known";
 */
import { defaultSiteAgents } from "../create";

type Ctx = { params: Promise<{ file: string }> };

export const GET = (req: Request, ctx: Ctx) => defaultSiteAgents().wellKnown.GET(req, ctx);
export const HEAD = (req: Request, ctx: Ctx) => defaultSiteAgents().wellKnown.HEAD(req, ctx);
