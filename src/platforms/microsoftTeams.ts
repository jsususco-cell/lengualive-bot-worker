// ─── Microsoft Teams bot ────────────────────────────────────────
// Drives a real Chromium (Playwright, headed inside Xvfb) into a
// Teams web meeting. Handles both teams.live.com (Teams Free /
// personal) and teams.microsoft.com (Teams for work/school) URLs.
//
// Anonymous guest join works for:
//   - Personal / Teams Free meetings, and
//   - Business meetings whose tenant has "Anonymous users can join"
//     enabled.
// For tenants that require sign-in, this bot will hit a sign-in wall
// — the fix is the same cookies-injection approach we built for
// Google (a sibling microsoftSession.ts), not implemented yet.
//
// ⚠️  Selectors marked `TODO(selector)` are best-effort against the
// current Teams web UI and will need verification on first real run.

import { chromium, type Browser, type Page, type Locator } from 'playwright';
import type { MeetingBot, BotOptions } from './types.js';
import { screenshotPath } from '../paths.js';

const ADMIT_TIMEOUT_MS = 2 * 60 * 1000;
const ELEMENT_TIMEOUT_MS = 25_000;

export class MicrosoftTeamsBot implements MeetingBot {
  readonly platform = 'teams';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private left = false;

  constructor(private readonly opts: BotOptions) {}

  private log(msg: string): void {
    console.log(`[teams ${this.opts.sessionId.slice(0, 8)}] ${msg}`);
  }

  async join(): Promise<void> {
    const { meetingUrl, displayName, callbacks } = this.opts;

    try {
      this.log('launching Chromium');
      this.browser = await chromium.launch({
        // Headed under Xvfb — Teams (like Meet) misbehaves under true headless.
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

      this.log(`navigating to ${meetingUrl}`);
      await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Microsoft cookie / consent banners.
      await this.dismissConsent();

      this.log(`page ready: "${await page.title()}" @ ${page.url()}`);

      // ── Bypass the "Open Teams app or continue in browser" splash. ──
      // TODO(selector): the entry button has several variant labels.
      await this.tryClick(
        page.getByRole('button', { name: /continue on this browser|join on the web( instead)?|use the web app/i }),
        'continue on this browser',
      );

      // ── Guest name (absent for signed-in users). ──
      try {
        const nameInput = page
          .getByRole('textbox', { name: /your name|enter name|type your name/i })
          .first();
        await nameInput.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT_MS });
        await nameInput.fill(displayName);
        this.log('filled the guest name');
      } catch {
        this.log('no guest-name field found (continuing anyway)');
      }

      // ── Turn off the mic + camera before joining. ──
      // Teams' pre-join toggles are buttons whose accessible names reference
      // the device state. TODO(selector): labels can change.
      await this.tryClick(
        page.getByRole('button', { name: /microphone.*on|turn microphone off|mute( microphone)?/i }),
        'mic off',
      );
      await this.tryClick(
        page.getByRole('button', { name: /camera.*on|turn camera off/i }),
        'camera off',
      );

      // ── Join. ──
      this.log('looking for the "Join now" button');
      const joinButton = page.getByRole('button', { name: /join now/i }).first();
      await joinButton.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT_MS });
      await joinButton.click();
      this.log('clicked Join now — waiting to be admitted');
      callbacks.onWaitingAdmit?.();

      // ── Wait for admission. ──
      // Once we're in the call, the leave/hang-up control becomes visible.
      // TODO(selector): in-meeting leave button.
      const leaveButton = page
        .getByRole('button', { name: /leave( call| meeting)?|hang up/i })
        .first();
      await leaveButton.waitFor({ state: 'visible', timeout: ADMIT_TIMEOUT_MS });
      this.log('admitted — the bot is in the Teams meeting');
      callbacks.onAdmitted?.();

      this.watchForEnd();
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : 'join failed';
      const diagnosis = await this.capturePageState();
      const message = `Teams join failed: ${reason}${diagnosis}`;
      this.log(message);
      this.opts.callbacks.onError?.(message);
      await this.leave();
    }
  }

  /** Snapshot what the page actually shows on failure — same pattern
   *  as the Google Meet bot. */
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

  /** Click through any Microsoft cookie/consent banner, if present. */
  private async dismissConsent(): Promise<void> {
    const page = this.page;
    if (!page) return;
    for (const name of [/accept all/i, /^accept$/i, /reject all/i, /^agree$/i]) {
      try {
        await page.getByRole('button', { name }).first().click({ timeout: 3000 });
        this.log('dismissed a cookie/consent banner');
        return;
      } catch {
        /* try the next label */
      }
    }
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

  /** Poll for Teams' "you've left / call ended" screens. */
  private watchForEnd(): void {
    const check = async () => {
      if (!this.page || this.left) return;
      try {
        const ended = this.page
          .getByText(/call ended|you left the meeting|meeting has ended|you have been removed/i)
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
        this.page.getByRole('button', { name: /leave( call| meeting)?|hang up/i }),
        'leave call',
      );
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
