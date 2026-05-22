// ─── Google Meet bot ────────────────────────────────────────────
// Drives a real Chromium (via Playwright, running "headed" inside a
// virtual X display) into a Google Meet call as a guest.
//
// ⚠️  The DOM selectors below are the FRAGILE part of this whole
// service. Google ships UI changes to Meet regularly and does not
// publish a bot API, so every selector marked `TODO(selector)` must
// be verified — and re-verified — against the live page. Expect to
// adjust these the first time you run against a real meeting.

import { chromium, type Browser, type Page } from 'playwright';
import type { MeetingBot, BotOptions } from './types.js';

// How long to wait for the host to admit the bot before giving up.
const ADMIT_TIMEOUT_MS = 2 * 60 * 1000;

export class GoogleMeetBot implements MeetingBot {
  readonly platform = 'google-meet';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private left = false;

  constructor(private readonly opts: BotOptions) {}

  async join(): Promise<void> {
    const { meetingUrl, displayName, callbacks } = this.opts;

    try {
      this.browser = await chromium.launch({
        // Headed (inside Xvfb): Meet detects true headless and behaves
        // differently, so we render to a virtual display instead.
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          // Auto-accept the mic/camera permission prompt.
          '--use-fake-ui-for-media-stream',
          // Provide a fake mic/cam so getUserMedia succeeds with no hardware.
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--window-size=1280,720',
        ],
      });

      const context = await this.browser.newContext({
        permissions: ['microphone', 'camera'],
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      this.page = page;

      await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // ── Enter the bot's display name (guest join). ──
      // TODO(selector): Meet's pre-join name field.
      const nameInput = page
        .locator('input[aria-label="Your name"], input[placeholder="Your name"]')
        .first();
      try {
        await nameInput.waitFor({ state: 'visible', timeout: 15_000 });
        await nameInput.fill(displayName);
      } catch {
        // Sign-in-only meetings never show a guest name field. We carry
        // on; if the bot truly can't join it surfaces as an admit timeout.
      }

      // ── Turn the microphone and camera OFF before joining. ──
      // TODO(selector): pre-join mic/cam toggle buttons. Their aria-label
      // text switches between "Turn off …" and "Turn on …" by state.
      await this.tryClick('button[aria-label*="Turn off microphone"]');
      await this.tryClick('button[aria-label*="Turn off camera"]');

      // ── Click "Ask to join" / "Join now". ──
      // TODO(selector): join button — label depends on the meeting policy.
      const joinButton = page
        .locator('button:has-text("Ask to join"), button:has-text("Join now")')
        .first();
      await joinButton.waitFor({ state: 'visible', timeout: 15_000 });
      await joinButton.click();

      callbacks.onWaitingAdmit?.();

      // ── Wait to be admitted. ──
      // The leave-call control only exists once we're actually inside.
      // TODO(selector): in-meeting "Leave call" button.
      const inMeeting = page.locator('button[aria-label*="Leave call"]').first();
      await inMeeting.waitFor({ state: 'visible', timeout: ADMIT_TIMEOUT_MS });

      callbacks.onAdmitted?.();
      this.watchForEnd();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join the meeting';
      this.opts.callbacks.onError?.(`Google Meet join failed: ${message}`);
      await this.leave();
    }
  }

  /** Click a selector if it is present; never throws. */
  private async tryClick(selector: string): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.locator(selector).first().click({ timeout: 3000 });
    } catch {
      // Not present / not clickable in the current state — that's fine.
    }
  }

  /** Poll for Meet's "you've left / been removed" screen. */
  private watchForEnd(): void {
    const check = async () => {
      if (!this.page || this.left) return;
      try {
        // TODO(selector): Meet's post-call screen copy.
        const ended = this.page
          .locator('text=/You.{0,3}ve left the meeting|removed from the meeting|meeting.{0,3}s ended/i')
          .first();
        if (await ended.isVisible()) {
          this.opts.callbacks.onLeft?.();
          return;
        }
      } catch {
        // Page may be mid-navigation — ignore and retry.
      }
      setTimeout(check, 5000);
    };
    setTimeout(check, 5000);
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;

    if (this.page) {
      // Best-effort graceful leave so the bot disappears from the roster.
      await this.tryClick('button[aria-label*="Leave call"]');
    }
    this.page = null;

    try {
      await this.browser?.close();
    } catch {
      // Already closed.
    }
    this.browser = null;
  }
}
