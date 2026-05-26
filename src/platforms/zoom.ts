// ─── Zoom bot ───────────────────────────────────────────────────
// Drives Chromium into a Zoom meeting via the Zoom Web Client (no
// native SDK, no extra entitlements). Flow modelled on Vexa's
// zoom/web/join.ts, trimmed to just what we need to join.
//
// Inputs we accept:
//   - https://us05web.zoom.us/j/<id>?pwd=...            (canonical)
//   - https://app.zoom.us/wc/<id>/join?pwd=...          (web client)
//   - https://events.zoom.us/ejl/...                    (Zoom Events)
//   - https://corp.example.com/m/<id>?pwd=...           (white-label)
//
// Canonical zoom.us URLs are rewritten to /wc/<id>/join for a faster
// join. Other shapes are navigated as-is — the bot picks up at Zoom's
// pre-join page once any portal/T&C page is dismissed.
//
// Failure modes we report distinctly (so the dashboard surfaces a
// useful error instead of a flat "join failed"):
//   - host_not_started: title="Error - Zoom", "This meeting link is invalid"
//   - auth_required:    "Sign in to join this meeting" body text
//   - passcode_required: passcode field is visible but botConfig has none
//
// Recorder-only — mic is muted in the preview. No camera, no TTS.

import { chromium, type Browser, type Page } from 'playwright';
import type { MeetingBot, BotOptions } from './types.js';
import { screenshotPath } from '../paths.js';
import {
  nameInputSelector,
  passcodeInputSelector,
  joinButtonSelector,
  previewMuteSelector,
  previewVideoSelector,
  permissionAllowSelector,
  permissionDismissSelector,
  leaveButtonSelector,
  invalidMeetingTitle,
  invalidMeetingText,
  signInRequiredTexts,
  waitingRoomTexts,
  endedTexts,
} from './zoomSelectors.js';

const ADMIT_TIMEOUT_MS = 2 * 60 * 1000;
const ELEMENT_TIMEOUT_MS = 30_000;
const ADMIT_POLL_INTERVAL_MS = 2_000;

// Host-not-started retry budget — Zoom shows "invalid link" until the
// host actually starts the meeting. Poll for up to 10 min.
const HOST_NOT_STARTED_RETRY_INTERVAL_MS = 15_000;
const HOST_NOT_STARTED_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * Rewrite a Zoom meeting URL to the canonical Web Client URL when
 * it's clearly a `zoom.us/j/<id>` link. Anything else is returned
 * as-is so the bot navigates the original page.
 */
export function buildZoomWebClientUrl(meetingUrl: string): string {
  try {
    const url = new URL(meetingUrl);

    // Zoom Events redirects internally — leave alone.
    if (url.hostname === 'events.zoom.us') return meetingUrl;

    // Already a web client URL — leave alone.
    if (meetingUrl.includes('/wc/')) return meetingUrl;

    // Canonical zoom.us / *.zoom.us only — does NOT match
    // "zoom-lfx.platform.linuxfoundation.org" etc.
    const isCanonical = url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us');
    if (!isCanonical) return meetingUrl;

    const m = url.pathname.match(/\/j\/(\d+)/);
    const meetingId = m?.[1];
    if (!meetingId) return meetingUrl;

    const pwd = url.searchParams.get('pwd') || '';
    const wc = new URL(`https://app.zoom.us/wc/${meetingId}/join`);
    if (pwd) wc.searchParams.set('pwd', pwd);
    return wc.toString();
  } catch {
    return meetingUrl;
  }
}

export interface ZoomBotOptions extends BotOptions {
  /** Optional passcode for meetings that require one in a dedicated
   *  field (separate from the URL ?pwd= param). */
  passcode?: string;
}

export class ZoomBot implements MeetingBot {
  readonly platform = 'zoom';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private left = false;
  private readonly passcode: string | undefined;

  constructor(private readonly opts: ZoomBotOptions) {
    this.passcode = opts.passcode;
  }

  private log(msg: string): void {
    console.log(`[zoom ${this.opts.sessionId.slice(0, 8)}] ${msg}`);
  }

