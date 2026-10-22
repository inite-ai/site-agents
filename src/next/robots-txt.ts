/**
 * app/robots.txt/route.ts, configured from the environment (INITE_SITE_KEY),
 * for a site with no rules of its own: `User-agent: *`, `Allow: /` and the
 * Content-Signal line.
 *
 *   export { GET } from "@inite/site-agents/robots-txt";
 *
 * With rules of your own, build the route from them instead:
 *   export const { GET } = defaultSiteAgents().robotsRoute(rules)
 */
import { defaultSiteAgents } from "../create";

export const GET = (req: Request) => defaultSiteAgents().robotsRoute().GET(req);
