// ─── Google session injection ──────────────────────────────────
// Google Meet refuses anonymous bots ("You can't join this video
// call"). To get in, the bot's Chromium must be signed in to a real
// Google account.
//
// Automating Google's login FORM is a dead end — Google detects the
// automation and blocks it. Instead we inject a session captured
// once from a normal browser:
//
//   1. In Chrome, signed in to the bot's Google account, install the
//      "Cookie-Editor" extension.
//   2. On https://meet.google.com, open Cookie-Editor → Export → it
//      copies all cookies as JSON.
//   3. Base64-encode that JSON and set it as the GOOGLE_COOKIES_B64
//      secret (see README / .env.example).
//
// Google rotates anti-replay cookies (__Secure-3PSIDTS, *SIDCC) on
// the server side; a frozen export goes stale within minutes. So
// after every successful join we PERSIST the rotated cookies to a
// Fly volume at /data/google-session.json and prefer that file over
// the env var on subsequent runs. The env var is only the bootstrap
// seed used until the first successful admission.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

const SESSION_FILE = process.env.SESSION_FILE || '/data/google-session.json';

// Cookie-Editor / Chrome export shape (only the fields we use).
interface ExportedCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

// The cookie shape Playwright's context.addCookies expects.
interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

function mapSameSite(raw: string | undefined): 'Strict' | 'Lax' | 'None' | undefined {
  switch ((raw || '').toLowerCase()) {
    case 'strict': return 'Strict';
    case 'lax': return 'Lax';
    case 'no_restriction':
    case 'none': return 'None';
    default: return undefined; // 'unspecified' etc. — let Playwright decide
  }
}

function fromExported(item: ExportedCookie): PlaywrightCookie | null {
  if (!item || !item.name || typeof item.value !== 'string' || !item.domain) return null;
  const cookie: PlaywrightCookie = {
    name: item.name,
    value: item.value,
    domain: item.domain,
    path: item.path || '/',
    httpOnly: !!item.httpOnly,
    secure: !!item.secure,
  };
  if (typeof item.expirationDate === 'number') {
    cookie.expires = Math.round(item.expirationDate);
  }
  const sameSite = mapSameSite(item.sameSite);
  if (sameSite === 'None') {
    // SameSite=None cookies must also be Secure.
    cookie.sameSite = 'None';
    cookie.secure = true;
  } else if (sameSite) {
    cookie.sameSite = sameSite;
  }
  return cookie;
}

/** Decode GOOGLE_COOKIES_B64 into Playwright cookies. Returns [] when
 *  no session is configured or the value can't be parsed. */
function bootstrapCookies(): PlaywrightCookie[] {
  const b64 = process.env.GOOGLE_COOKIES_B64;
  if (!b64) return [];

  let raw: string;
  try {
    raw = Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    console.error('[google-session] GOOGLE_COOKIES_B64 is not valid base64');
    return [];
  }

  let exported: unknown;
  try {
    exported = JSON.parse(raw);
  } catch {
    console.error('[google-session] GOOGLE_COOKIES_B64 did not decode to JSON');
    return [];
  }

  // Accept a bare array or a { cookies: [...] } wrapper.
  const list: unknown = Array.isArray(exported)
    ? exported
    : (exported as { cookies?: unknown }).cookies;
  if (!Array.isArray(list)) {
    console.error('[google-session] GOOGLE_COOKIES_B64 has no cookie array');
    return [];
  }

  const cookies: PlaywrightCookie[] = [];
  for (const item of list as ExportedCookie[]) {
    const c = fromExported(item);
    if (c) cookies.push(c);
  }
  return cookies;
}

/** Try the persisted (rotation-fresh) session first; fall back to
 *  the static bootstrap export on first run. */
export async function loadGoogleCookies(): Promise<PlaywrightCookie[]> {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { cookies?: PlaywrightCookie[] };
    if (Array.isArray(parsed?.cookies) && parsed.cookies.length > 0) {
      console.log(`[google-session] loaded ${parsed.cookies.length} cookies from ${SESSION_FILE}`);
      return parsed.cookies;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[google-session] could not read ${SESSION_FILE}: ${(err as Error).message}`);
    }
  }
  const seed = bootstrapCookies();
  if (seed.length > 0) {
    console.log(`[google-session] bootstrapping with ${seed.length} cookies from GOOGLE_COOKIES_B64`);
  }
  return seed;
}

/** Inject the saved Google session into a fresh browser context.
 *  Returns true if a session was applied, false if none is configured. */
export async function applyGoogleSession(context: BrowserContext): Promise<boolean> {
  const cookies = await loadGoogleCookies();
  if (cookies.length === 0) return false;
  await context.addCookies(cookies);
  return true;
}

/** Capture the context's current Google cookies — including any
 *  server-rotated anti-replay values — and write them atomically to
 *  SESSION_FILE so the NEXT bot run starts from fresh cookies. */
export async function saveGoogleSession(context: BrowserContext): Promise<void> {
  let cookies: PlaywrightCookie[];
  try {
    const all = await context.cookies();
    cookies = all
      .filter((c) => c.domain.endsWith('google.com'))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires === -1 ? undefined : c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
      }));
  } catch (err) {
    console.warn(`[google-session] context.cookies() failed: ${(err as Error).message}`);
    return;
  }
  if (cookies.length === 0) return;

  const dir = path.dirname(SESSION_FILE);
  const tmp = `${SESSION_FILE}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify({ cookies }, null, 2), 'utf-8');
    await fs.rename(tmp, SESSION_FILE);
    console.log(`[google-session] persisted ${cookies.length} cookies to ${SESSION_FILE}`);
  } catch (err) {
    console.warn(`[google-session] could not persist cookies: ${(err as Error).message}`);
  }
}
