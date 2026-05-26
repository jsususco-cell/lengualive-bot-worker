// ─── Google Meet bot ────────────────────────────────────────────
// Drives a real Chromium (via Playwright, running "headed" inside a
// virtual X display) into a Google Meet call.
//
// ⚠️  Google Meet has no bot API; this automates the live web UI.
// Selectors live in ./googleMeetSelectors — each is a list so we can
// fall back through UI variants. On ANY failure the bot logs the page
// title/text and writes a screenshot (see capturePageState) so a
// blind timeout becomes a real diagnosis.
//
// Flow modelled on Vexa's googlemeet/join.ts + admission.ts: enter
// guest name → mute mic+cam → click join → poll for admission OR
// rejection, distinguishing "still in the lobby" from "admitted but
// some lobby DOM lingered" from "kicked out".

import { chromium, type Browser, type Page } from 'playwright';
import type { MeetingBot, BotOptions } from './types.js';
import { screenshotPath } from '../paths.js';
import { applyGoogleSession } from '../googleSession.js';
import {
  nameInputSelectors,
  joinButtonSelectors,
  microphoneOffSelectors,
  cameraOffSelectors,
  admittedIndicators,
  waitingRoomIndicators,
  rejectionIndicators,
  endOfCallIndicators,
  leaveButtonSelectors,
} from './googleMeetSelectors.js';

// How long to wait for the host to admit the bot.
const ADMIT_TIMEOUT_MS = 2 * 60 * 1000;
// How long to wait for a pre-join element (name field, join button).
const ELEMENT_TIMEOUT_MS = 30_000;
// Admission-poll cadence.
const ADMIT_POLL_INTERVAL_MS = 2_000;

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
        // Do NOT override userAgent: Chromium's real, current UA is what
        // keeps Meet from showing its "unsupported browser" downgrade.
        locale: 'en-US',
      });

      // Inject the saved Google session, if one is configured. Meet
      // refuses anonymous bots, so this is what actually gets us in.
      const signedIn = await applyGoogleSession(context);
      this.log(signedIn
        ? 'loaded a saved Google session — joining signed-in'
        : 'no Google session configured — joining anonymously');

      const page = await context.newPage();
      this.page = page;

      this.log(`navigating to ${meetingUrl}`);
      await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Brief settle so the SPA can render the pre-join.
      await page.waitForTimeout(1_500);

      // A fresh browser hitting a Google domain may be bounced through
      // a cookie-consent interstitial first.
      await this.dismissConsent();

      this.log(`page ready: "${await page.title()}" @ ${page.url()}`);

      // Catch rejection at the pre-join stage — e.g. anonymous bot
      // blocked with "You can't join this video call".
      if (await this.anyVisible(rejectionIndicators)) {
        throw new Error('Meet rejected the bot before it could join (rejection screen on the pre-join page)');
      }

      // ── Guest name (only required for the anonymous flow). ──
      if (signedIn) {
        this.log('signed-in mode: skipping name input');
      } else {
        await this.fillName(displayName);
      }

      // ── Turn the microphone and camera off before joining. ──
      // Best-effort; some account states pre-mute and these buttons
      // either aren't there or are already in the "off" state.
      await this.tryClickAny(microphoneOffSelectors, 'mic off');
      await this.tryClickAny(cameraOffSelectors, 'camera off');

      // ── Join. ──
      this.log('looking for the join button');
      await this.clickAnyOrThrow(joinButtonSelectors, 'join button', ELEMENT_TIMEOUT_MS);
      this.log('clicked join — waiting to be admitted');
      callbacks.onWaitingAdmit?.();

      // ── Poll for admission. ──
      await this.waitForAdmission(ADMIT_TIMEOUT_MS);
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

  /** Fill the guest-name input on the pre-join screen. Tries each
   *  selector in order and throws if none of them appear. */
  private async fillName(displayName: string): Promise<void> {
    const page = this.page!;
    for (const selector of nameInputSelectors) {
      try {
        const input = page.locator(selector).first();
        await input.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT_MS / nameInputSelectors.length });
        await input.fill(displayName);
        this.log(`filled the guest name via ${selector}`);
        return;
      } catch {
        /* try the next */
      }
    }
    throw new Error('could not find the guest-name input on the Meet pre-join screen');
  }

  /** Click the first locator in `selectors` that becomes visible
   *  within `timeoutMs`. Throws if none are clickable. */
  private async clickAnyOrThrow(
    selectors: string[],
    label: string,
    timeoutMs: number,
  ): Promise<void> {
    const page = this.page!;
    const perSelector = Math.max(2_000, Math.floor(timeoutMs / selectors.length));
    let lastErr: unknown = null;
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'visible', timeout: perSelector });
        await loc.click({ timeout: 5_000 });
        this.log(`clicked ${label} via ${selector}`);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`could not click ${label}: ${
      lastErr instanceof Error ? lastErr.message.split('\n')[0] : 'no matching selector'
    }`);
  }

  /** Try clicking the first locator in `selectors` that's visible
   *  within a tight per-selector budget. Never throws. */
  private async tryClickAny(selectors: string[], label: string): Promise<void> {
    const page = this.page!;
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        if (!(await loc.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
        await loc.click({ timeout: 3_000 });
        this.log(`clicked: ${label} (${selector})`);
        return;
      } catch {
        /* try next */
      }
    }
    this.log(`skipped: ${label} (no matching selector)`);
  }

  /** Return true if ANY of the selectors is currently visible. */
  private async anyVisible(selectors: string[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    for (const selector of selectors) {
      try {
        if (await page.locator(selector).first().isVisible({ timeout: 500 })) return true;
      } catch {
        /* continue */
      }
    }
    return false;
  }

  /** Poll until either an admission indicator is visible (success), a
   *  rejection indicator is visible (throw), or the timeout elapses
   *  (throw). Distinguishes "still in lobby" from "admitted but with
   *  stale lobby DOM" by checking the waiting-room indicators as a
   *  negative guard before declaring admission. */
  private async waitForAdmission(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.anyVisible(rejectionIndicators)) {
        throw new Error('Meet rejected the bot (admin denied entry, or meeting is closed)');
      }
      const inLobby = await this.anyVisible(waitingRoomIndicators);
      if (!inLobby && (await this.anyVisible(admittedIndicators))) {
        return;
      }
      await this.page!.waitForTimeout(ADMIT_POLL_INTERVAL_MS);
    }
    throw new Error(`timed out waiting for admission after ${Math.round(timeoutMs / 1000)}s`);
  }

  /** Snapshot what the page actually shows — turns a blind timeout
   *  into a real diagnosis. Logs + screenshots, and returns a short
   *  suffix appended to the error message (so it surfaces via
   *  GET /sessions/:id). */
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

  /** Poll for Meet's "you've left / been removed" screen. */
  private watchForEnd(): void {
    const check = async () => {
      if (!this.page || this.left) return;
      try {
        if (await this.anyVisible(endOfCallIndicators)) {
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
      const page = this.page;
      for (const selector of leaveButtonSelectors) {
        try {
          await page.locator(selector).first().click({ timeout: 3_000 });
          this.log(`clicked leave via ${selector}`);
          break;
        } catch {
          /* try the next */
        }
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
