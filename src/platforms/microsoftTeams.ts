// ─── Microsoft Teams bot ────────────────────────────────────────
// Drives a real Chromium (Playwright, headed inside Xvfb) into a
// Teams web meeting. Handles both teams.live.com (Teams Free /
// personal) and teams.microsoft.com (Teams for work/school) URLs.
//
// Anonymous guest join works for:
//   - Personal / Teams Free meetings, and
//   - Business meetings whose tenant has "Anonymous users can join"
//     enabled.
// For tenants that require sign-in, anonymous join is impossible —
// the fix is a Microsoft session-cookies injection mirroring
// applyGoogleSession (TODO, not implemented yet).
//
// Flow modelled on Vexa's msteams/join.ts: bypass the splash → loop
// until the prejoin actually renders (handles the intermittent
// "Continue without audio or video" confirmation modal that
// otherwise blocks Join now from enabling) → set Computer-audio →
// camera off → fill name → click Join now → mute via Ctrl+Shift+M →
// poll admission/rejection.

import { chromium, type Browser, type Page } from 'playwright';
import type { MeetingBot, BotOptions } from './types.js';
import { screenshotPath } from '../paths.js';
import {
  continueOnBrowserSelectors,
  continueWithoutMediaSelectors,
  nameInputSelectors,
  computerAudioRadioSelectors,
  dontUseAudioRadioSelectors,
  cameraToggleSelectors,
  joinButtonSelectors,
  leaveButtonSelectors,
  admittedIndicators,
  waitingRoomIndicators,
  rejectionIndicators,
  endOfCallIndicators,
  permissionGateText,
} from './microsoftTeamsSelectors.js';

