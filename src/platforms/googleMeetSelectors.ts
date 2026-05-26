// ─── Google Meet selectors ───────────────────────────────────────
// Selector lists used by the join flow. Lifted from Vexa's curated
// list (Vexa-ai/vexa/services/vexa-bot/core/src/platforms/googlemeet/
// selectors.ts) and trimmed to what we actually consult.
//
// Each list is searched in order — the first match wins — so the
// most reliable selector goes first. The redundant trailing entries
// catch UI variants and rotated obfuscated class names.

// Guest-flow name input on the pre-join screen.
export const nameInputSelectors: string[] = [
  'input[type="text"][aria-label="Your name"]',
  'input[placeholder*="name"]',
  'input[placeholder*="Name"]',
];

// "Ask to join" (guest) / "Join now" (signed-in) / "Switch here"
// (same account already in the call).
export const joinButtonSelectors: string[] = [
  'button:has-text("Join now")',
  'button:has-text("Switch here")',
  'button:has-text("Ask to join")',
  'button:has-text("Join meeting")',
  'button:has-text("Join")',
];

// Pre-join mic-off toggle.
export const microphoneOffSelectors: string[] = [
  'button[aria-label*="Turn off microphone"]',
  '[aria-label*="Turn off microphone"]',
];

// Pre-join camera-off toggle.
export const cameraOffSelectors: string[] = [
  'button[aria-label*="Turn off camera"]',
  '[aria-label*="Turn off camera"]',
];

// Definitive "we're inside the meeting" indicators. These elements do
// NOT exist in the lobby, so visibility ⇒ admitted.
export const admittedIndicators: string[] = [
  'button[aria-label*="Leave call"]',
  'button[aria-label*="Leave meeting"]',
  'button[aria-label*="Chat with everyone"]',
  'button[aria-label*="Show everyone"]',
  '[data-participant-id]',
  '[data-self-name]',
  'button[aria-label*="Present now"]',
];

// "Still in the lobby / waiting room" indicators. While ANY of these
// are visible, treat the bot as NOT admitted — lobby toolbar buttons
// can spuriously match the admitted indicators above.
export const waitingRoomIndicators: string[] = [
  'text="Asking to be let in"',
  'text*="Asking to be let in"',
  'text*="You\'ll join the call when someone lets you"',
  'text="Waiting for the host to let you in"',
  'text="You\'re in the waiting room"',
  '[aria-label*="waiting room"]',
];

// Rejection / kicked-out / meeting-doesn't-exist screens.
export const rejectionIndicators: string[] = [
  'text="Meeting not found"',
  'text="You can\'t join this video call"',
  'text="Can\'t join the meeting"',
  'text="Unable to join"',
  'text="Meeting has ended"',
  'text*="meeting has ended"',
  '[role="dialog"]:has-text("Meeting not found")',
  '[role="alertdialog"]:has-text("Meeting not found")',
];

// "Meeting ended / you left" indicators — watched after admission so
// we can shut the session down cleanly.
export const endOfCallIndicators: string[] = [
  'text*="You\'ve left the meeting"',
  'text*="You left the meeting"',
  'text*="removed from the meeting"',
  'text*="meeting ended"',
  'text*="Call ended"',
];

// Leave-call button inside the in-meeting toolbar.
export const leaveButtonSelectors: string[] = [
  'button[aria-label="Leave call"]',
  'button[aria-label*="Leave"]',
];
