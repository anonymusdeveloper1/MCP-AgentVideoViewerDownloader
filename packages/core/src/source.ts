import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { AvvError } from "./errors.js";
import { resolveAllowed, exists } from "./paths.js";
import type { AvvConfig } from "./config.js";

export type Source =
  | { kind: "url"; url: string; hostname: string }
  | { kind: "file"; path: string };

/**
 * Decide whether the caller handed us a remote URL or a local file, and
 * validate it either way.
 *
 * Agents routinely pass either one interchangeably, so every entry point takes
 * a single `source` argument and runs it through here rather than making the
 * caller pick a flag.
 */
export async function resolveSource(input: string, cfg: AvvConfig): Promise<Source> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AvvError("BAD_ARGUMENT", "Empty source.", "Pass a video URL or a path to a local video file.");
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return await validateUrl(trimmed);
  }

  // Anything else is treated as a filesystem path.
  const abs = await resolveAllowed(trimmed, cfg);
  if (!(await exists(abs))) {
    throw new AvvError(
      "SOURCE_NOT_FOUND",
      `No such file: ${abs}`,
      "Check the path. If you meant a web video, pass the full URL including https://.",
      { path: abs },
    );
  }
  return { kind: "file", path: abs };
}

/** Hostnames that must never be fetched, regardless of DNS. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud instance metadata endpoints.
  "metadata.google.internal",
  "metadata.goog",
]);

async function validateUrl(raw: string): Promise<Source> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AvvError("BAD_ARGUMENT", `Not a valid URL: ${raw}`, "Pass a complete URL, e.g. https://www.youtube.com/watch?v=...");
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AvvError(
      "UNSUPPORTED_SOURCE",
      `Unsupported URL scheme "${u.protocol}".`,
      "Only http:// and https:// URLs are accepted. For a local file, pass its filesystem path instead.",
      { protocol: u.protocol },
    );
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new AvvError(
      "PATH_NOT_ALLOWED",
      `Refusing to fetch ${host} - loopback and metadata hosts are blocked.`,
      "Point at a public video URL.",
      { hostname: host },
    );
  }

  // Resolve the name and reject any address in a private/reserved range. This
  // is the SSRF guard: without it, an agent acting on a poisoned instruction
  // could use this server to probe the user's LAN or a cloud metadata service.
  const addrs = net.isIP(host) ? [host] : await lookupAll(host);
  for (const addr of addrs) {
    if (isPrivateAddress(addr)) {
      throw new AvvError(
        "PATH_NOT_ALLOWED",
        `Refusing to fetch ${host} - it resolves to the private/reserved address ${addr}.`,
        "This server only downloads from public internet hosts.",
        { hostname: host, address: addr },
      );
    }
  }

  return { kind: "url", url: u.toString(), hostname: host };
}

async function lookupAll(host: string): Promise<string[]> {
  try {
    const res = await dns.lookup(host, { all: true });
    return res.map((r) => r.address);
  } catch {
    throw new AvvError(
      "NETWORK",
      `Could not resolve host "${host}".`,
      "Check the URL spelling and your network connection.",
      { hostname: host },
    );
  }
}

/** Loopback, link-local, RFC1918, CGNAT, unique-local v6, and friends. */
export function isPrivateAddress(addr: string): boolean {
  const v = net.isIP(addr);
  if (v === 4) {
    const parts = addr.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fe80")) return true; // link-local
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local
    // IPv4-mapped, e.g. ::ffff:127.0.0.1
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** A short, human-readable label for a source, used in progress and filenames. */
export function sourceLabel(src: Source): string {
  return src.kind === "url" ? src.url : path.basename(src.path);
}
