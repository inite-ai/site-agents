/**
 * app/llms.txt/route.ts, configured from the environment (INITE_SITE_KEY):
 *
 *   export { GET, HEAD } from "@inite/site-agents/llms-txt";
 */
import { defaultSiteAgents } from "../create";

export const GET = (req: Request) => defaultSiteAgents().llmsTxt.GET(req);
export const HEAD = (req: Request) => defaultSiteAgents().llmsTxt.HEAD(req);
