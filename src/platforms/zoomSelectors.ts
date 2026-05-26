// ─── Zoom Web Client selectors ───────────────────────────────────
// Selectors used by the join flow. Lifted from Vexa's curated list
// (Vexa-ai/vexa/services/vexa-bot/core/src/platforms/zoom/web/
// selectors.ts), verified against live Zoom Web Client DOM.
//
// Target URL shape: https://app.zoom.us/wc/<MEETING_ID>/join?pwd=...

// ── Pre-join page ──

// Name input. Stable id.
export const nameInputSelector = '#input-for-name';

// Passcode input — only present when the meeting requires a passcode.
export const passcodeInputSelector =
  'input[placeholder*="passcode" i], input[placeholder*="password" i], input[type="password"]';

// Join button. The CSS class includes "disabled" until React enables it.
export const joinButtonSelector = 'button.preview-join-button';

// Preview mic/video toggles. aria-label flips between "Mute"/"Unmute"
// and "Start Video"/"Stop Video" depending on current state.
export const previewMuteSelector = '#preview-audio-control-button';
export const previewVideoSelector = '#preview-video-control-button';

// "Use microphone and camera" permission dialog. Shown up to twice
// (camera+mic, then mic only). We click "Allow" so the bot can
// receive audio; fallback is a dismiss button if Zoom changes the
// label, but skipping permission means no audio capture.
export const permissionAllowSelector = 'button:has-text("Allow")';
export const permissionDismissSelector =
  'button:has-text("Continue without microphone and camera")';

// ── In-meeting indicators ──

// Leave button: the definitive "we are in the meeting" signal.
export const leaveButtonSelector = 'button[aria-label="Leave"]';

// Footer audio button — present once we're in the meeting.
export const audioButtonSelector = 'button.join-audio-container__btn';

// Meeting container, used for a coarse "page loaded" check.
export const meetingAppSelector = '.meeting-app';

// ── Error / waiting-state indicators ──

// When the host hasn't started yet, the page title is "Error - Zoom"
// and the body says "This meeting link is invalid (3,001)".
export const invalidMeetingTitle = 'Error - Zoom';
export const invalidMeetingText = 'This meeting link is invalid';

// Sign-in-required gating — meetings configured for "Only
// authenticated users can join". Matched against the body text.
export const signInRequiredTexts: string[] = [
  'sign in to join this meeting',
  'sign in to join',
  'authentication is required',
  'only authenticated users can join',
  'this meeting requires authentication',
];

// Waiting-room screens — no unique CSS class, only text.
export const waitingRoomTexts: string[] = [
  'Please wait, the meeting host will let you in soon.',
  'Please wait',
  'Waiting for the host to start this meeting',
  'Waiting Room',
  'waiting room',
  "Host has joined. We've let them know you're here",
];

// Meeting-ended / removed-from-meeting modal.
export const endedModalTitleSelector = '.zm-modal-body-title';
export const endedTexts: string[] = [
  'This meeting has been ended by host',
  'removed from the meeting',
  'meeting has ended',
  'Meeting has ended',
  'ended by the host',
  'You have been removed',
];

// "Leave Meeting" confirmation in the leave dialog.
export const leaveConfirmSelector = 'button.leave-meeting-options__btn--danger';
