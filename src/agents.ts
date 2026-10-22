/**
 * The AI agents a connector counts on the paths it serves.
 *
 * THIS LIST MUST MATCH the WordPress plugin's, `Inite_Agents_Visitors::AGENTS`
 * in includes/class-inite-agents-visitors.php
 * (https://github.com/inite-ai/inite-agents-wordpress): the cabinet adds up what both report,
 * and an agent one connector names and the other does not would read as a
 * difference between platforms. Change both, in the same order.
 *
 * Each entry is the name reported and the token looked for in the user
 * agent, lowercase. The first match wins, so the more specific token comes
 * first (ChatGPT-User before GPTBot, Claude-User before ClaudeBot).
 */
export const AI_AGENTS: readonly (readonly [name: string, token: string])[] = [
  ["ChatGPT-User", "chatgpt-user"],
  ["OAI-SearchBot", "oai-searchbot"],
  ["GPTBot", "gptbot"],
  ["Claude-User", "claude-user"],
  ["Claude-SearchBot", "claude-searchbot"],
  ["ClaudeBot", "claudebot"],
  ["anthropic-ai", "anthropic-ai"],
  ["Perplexity-User", "perplexity-user"],
  ["PerplexityBot", "perplexitybot"],
  ["Google-Extended", "google-extended"],
  ["Google-CloudVertexBot", "google-cloudvertexbot"],
  ["Gemini-Deep-Research", "gemini-deep-research"],
  ["Applebot-Extended", "applebot-extended"],
  ["Meta-ExternalAgent", "meta-externalagent"],
  ["Meta-ExternalFetcher", "meta-externalfetcher"],
  ["MistralAI-User", "mistralai-user"],
  ["DuckAssistBot", "duckassistbot"],
  ["YouBot", "youbot"],
  ["cohere-ai", "cohere-ai"],
  ["Amazonbot", "amazonbot"],
  ["Bytespider", "bytespider"],
  ["CCBot", "ccbot"],
];

/** The agent a User-Agent header names, or null for anyone else (people, search engines, monitors). */
export function agentOf(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return null;
  for (const [name, token] of AI_AGENTS) if (ua.includes(token)) return name;
  return null;
}