const ADMIT_TIMEOUT_MS = 2 * 60 * 1000;
const PREJOIN_READY_TIMEOUT_MS = 60_000;
const ELEMENT_TIMEOUT_MS = 25_000;
const ADMIT_POLL_INTERVAL_MS = 2_000;

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
      await page.waitForTimeout(500);

      // Microsoft cookie / consent banners.
      await this.dismissConsent();

      this.log(`page ready: "${await page.title()}" @ ${page.url()}`);

      // ── Bypass the "Open Teams app or continue on this browser" splash. ──
      await this.tryClickAny(continueOnBrowserSelectors, 'continue on this browser');

      // ── Wait for the prejoin to actually render. ──
      // Teams sometimes pops a "Continue without audio or video"
      // confirmation modal that BLOCKS the prejoin Join button from
      // ever enabling — we click through it here.
      const ready = await this.waitForPreJoinReadiness(PREJOIN_READY_TIMEOUT_MS);
      if (!ready) {
        throw new Error('Teams pre-join controls never became ready');
      }

      // Pre-join rejection screens (meeting not found, etc).
      if (await this.anyVisible(rejectionIndicators)) {
        throw new Error('Teams rejected the bot before it could join (rejection screen on the pre-join page)');
      }

      // ── Camera off. ──
      await this.tryClickAny(cameraToggleSelectors, 'camera off');

      // ── Guest name. ──
      await this.fillName(displayName);

      // ── Make sure Computer audio is selected (not "Don't use audio"). ──
      await this.ensureComputerAudio();

      // ── Click Join now. ──
      this.log('clicking Join now');
      await this.clickAnyOrThrow(joinButtonSelectors, 'Join now', ELEMENT_TIMEOUT_MS);
      callbacks.onWaitingAdmit?.();

      // Mute the mic via keyboard shortcut — survives label variance
      // across Teams UI versions. Best-effort; in some states the
      // shortcut isn't bound until the meeting view actually loads.
      await page.keyboard.press('Control+Shift+M').catch(() => undefined);

      // ── Poll for admission. ──
      await this.waitForAdmission(ADMIT_TIMEOUT_MS);
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

  /** Loop until either the prejoin Join button + name input render
   *  (success), the timeout elapses (failure), or we run out of
   *  through-clicks on the intermittent confirmation modal. */
  private async waitForPreJoinReadiness(timeoutMs: number): Promise<boolean> {
    const page = this.page!;
    const start = Date.now();
    let continueWithoutMediaClicks = 0;
    let continueClicks = 0;
    let mediaWarmupAttempted = false;

    while (Date.now() - start < timeoutMs) {
      // 1. "Continue without audio or video" — intermittent confirm modal
      //    that BLOCKS the prejoin. Click through it eagerly.
      if (await this.anyVisible(continueWithoutMediaSelectors) && continueWithoutMediaClicks < 3) {
        continueWithoutMediaClicks++;
        this.log(`dismissing "Continue without audio or video" modal (attempt ${continueWithoutMediaClicks})`);
        await this.tryClickAny(continueWithoutMediaSelectors, 'continue without media');
        await page.waitForTimeout(500);
        continue;
      }

      // 2. Prejoin readiness — either the "Join now" button is visible,
      //    or the name input + camera toggle pair tells us the prejoin
      //    rendered.
      const joinNowVisible = await this.anyVisible(['button:has-text("Join now")', '[aria-label*="Join now"]']);
      const nameVisible = await this.anyVisible(nameInputSelectors);
      const cameraVisible = await this.anyVisible(cameraToggleSelectors);
      if (joinNowVisible || (nameVisible && cameraVisible)) {
        this.log('Teams pre-join is ready');
        return true;
      }

      // 3. Splash button still on screen — click through again.
      if (await this.anyVisible(continueOnBrowserSelectors) && continueClicks < 2) {
        continueClicks++;
        await this.tryClickAny(continueOnBrowserSelectors, 'continue on this browser (retry)');
        await page.waitForTimeout(500);
        continue;
      }

      // 4. Permission-gate text on the "light meetings" page —
      //    triggers Chromium to actually request mic/camera, which
      //    bypasses the gate.
      if (!mediaWarmupAttempted && (await this.anyVisible([permissionGateText]))) {
        mediaWarmupAttempted = true;
        this.log('Teams permission gate detected — running media warm-up');
        await this.warmUpMediaDevices();
      }

      await page.waitForTimeout(300);
    }

    this.log(`pre-join readiness timed out at ${page.url()}`);
    return false;
  }

  /** Trigger getUserMedia inside the page so Chromium grants mic /
   *  camera permission. Some Teams pages stall on a permission gate
   *  until permission is requested at least once. */
  private async warmUpMediaDevices(): Promise<void> {
    const page = this.page!;
    try {
      const result = await page.evaluate(async () => {
        try {
          if (!navigator.mediaDevices?.getUserMedia) return 'getUserMedia unavailable';
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          stream.getTracks().forEach((t) => t.stop());
          return 'media warm-up ok';
        } catch (err) {
          return `media warm-up failed: ${(err as Error)?.message || err}`;
        }
      });
      this.log(`media warm-up: ${result}`);
    } catch (err) {
      this.log(`media warm-up evaluate failed: ${(err as Error).message}`);
    }
  }

  /** Force the "Computer audio" radio so the bot actually receives
   *  meeting audio. Best-effort — older Teams UIs skip this radio. */
  private async ensureComputerAudio(): Promise<void> {
    const page = this.page!;
    try {
      const computerAudio = page.locator(computerAudioRadioSelectors.join(', ')).first();
      const dontUseAudio = page.locator(dontUseAudioRadioSelectors.join(', ')).first();
      const visible = await computerAudio.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!visible) {
        this.log('audio radios not visible — assuming defaults');
        return;
      }
      const dontUseChecked =
        (await dontUseAudio.isVisible({ timeout: 500 }).catch(() => false)) &&
        (await dontUseAudio.getAttribute('aria-checked')) === 'true';
      if (dontUseChecked) {
        this.log('"Don\'t use audio" was selected — switching to Computer audio');
      }
      await computerAudio.click({ timeout: 4_000 });
      this.log('selected Computer audio');
    } catch (err) {
      this.log(`could not enforce Computer audio: ${(err as Error).message}`);
    }
  }

  /** Fill the guest-name input on the pre-join screen. */
  private async fillName(displayName: string): Promise<void> {
    const page = this.page!;
    for (const selector of nameInputSelectors) {
      try {
        const input = page.locator(selector).first();
        await input.waitFor({ state: 'visible', timeout: 5_000 });
        await input.fill(displayName);
        this.log(`filled the guest name via ${selector}`);
        return;
      } catch {
        /* try next */
      }
    }
    this.log('no guest-name input found (continuing — may be signed-in)');
  }

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

  private async waitForAdmission(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.anyVisible(rejectionIndicators)) {
        throw new Error('Teams rejected the bot (admin denied entry)');
      }
      const inLobby = await this.anyVisible(waitingRoomIndicators);
      if (!inLobby && (await this.anyVisible(admittedIndicators))) {
        return;
      }
      await this.page!.waitForTimeout(ADMIT_POLL_INTERVAL_MS);
    }
    throw new Error(`timed out waiting for admission after ${Math.round(timeoutMs / 1000)}s`);
  }

  /** Snapshot the page on failure — same diagnostic pattern as the
   *  Google Meet bot. */
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

  /** Click through any Microsoft cookie/consent banner. */
  private async dismissConsent(): Promise<void> {
    const page = this.page;
    if (!page) return;
    for (const name of [/accept all/i, /^accept$/i, /reject all/i, /^agree$/i]) {
      try {
        await page.getByRole('button', { name }).first().click({ timeout: 3000 });
        this.log('dismissed a cookie/consent banner');
        return;
      } catch {
        /* try the next */
      }
    }
  }

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