  async join(): Promise<void> {
    const { meetingUrl, displayName, callbacks } = this.opts;
    const webClientUrl = buildZoomWebClientUrl(meetingUrl);
    if (webClientUrl !== meetingUrl) {
      this.log(`rewrote meeting URL to web client: ${webClientUrl}`);
    }

    try {
      this.log('launching Chromium');
      this.browser = await chromium.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--window-size=1280,720',
        ],
      });

      const context = await this.browser.newContext({
        permissions: ['microphone', 'camera'],
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
      });
      const page = await context.newPage();
      this.page = page;

      // ── 1. Navigate, retrying while the host hasn't started. ──
      await this.navigateUntilLive(webClientUrl);
      this.log(`page ready: "${await page.title()}" @ ${page.url()}`);

      // ── 2. Click through the "Allow microphone & camera" permission dialog. ──
      // ALL bots must allow audio access — even recorder-only — because
      // otherwise Zoom won't create the <audio> elements that carry
      // remote audio.
      await this.handlePermissionDialogs();

      // ── 3. Wait for the pre-join name input. ──
      this.log('waiting for the Zoom pre-join name input');
      // White-label URLs (T&C portals, etc.) need extra time because a
      // human may need to VNC in and click through extra pages.
      const isWhiteLabel = webClientUrl === meetingUrl && !meetingUrl.includes('/wc/');
      const nameTimeout = isWhiteLabel ? 5 * 60_000 : ELEMENT_TIMEOUT_MS;
      try {
        await page.waitForSelector(nameInputSelector, { timeout: nameTimeout });
      } catch {
        // Last-chance auth check — meetings with "only authenticated
        // users can join" never render #input-for-name.
        if (await this.bodyMatchesAny(signInRequiredTexts)) {
          throw new Error('auth_required: meeting host has restricted entry to authenticated Zoom users; bot cannot join without a Zoom account session');
        }
        throw new Error('Zoom pre-join name input never rendered');
      }

      // ── 4. Passcode handling. ──
      const hasPasscodeField = await page
        .locator(passcodeInputSelector)
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      if (hasPasscodeField) {
        if (this.passcode) {
          await page.locator(passcodeInputSelector).first().fill(this.passcode);
          this.log('filled the passcode field');
        } else {
          throw new Error('passcode_required: meeting requires a passcode but none was provided; pass passcode in the start payload or include ?pwd=... in the meeting URL');
        }
      }

      // ── 5. Fill the name with REAL keyboard events. ──
      // React-compatible native setters don't fully satisfy Zoom's
      // form validation — the Join button stays disabled. Real
      // focus + keyboard.type triggers Zoom's full input pipeline.
      await page.locator(nameInputSelector).first().click({ timeout: 5_000 }).catch(() => undefined);
      await page.locator(nameInputSelector).first().fill('');
      await page.keyboard.type(displayName, { delay: 30 });
      this.log(`typed display name: "${displayName}"`);

      // Wait for Zoom's React state to enable the Join button.
      await page
        .waitForFunction(
          (sel: string) => {
            const btn = document.querySelector(sel) as HTMLButtonElement | null;
            return !!btn && !btn.classList.contains('disabled') && !btn.disabled;
          },
          joinButtonSelector,
          { timeout: 8_000 },
        )
        .catch(() => this.log('WARNING: Join button still disabled after typing name; attempting click anyway'));

      // ── 6. Mute mic + stop video in preview (recorder only). ──
      try {
        const muteBtn = page.locator(previewMuteSelector);
        const muteLabel = await muteBtn.getAttribute('aria-label');
        // "Mute" means currently UNmuted → click to mute.
        if (muteLabel === 'Mute') {
          await muteBtn.click();
          this.log('muted mic in preview');
        }
      } catch {
        /* may already be muted */
      }
      try {
        const videoBtn = page.locator(previewVideoSelector);
        const videoLabel = await videoBtn.getAttribute('aria-label');
        if (videoLabel === 'Stop Video') {
          await videoBtn.click();
          this.log('stopped video in preview');
        }
      } catch {
        /* may already be off */
      }

      // ── 7. Click Join via DOM (bypasses pointer-event interception). ──
      this.log('clicking Join (DOM-direct)');
      const clicked = await page.evaluate((sel: string) => {
        const btn = document.querySelector(sel) as HTMLButtonElement | null;
        if (!btn) return false;
        if (btn.classList.contains('disabled') || btn.disabled) return false;
        btn.click();
        return true;
      }, joinButtonSelector);
      if (!clicked) {
        this.log('DOM-direct click failed — falling back to Playwright click');
        await page.locator(joinButtonSelector).click({ force: true, timeout: 10_000 });
      }
      callbacks.onWaitingAdmit?.();

      // ── 8. Poll for admission (or rejection / wait-room timeout). ──
      await this.waitForAdmission(ADMIT_TIMEOUT_MS);
      this.log('admitted — the bot is in the Zoom meeting');
      callbacks.onAdmitted?.();

      this.watchForEnd();
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : 'join failed';
      const diagnosis = await this.capturePageState();
      const message = `Zoom join failed: ${reason}${diagnosis}`;
      this.log(message);
      this.opts.callbacks.onError?.(message);
      await this.leave();
    }
  }

  /** Navigate to the meeting URL, retrying while the host hasn't
   *  started yet. Throws on auth_required (fail fast — retrying
   *  won't help). */
  private async navigateUntilLive(webClientUrl: string): Promise<void> {
    const page = this.page!;
    const start = Date.now();
    while (true) {
      this.log(`navigating to ${webClientUrl}`);
      await page.goto(webClientUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(2_000);

      const title = (await page.title().catch(() => '')) || '';
      const isError = title === invalidMeetingTitle || title.toLowerCase() === invalidMeetingTitle.toLowerCase();

      // Auth-required meetings never render #input-for-name; fail fast.
      if (await this.bodyMatchesAny(signInRequiredTexts)) {
        throw new Error('auth_required: meeting host has restricted entry to authenticated Zoom users; bot cannot join without a Zoom account session');
      }

      if (!isError) {
        // Sanity-check the body too — Zoom sometimes lands on a
        // generic "invalid link" page without setting the error title.
        const bodyError = await page
          .locator(`text=${JSON.stringify(invalidMeetingText)}`)
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        if (!bodyError) return;
      }

      const elapsed = Date.now() - start;
      if (elapsed >= HOST_NOT_STARTED_MAX_WAIT_MS) {
        throw new Error('host did not start the meeting within the wait window');
      }
      this.log(`host hasn't started yet (title="${title}") — retrying in ${HOST_NOT_STARTED_RETRY_INTERVAL_MS / 1000}s`);
      await page.waitForTimeout(HOST_NOT_STARTED_RETRY_INTERVAL_MS);
    }
  }

  /** Click "Allow" up to twice (Zoom shows the permission dialog
   *  separately for camera+mic, then mic only). Falls back to
   *  "Continue without microphone and camera" with a warning — that
   *  path breaks audio capture but at least dismisses the dialog. */
  private async handlePermissionDialogs(): Promise<void> {
    const page = this.page!;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const allow = page.locator(permissionAllowSelector).first();
        if (await allow.isVisible({ timeout: 4_000 }).catch(() => false)) {
          await allow.click();
          this.log(`granted audio/video permission (attempt ${attempt + 1})`);
          await page.waitForTimeout(600);
          continue;
        }
        const dismiss = page.locator(permissionDismissSelector).first();
        if (await dismiss.isVisible({ timeout: 1_000 }).catch(() => false)) {
          this.log(`WARNING: no "Allow" button — dismissing permission (audio capture may be broken) attempt ${attempt + 1}`);
          await dismiss.click();
          await page.waitForTimeout(600);
        } else {
          return;
        }
      } catch {
        return;
      }
    }
  }

  private async waitForAdmission(timeoutMs: number): Promise<void> {
    const page = this.page!;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Removed / ended modal — definitive failure.
      if (await this.bodyMatchesAny(endedTexts)) {
        throw new Error('meeting ended or bot was removed before admission');
      }

      // Leave button visible ⇒ we're in the meeting.
      const leaveVisible = await page
        .locator(leaveButtonSelector)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (leaveVisible) return;

      // Otherwise keep waiting — the waiting-room text is just for
      // logging; admission is signaled by the Leave button.
      const waiting = await this.bodyMatchesAny(waitingRoomTexts);
      if (waiting) {
        // No-op; just keep polling.
      }
      await page.waitForTimeout(ADMIT_POLL_INTERVAL_MS);
    }
    throw new Error(`timed out waiting for Zoom admission after ${Math.round(timeoutMs / 1000)}s`);
  }

  /** Case-insensitive substring match against the body text. */
  private async bodyMatchesAny(needles: string[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    try {
      const body = (await page.locator('body').innerText({ timeout: 1_500 })).toLowerCase();
      return needles.some((n) => body.includes(n.toLowerCase()));
    } catch {
      return false;
    }
  }

  private async capturePageState(): Promise<string> {
    const page = this.page;
    if (!page) return '';
    try {
      const url = page.url();
      const title = await page.title().catch(() => '(no title)');
      let text = '';
      try {
        text = (await page.locator('body').innerText({ timeout: 3000 }))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 280);
      } catch {
        /* body not readable */
      }
      try {
        await page.screenshot({ path: screenshotPath(this.opts.sessionId) });
        this.log('saved a diagnostic screenshot');
      } catch {
        /* screenshot failed — not fatal */
      }
      this.log(`page title: "${title}"`);
      this.log(`page url:   ${url}`);
      this.log(`page text:  ${text}`);
      return ` | page="${title}" | shows="${text}"`;
    } catch {
      return '';
    }
  }

  private watchForEnd(): void {
    const check = async () => {
      if (!this.page || this.left) return;
      try {
        if (await this.bodyMatchesAny(endedTexts)) {
          this.log('meeting ended / bot removed');
          this.opts.callbacks.onLeft?.();
          return;
        }
      } catch {
        /* page may be mid-navigation */
      }
      setTimeout(check, 5000);
    };
    setTimeout(check, 5000);
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;

    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.locator(leaveButtonSelector).first().click({ timeout: 3_000 });
        this.log('clicked Leave');
      } catch {
        /* may not be in the meeting */
      }
    }
    this.page = null;

    try {
      await this.browser?.close();
    } catch {
      /* already closed */
    }
    this.browser = null;
  }
}
