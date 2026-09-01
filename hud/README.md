# hud/

**Owner:** Demo HUD — the extension popup that makes one pipeline step visible
for judges. Opens from the extension icon (`manifest.json` →
`action.default_popup`).

## Responsibility

- Shows the six boxes by their locked names: Capture Layer, Local Privacy
  Vision Engine, Sanitizer, Policy Gate, Remote Agent, Local Executor.
- Renders, per step: raw vs sanitized thumbnail, detection chips (PAN, EMAIL,
  FACE, …), gate badge (ALLOW / HUMAN / BLOCK), last action (`click #submit`).
- **Until #15 (orchestrator) lands**, the "Play fixture" button paints the
  whole run from `fixtures/` (synthetic data only). It also listens for
  `hud.step` messages from the service worker so live events drop into the
  same panel once #15 emits them.

## Privacy rules this panel obeys

- No real PII is ever rendered — playback shows placeholders (`EMAIL_1`,
  `PAN_1`, …) and non-sensitive labels only.
- Thumbnails are canvas wireframes drawn from fixture bounding boxes; no
  screenshot is decoded, persisted, or written to disk — screenshots stay in
  memory in the background, per CONTRACT.md.

## Files

- `index.html` — popup markup
- `hud.css` — styles
- `hud.js` — fixture playback + live `hud.step` listener
