# Minutes

A personal meeting notebook, as a Chrome extension. Open any browser-based
meeting (Google Meet, Zoom web, …), press the wax seal, and Minutes listens to
both sides of the conversation — the tab's audio and your microphone — and
writes a live transcript onto a ruled paper page in the side panel. When you
stop, the meeting is filed as a Markdown transcript in
`Downloads/Meetings/YYYY-MM-DD_HH-MM_tab-title.md`, and kept in the notebook's
library.

## Setup

1. `cp env.example.js env.js` and paste your Gemini API key
   (from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)) into it.
   `env.js` is gitignored — the key stays on your machine.
2. Open `chrome://extensions`, enable **Developer mode** (top right), click
   **Load unpacked**, and select this folder.
3. Open your meeting tab, click the Minutes icon to open the side panel, and
   press the seal. Allow microphone access the first time so your side of the
   conversation is transcribed too.

Notes:

- Transcription streams to the Gemini Live API
  (model `gemini-3.5-transcribe-live`; override via `MODEL` in `env.js`).
- Saving is silent as long as Chrome's *"Ask where to save each file before
  downloading"* setting is off (the default).
- If Chrome or the session dies mid-meeting, the partial transcript is
  preserved and archived automatically the next time the extension wakes.

## How it's put together

MV3 service workers cannot touch media streams, so the extension splits into
three cooperating contexts:

| File | Context | Role |
| --- | --- | --- |
| `background.js` | service worker | mints the tabCapture stream id, owns the meeting archive in `chrome.storage.local`, saves transcripts via `chrome.downloads`, recovers crashed sessions |
| `offscreen.html` + `src/offscreen.js` | offscreen document | captures tab + mic audio, keeps the tab audible, mixes and downsamples to 16 kHz PCM16 in an `AudioWorklet`, streams chunks to `ai.live.connect` / `sendRealtimeInput`, assembles timestamped paragraphs |
| `sidepanel.html/css/js` | side panel | the notebook: live page, library of past meetings, transcript reader |

`offscreen.js` (at the repo root) is the committed esbuild bundle of
`src/offscreen.js` with the `@google/genai` SDK, so the extension loads
unpacked with no build step. To rebuild after editing the source:

```sh
npm install
npm run build     # bundles src/offscreen.js → offscreen.js
npm run icons     # regenerates the wax-seal icons
```
