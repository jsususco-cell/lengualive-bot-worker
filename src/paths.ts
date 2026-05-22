// Where a Google Meet bot writes its on-failure diagnostic screenshot.
// /tmp is writable inside the container; GET /sessions/:id/screenshot
// serves the file back.
export function screenshotPath(sessionId: string): string {
  return `/tmp/lengua-${sessionId}.png`;
}
