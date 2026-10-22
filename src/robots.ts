/**
 * robots.txt and the Content-Signal line (contentsignals.org) INITE
 * publishes for the site: `Content-Signal: search=yes, ai-input=yes, ai-train=no`.
 *
 * Next's `app/robots.ts` returns a MetadataRoute.Robots object, which has
 * no field for Content-Signal. So a site that wants the line serves
 * robots.txt from a route handler instead (`app/robots.txt/route.ts`), built
 * from the same object it had, and this file renders that object as Next
 * would and puts the line in the `User-agent: *` group, the way the
 * WordPress plugin does (includes/class-inite-agents-robots.php).
 */

/** The shape of Next's MetadataRoute.Robots, restated so this file does not import Next's types. */
export interface RobotsRule {
  userAgent?: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
  crawlDelay?: number;
}
export interface RobotsObject {
  rules: RobotsRule | RobotsRule[];
  sitemap?: string | string[];
  host?: string;
}

const LINE = /^Content-Signal:\s*[a-z0-9=,\s-]+$/i;

/** Only the Content-Signal lines of a body; anything else the service might send is not put in robots.txt. */
export function signalLines(body: string | null | undefined): string {
  return (body ?? "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => LINE.test(l))
    .join("\n");
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** A MetadataRoute.Robots object as the text Next serves for it. */
export function renderRobots(robots: RobotsObject): string {
  let out = "";
  for (const rule of Array.isArray(robots.rules) ? robots.rules : [robots.rules]) {
    const agents = list(rule.userAgent);
    for (const ua of agents.length ? agents : ["*"]) out += `User-Agent: ${ua}\n`;
    for (const a of list(rule.allow)) out += `Allow: ${a}\n`;
    for (const d of list(rule.disallow)) out += `Disallow: ${d}\n`;
    if (rule.crawlDelay) out += `Crawl-delay: ${rule.crawlDelay}\n`;
    out += "\n";
  }
  if (robots.host) out += `Host: ${robots.host}\n`;
  for (const s of list(robots.sitemap)) out += `Sitemap: ${s}\n`;
  return out;
}

/**
 * The robots.txt with the line placed in its `User-agent: *` group, or in a
 * group of its own at the end when there is none. Unchanged when the line
 * is empty or already there.
 */
export function withContentSignal(robotsTxt: string, line: string): string {
  if (!line || robotsTxt.toLowerCase().includes(line.toLowerCase())) return robotsTxt;
  let placed = false;
  const out = robotsTxt.replace(/^(User-agent:\s*\*[ \t]*)$/im, (m) => {
    placed = true;
    return `${m}\n${line}`;
  });
  if (placed) return out;
  return `${robotsTxt.replace(/\s+$/, "")}${robotsTxt.trim() ? "\n\n" : ""}User-agent: *\n${line}\n`;
}
