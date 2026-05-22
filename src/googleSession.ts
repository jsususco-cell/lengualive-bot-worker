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
// The base64 wrapper keeps the (large, quote-heavy) JSON safe to pass
// as a single environment variable / Fly secret.

import type { BrowserContext } from 'playwright';

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

/** Decode GOOGLE_COOKIES_B64 into Playwright cookies. Returns [] when
 *  no session is configured or the value can't be parsed. */
export function loadGoogleCookies(): PlaywrightCookie[] {
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
    if (!item || !item.name || typeof item.value !== 'string' || !item.domain) continue;
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
    cookies.push(cookie);
  }
  return cookies;
}

/** Inject the saved Google session into a fresh browser context.
 *  Returns true if a session was applied, false if none is configured. */
export async function applyGoogleSession(context: BrowserContext): Promise<boolean> {
  const cookies = loadGoogleCookies();
  if (cookies.length === 0) return false;
  await context.addCookies(cookies);
  return true;
}
