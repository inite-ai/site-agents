/**
 * The manifest (GET /api/site/v1/manifest) reduced to what this package
 * serves, checked the way the WordPress plugin checks it
 * (includes/class-inite-agents-sync.php, `manifest()`): only known files, only
 * the four root paths, a content type that cannot end a header line, and
 * head addresses that are http(s). Anything else in the body is ignored,
 * including the files' own `url`: a file is always asked for at the
 * configured origin.
 */

export const KNOWN_FILES = ["llms.txt", "agent-card.json", "mcp.json", "api-catalog", "robots-signal", "jsonld"] as const;
export type FileName = (typeof KNOWN_FILES)[number];

/** The root paths a file may be served at. Nothing else is ever claimed. */
export const ROOT_PATHS = ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/mcp.json", "/.well-known/api-catalog"] as const;
export type RootPath = (typeof ROOT_PATHS)[number];

export interface HeadLink {
  rel: string;
  href: string;
  type?: string;
}

export interface ManifestFile {
  name: FileName;
  path: RootPath | null;
  type: string;
  etag: string;
}

export interface ParsedManifest {
  site: { slug: string; domain: string; version: number; confirmedAt: string };
  mcp: string | null;
  files: ManifestFile[];
  head: { script: string | null; links: HeadLink[]; jsonLd: Record<string, unknown> | null };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A media type with parameters (a profile, a charset), and nothing that could end the header line.
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+(\s*;\s*[a-z0-9-]+=("[^"\x00-\x1f]*"|[a-z0-9.+-]+))*$/i;
const ETAG = /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const TEXT = "text/plain; charset=utf-8";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");

export const isKnownFile = (v: unknown): v is FileName => typeof v === "string" && (KNOWN_FILES as readonly string[]).includes(v);
export const isRootPath = (v: unknown): v is RootPath => typeof v === "string" && (ROOT_PATHS as readonly string[]).includes(v);

/** A media type a response header may carry, or plain text. */
export function safeType(v: unknown): string {
  const t = str(v, 200).trim();
  return MEDIA_TYPE.test(t) ? t : TEXT;
}

/** An ETag a response header may carry, or "". */
export function safeEtag(v: unknown): string {
  const t = str(v, 210).trim();
  return ETAG.test(t) ? t : "";
}

/** An absolute http(s) address for an attribute, or null. */
export function safeHref(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    // quiet: an address that does not parse is left out of the head
    return null;
  }
}

/** The manifest, or null when it does not read as one. */
export function parseManifest(raw: unknown): ParsedManifest | null {
  if (!isObj(raw) || raw.ok !== true || !isObj(raw.site) || !Array.isArray(raw.files)) return null;
  const slug = str(raw.site.slug, 63);
  const version = raw.site.version;
  if (!SLUG.test(slug) || typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;

  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const f of raw.files) {
    if (!isObj(f) || !isKnownFile(f.name) || seen.has(f.name)) continue;
    seen.add(f.name);
    files.push({ name: f.name, path: isRootPath(f.path) ? f.path : null, type: safeType(f.contentType), etag: safeEtag(f.etag) });
  }

  const head = isObj(raw.head) ? raw.head : {};
  const links: HeadLink[] = [];
  for (const l of Array.isArray(head.links) ? head.links : []) {
    if (!isObj(l)) continue;
    const rel = str(l.rel, 40);
    const href = safeHref(l.href);
    if (!/^[a-z-]+$/.test(rel) || !href) continue;
    const type = str(l.type, 100);
    links.push({ rel, href, ...(type && MEDIA_TYPE.test(type) ? { type } : {}) });
  }
  const script = isObj(head.script) ? safeHref(head.script.src) : null;

  return {
    site: { slug, domain: str(raw.site.domain, 253), version, confirmedAt: str(raw.site.confirmedAt, 40) },
    mcp: isObj(raw.mcp) ? safeHref(raw.mcp.url) : null,
    files,
    head: { script, links, jsonLd: isObj(head.jsonLd) ? head.jsonLd : null },
  };
}
