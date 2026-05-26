// ─── Microsoft Teams selectors ───────────────────────────────────
// Selector lists used by the join flow. Lifted from Vexa's curated
// list (Vexa-ai/vexa/services/vexa-bot/core/src/platforms/msteams/
// selectors.ts) and trimmed to what we actually consult.

// "Open Teams app or continue on this browser" splash.
export const continueOnBrowserSelectors: string[] = [
  'button:has-text("Continue on this browser")',
  'button:has-text("Use the web app")',
  'button:has-text("Join on the web instead")',
  'button:has-text("Continue")',
];

// Intermittent pre-join modal: "Are you sure you don't want audio or
// video?" — appears when Chromium's media-permission state is
// "denied". Blocks the prejoin from rendering until dismissed.
export const continueWithoutMediaSelectors: string[] = [
  'button:has-text("Continue without audio or video")',
  'button[aria-label="Continue without audio or video"]',
  'button[aria-label*="Continue without audio"]',
  '[role="dialog"] button:has-text("Continue without audio or video")',
  '[role="alertdialog"] button:has-text("Continue without audio or video")',
];

// Guest name input on the pre-join screen.
export const nameInputSelectors: string[] = [
  'input[placeholder*="name"]',
  'input[placeholder*="Name"]',
  'input[type="text"]',
];

// Pre-join "Computer audio" radio (vs "Don't use audio"). We force
// Computer audio so the bot actually receives the call.
export const computerAudioRadioSelectors: string[] = [
  '[role="radio"][aria-label*="Computer audio"]',
  'radio[aria-label*="Computer audio"]',
  'radio:has-text("Computer audio")',
];

export const dontUseAudioRadioSelectors: string[] = [
  '[role="radio"][aria-label*="Don\'t use audio"]',
  'radio[aria-label*="Don\'t use audio"]',
  'radio:has-text("Don\'t use audio")',
];

// Pre-join camera toggle (any of the four label variants Teams uses).
export const cameraToggleSelectors: string[] = [
  'button[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn camera off"]',
  'button[aria-label*="Turn off video"]',
  'button[aria-label*="Turn video off"]',
];

// "Join now" button on the pre-join screen.
export const joinButtonSelectors: string[] = [
  'button:has-text("Join now")',
  '[aria-label*="Join now"]',
  'button:has-text("Join")',
];

// In-meeting leave / hang-up button — also the definitive "we are
// admitted" indicator.
export const leaveButtonSelectors: string[] = [
  'button[id="hangup-button"]',
  'button[data-tid="hangup-main-btn"]',
  'button[aria-label="Leave"]',
  'button[aria-label*="Leave"]',
];

// Definitive "we're inside the meeting" indicators. None of these
// exist on the pre-join screen.
export const admittedIndicators: string[] = [
  'button[id="hangup-button"]',
  'button[data-tid="hangup-main-btn"]',
  '[role="toolbar"] button[aria-label*="Leave"]',
  '[role="toolbar"] button[aria-label*="Share"]',
  'button[aria-label*="Turn off microphone"]:not([disabled])',
  'button[aria-label*="Turn on microphone"]:not([disabled])',
];

// Still-in-the-lobby indicators.
export const waitingRoomIndicators: string[] = [
  'text="Someone will let you in shortly"',
  'text*="Someone will let you in shortly"',
  'text="You\'re in the lobby"',
  'text="Waiting for someone to let you in"',
  'text="Waiting to be admitted"',
  'text="Your request to join has been sent"',
];

// Rejection / meeting-not-found screens.
export const rejectionIndicators: string[] = [
  'text="Sorry, but you were denied"',
  'text*="Sorry, but you were denied"',
  'text="You were denied entry"',
  'text="Meeting not found"',
  'text="Unable to join"',
  'text*="Unable to join"',
  '[role="dialog"]:has-text("denied")',
  '[role="alertdialog"]:has-text("denied")',
];

// "Meeting ended / you were removed" indicators.
export const endOfCallIndicators: string[] = [
  'text*="You\'ve been removed from this meeting"',
  'text*="You have been removed from this meeting"',
  'text*="Removed from meeting"',
  'text*="Meeting ended"',
  'text*="Call ended"',
  'text*="Connection lost"',
];

// Permission-prompt text that signals Teams is gated on browser media
// permission — surfaces only on the "light meetings" page.
export const permissionGateText =
  'text=/Select Allow to let Microsoft Teams use your mic and camera/i';
