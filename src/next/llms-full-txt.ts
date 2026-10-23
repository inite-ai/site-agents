/**
 * app/llms-full.txt/route.ts, configured from the environment (INITE_SITE_KEY):
 *
 *   export { GET, HEAD } from "@inite/site-agents/llms-full-txt";
 */
import { defaultSiteAgents } from "../create";

export const GET = (req: Request) => defaultSiteAgents().llmsFullTxt.GET(req);
export const HEAD = (req: Request) => defaultSiteAgents().llmsFullTxt.HEAD(req);
