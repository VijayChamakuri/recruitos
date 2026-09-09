import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_FONT_FILES = [
  "ibm-plex-sans-latin-400-normal.woff2",
  "ibm-plex-sans-latin-600-normal.woff2",
  "ibm-plex-sans-condensed-latin-600-normal.woff2",
  "ibm-plex-mono-latin-400-normal.woff2",
  "source-serif-4-latin-400-normal.woff2",
  "source-serif-4-latin-600-normal.woff2"
] as const;

const FONT_SET = new Set<string>(WEB_FONT_FILES);
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fonts");

export type FontFileResponse = Readonly<{
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

export function fontsDirectory(): string {
  return FONTS_DIR;
}

export function serveWebFont(pathname: string): FontFileResponse | null {
  if (!pathname.startsWith("/fonts/")) {
    return null;
  }
  const name = pathname.slice("/fonts/".length);
  if (name.includes("/") || name.includes("\\") || name.includes("..") || !FONT_SET.has(name)) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: Buffer.from("Font not found")
    };
  }
  try {
    const body = readFileSync(join(FONTS_DIR, name));
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable"
      },
      body
    };
  } catch {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: Buffer.from("Font not found")
    };
  }
}
