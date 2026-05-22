// ─── Google Meet bot ────────────────────────────────────────────
// Drives a real Chromium (via Playwright, running "headed" inside a
// virtual X display) into a Google Meet call as a guest.
//
// ⚠️  Google Meet has no bot API; this automates the live web UI.
// Selectors use getByRole — resilient to Google's obfuscated class
// names — but still depend on the UI's accessible labels. On ANY
// failure the bot logs the page title/text and writes a screenshot
// (see capturePageState) so a blind timeout becomes a real diagnosis.

import { chromium, type Browser, type Page, type Locator } from 'playwright';
import type { MeetingBot, BotOptions } from './types.js';
import { screenshotPath } from '../paths.js';

// How long to wait for the host to admit the bot.
const ADMIT_TIMEOUT_MS = 2 * 60 * 1000;
// How long to wait for a pre-join element (name field, join button).
const ELEMENT_TIMEOUT_MS = 20_000;

export class GoogleMeetBot implements MeetingBot {
  readonly platform = 'google-meet';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private left = false;

  constructor(private readonly opts: BotOptions) {}

  private log(msg: string): void {
    console.log(`[meet ${this.opts.sessionId.slice(0, 8)}] ${msg}`);
  }

  async join(): Promise<void> {
    const { meetingUrl, displayName, callbacks } = this.opts;

    try {
      this.log('launching Chromium');
      this.browser = await chromium.launch({
        // Headed inside Xvfb — Meet behaves differently under true headless.
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
        // Pin locale so Meet's UI text — and our selectors — stay English.
        locale: 'en-US',
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      this.page = page;

      this.log(`navigating to ${meetingUrl}`);
      await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // A fresh browser hitting a Google domain is often bounced through
      // a cookie-consent interstitial first.
      await this.dismissConsent();

      this.log(`page ready: "${await page.title()}" @ ${page.url()}`);

      // ── Guest name (best-effort — absent on sign-in-only meetings). ──
      try {
        const nameInput = page.getByRole('textbox', { name: /your name/i }).first();
        await nameInput.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT_MS });
        await nameInput.fill(displayName);
        this.log('filled the guest name');
      } catch {
        this.log('no guest-name field found (continuing anyway)');
      }

      // ── Turn the microphone and camera off before joining. ──
      await this.tryClick(
        page.getByRole('button', { name: /turn off microphone/i }), 'mic off');
      await this.tryClick(
        page.getByRole('button', { name: /turn off camera/i }), 'camera off');

      // ── Join. ──
      this.log('looking for the join button');
      const joinButton = page
        .getByRole('button', { name: /ask to join|join now|join meeting/i })
        .first();
      await joinButton.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT_MS });
      await joinButton.click();
      this.log('clicked join — waiting to be admitted');
      callbacks.onWaitingAdmit?.();

      // ── Wait for the host to admit the bot. ──
      const leaveButton = page.getByRole('button', { name: /leave call/i }).first();
      await leaveButton.waitFor({ state: 'visible', timeout: ADMIT_TIMEOUT_MS });
      this.log('admitted — the bot is in the meeting');
      callbacks.onAdmitted?.();

      this.watchForEnd();
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : 'join failed';
      const diagnosis = await this.capturePageState();
      const message = `Google Meet join failed: ${reason}${diagnosis}`;
      this.log(message);
      this.opts.callbacks.onError?.(message);
      await this.leave();
    }
  }

  /** Snapshot what the page actually shows — turns a blind timeout into
   *  a real diagnosis. Logs + screenshots, and returns a short suffix
   *  appended to the error message (so it surfaces via GET /sessions/:id). */
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

  /** Get past Google's cookie-consent interstitial, if we landed on it. */
  private async dismissConsent(): Promise<void> {
    const page = this.page;
    if (!page || !page.url().includes('consent.')) return;
    this.log('on the Google consent page — trying to accept');
    for (const name of [/accept all/i, /i agree/i, /reject all/i]) {
      try {
        await page.getByRole('button', { name }).first().click({ timeout: 4000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
        this.log('cleared the consent page');
        return;
      } catch {
        /* try the next label */
      }
    }
    this.log('could not clear the consent page');
  }

  /** Click a locator if present; never throws. */
  private async tryClick(locator: Locator, label: string): Promise<void> {
    try {
      await locator.first().click({ timeout: 4000 });
      this.log(`clicked: ${label}`);
    } catch {
      this.log(`skipped: ${label} (not found)`);
    }
  }

  /** Poll for Meet's "you've left / been removed" screen. */
  private watchForEnd(): void {
    const check = async () => {
      if (!this.page || this.left) return;
      try {
        const ended = this.page
          .getByText(/you.{0,3}ve left the meeting|removed from the meeting|meeting.{0,3}s ended/i)
          .first();
        if (await ended.isVisible()) {
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

    if (this.page) {
      await this.tryClick(
        this.page.getByRole('button', { name: /leave call/i }), 'leave call');
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
