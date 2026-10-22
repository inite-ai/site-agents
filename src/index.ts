/**
 * @inite/site-agents: a Next.js site serves the facts its company confirmed
 * in INITE to AI agents: /llms.txt, /.well-known/{agent-card.json, mcp.json,
 * api-catalog}, the Content-Signal line for robots.txt, and the head tags
 * (WebMCP script, links, JSON-LD). See README.md.
 */

export { createSiteAgents, defaultSiteAgents, holds, type SiteAgents, type RouteHandler, type WellKnownHandler, type RobotsBase } from "./create";
export { DEFAULT_ORIGIN, FEATURES, optionsFromEnv, safeOrigin, type FeatureName, type SiteAgentsFeatures, type SiteAgentsOptions } from "./config";
export { AI_AGENTS, agentOf } from "./agents";
export { KNOWN_FILES, ROOT_PATHS, parseManifest, type FileName, type RootPath, type HeadLink, type ParsedManifest } from "./manifest";
export { renderRobots, signalLines, withContentSignal, type RobotsObject, type RobotsRule } from "./robots";
export { headElements, inScript, type HeadParts } from "./head";
export { PACKAGE_VERSION, type Copy, type CopyFile, type Snapshot } from "./sync";
export { createContentQueue, parseQueueItem, type ContentQueue, type ContentFailure, type ContentSource, type QueueItem, type QueueResult, type PublishedResult, type FailedResult } from "./content";
