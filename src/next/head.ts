/**
 * The head tags for the root layout, configured from the environment
 * (INITE_SITE_KEY):
 *
 *   import { SiteAgentsHead } from "@inite/site-agents/head";
 *   ...
 *   <head><SiteAgentsHead /></head>
 */
import { defaultSiteAgents } from "../create";

export function SiteAgentsHead() {
  return defaultSiteAgents().Head();
}
