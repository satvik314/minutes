// Minutes — offscreen capture document (source; bundled to /offscreen.js).
//
// Everything the MV3 service worker cannot do lives here:
//   - consume the tabCapture stream id + microphone via getUserMedia,
//   - mix both through Web Audio and downsample to 16 kHz PCM16,
//   - keep the tab audible (tabCapture mutes the tab by default),
//   - stream PCM chunks to the Gemini Live API and assemble the transcript.
//
// The transcript is broadcast live to the side panel and persisted to
// chrome.storage.local on a short debounce, so a crash at any point loses at
// most ~1.5 s of text.

import { GoogleGenAI, MediaResolution, Modality } from '@google/genai';

const DEFAULT_MODEL = 'models/gemini-3.5-transcribe-live';
const SAMPLE_RATE = 16000;
const PARAGRAPH_GAP_MS = 8000; // silence long enough to start a new paragraph
const PERSIST_DEBOUNCE_MS = 1500;
const RECONNECT_ATTEMPTS = 3;

const state = {
  running: false,
  stopping: false,
  sessionId: null,
  session: null,
  sessionOpen: false,
  captureCtx: null,
  playbackCtx: null,
  streams: [],
  segments: [],
  lastTextAt: 0,
  breakNext: false,
  sawInputTranscription: false,
  persistTimer: null,
  reconnectsLeft: RECONNECT_ATTEMPTS,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
    return true;
  }
  if (msg.type === 'stop') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
});

function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function reportStatus(status, message) {
  send({ target: 'panel', type: 'status', state: status, message: message || null });
}

function reportError(code, message, fatal) {
  send({
    target: 'bg',
    type: 'offscreen-error',
    sessionId: state.sessionId,
    code,
    message,
    fatal: !!fatal,
  });
}

// ---------------------------------------------------------------------------
// Start / stop

async function start({ sessionId, streamId, wantMic }) {
  if (state.running) throw new Error('Capture already running.');

  const apiKey = self.MINUTES_ENV?.GEMINI_API_KEY;
  if (!apiKey || /PASTE_YOUR/.test(apiKey)) {
    throw new Error('No Gemini API key found. Copy env.example.js to env.js and add your key.');
  }

  state.running = true;
  state.stopping = false;
  state.sessionId = sessionId;
  state.segments = [];
  state.lastTextAt = 0;
  state.breakNext = false;
  state.sawInputTranscription = false;
  state.reconnectsLeft = RECONNECT_ATTEMPTS;

  reportStatus('connecting');

  try {
    // --- Tab audio (the other side of the conversation) ------------------
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    state.streams.push(tabStream);

    // tabCapture silences the tab; route it straight back to the speakers in
    // a context at the device's native rate so the meeting stays audible and
    // unprocessed.
    state.playbackCtx = new AudioContext();
    state.playbackCtx
      .createMediaStreamSource(tabStream)
      .connect(state.playbackCtx.destination);
    if (state.playbackCtx.state === 'suspended') await state.playbackCtx.resume();

    // --- Microphone (this side of the conversation) ----------------------
    let micStream = null;
    if (wantMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        state.streams.push(micStream);
      } catch (e) {
        // Mic denied or unavailable — carry on with tab audio only.
        reportStatus('mic-unavailable');
      }
    }

    // --- Mix + downsample to 16 kHz PCM16 --------------------------------
    // A 16 kHz context makes Chrome do the resampling for us; the worklet
    // only has to convert float samples to Int16.
    state.captureCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (state.captureCtx.state === 'suspended') await state.captureCtx.resume();
    await state.captureCtx.audioWorklet.addModule('pcm-worklet.js');

    const mixBus = state.captureCtx.createGain();
    mixBus.gain.value = 0.9; // headroom so tab + mic summing doesn't clip
    state.captureCtx.createMediaStreamSource(tabStream).connect(mixBus);
    if (micStream) {
      state.captureCtx.createMediaStreamSource(micStream).connect(mixBus);
    }

    const worklet = new AudioWorkletNode(state.captureCtx, 'pcm16');
    mixBus.connect(worklet);
    worklet.port.onmessage = (ev) => {
      if (state.sessionOpen && !state.stopping) {
        sendAudioChunk(ev.data);
      }
    };

    // --- Gemini Live session ---------------------------------------------
    await connectGemini(apiKey);
    reportStatus('recording');
  } catch (err) {
    await teardownAudio();
    state.running = false;
    throw err;
  }
}

async function stop() {
  if (!state.running || state.stopping) return;
  state.stopping = true;
  reportStatus('finalizing');

  // Let the API flush transcription for the last words before we hang up.
  try {
    state.session?.sendRealtimeInput({ audioStreamEnd: true });
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 1800));

  try {
    state.session?.close();
  } catch (e) {}
  state.session = null;
  state.sessionOpen = false;

  await teardownAudio();
  await persistSegments(); // final, un-debounced flush
  state.running = false;
  send({ target: 'bg', type: 'offscreen-stopped', sessionId: state.sessionId });
}

async function teardownAudio() {
  for (const stream of state.streams) {
    for (const track of stream.getTracks()) track.stop();
  }
  state.streams = [];
  for (const key of ['captureCtx', 'playbackCtx']) {
    try {
      await state[key]?.close();
    } catch (e) {}
    state[key] = null;
  }
}

// ---------------------------------------------------------------------------
// Gemini Live

async function connectGemini(apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const model = self.MINUTES_ENV?.MODEL || DEFAULT_MODEL;

  state.session = await ai.live.connect({
    model,
    // Mirrors the AI Studio reference config for this model. The transcript
    // arrives as modelTurn text parts (handleServerMessage also accepts the
    // inputTranscription channel, should the model use it).
    config: {
      responseModalities: [Modality.TEXT],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      // Meetings run long — let the server compress old context instead of
      // killing the session when the window fills.
      contextWindowCompression: {
        triggerTokens: '104857',
        slidingWindow: { targetTokens: '52428' },
      },
    },
    callbacks: {
      onopen: () => {
        state.sessionOpen = true;
      },
      onmessage: handleServerMessage,
      onerror: (e) => {
        console.error('Live session error', e);
      },
      onclose: (e) => {
        state.sessionOpen = false;
        if (state.running && !state.stopping) {
          attemptReconnect(apiKey, e);
        }
      },
    },
  });
}

function attemptReconnect(apiKey, closeEvent) {
  if (state.reconnectsLeft <= 0) {
    reportError(
      'connection-lost',
      `Lost the transcription connection (${closeEvent?.reason || 'network error'}). The transcript so far has been preserved.`,
      true
    );
    return;
  }
  state.reconnectsLeft--;
  const delay = (RECONNECT_ATTEMPTS - state.reconnectsLeft) * 1500;
  reportStatus('reconnecting');
  setTimeout(async () => {
    if (!state.running || state.stopping) return;
    try {
      await connectGemini(apiKey);
      state.breakNext = true; // seam in the audio → start a fresh paragraph
      reportStatus('recording');
    } catch (err) {
      attemptReconnect(apiKey, { reason: String(err?.message || err) });
    }
  }, delay);
}

function sendAudioChunk(arrayBuffer) {
  try {
    state.session.sendRealtimeInput({
      audio: {
        data: base64FromArrayBuffer(arrayBuffer),
        mimeType: `audio/pcm;rate=${SAMPLE_RATE}`,
      },
    });
  } catch (e) {
    // Session is mid-reconnect; drop the chunk.
  }
}

function handleServerMessage(message) {
  const sc = message?.serverContent;
  if (!sc) return;

  if (sc.inputTranscription?.text) {
    state.sawInputTranscription = true;
    appendText(sc.inputTranscription.text);
  } else if (sc.interimInputTranscription?.text) {
    state.sawInputTranscription = true;
    send({
      target: 'panel',
      type: 'interim',
      sessionId: state.sessionId,
      text: sc.interimInputTranscription.text,
    });
  } else if (!state.sawInputTranscription && sc.modelTurn?.parts) {
    // Dedicated transcription models may emit the transcript as plain text
    // parts instead of the inputTranscription channel — accept either, but
    // never both.
    for (const part of sc.modelTurn.parts) {
      if (part.text) appendText(part.text);
    }
  }

  if (sc.turnComplete) state.breakNext = true;
}

// ---------------------------------------------------------------------------
// Transcript assembly

function appendText(text) {
  if (!text) return;
  const now = Date.now();
  const gap = now - state.lastTextAt;
  const current = state.segments[state.segments.length - 1];

  const needsNew =
    !current || state.breakNext || gap > PARAGRAPH_GAP_MS || current.text.length > 900;

  if (needsNew) {
    state.segments.push({ at: now, text: text.replace(/^\s+/, '') });
    state.breakNext = false;
  } else {
    current.text = joinFragments(current.text, text);
  }
  state.lastTextAt = now;

  const index = state.segments.length - 1;
  send({
    target: 'panel',
    type: 'transcript-update',
    sessionId: state.sessionId,
    index,
    segment: state.segments[index],
  });
  schedulePersist();
}

// Transcription fragments arrive with inconsistent spacing; join them
// without doubling spaces or gluing words together.
function joinFragments(a, b) {
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  if (/[([{'"“‘]$/.test(a) || /^[)\]},.;:!?…'"”’]/.test(b)) return a + b;
  return a + ' ' + b;
}

function schedulePersist() {
  if (state.persistTimer) return;
  state.persistTimer = setTimeout(async () => {
    state.persistTimer = null;
    await persistSegments();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistSegments() {
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }
  const { meetings } = await chrome.storage.local.get('meetings');
  const rec = meetings?.[state.sessionId];
  if (!rec) return;
  rec.segments = state.segments;
  rec.lastActivityAt = state.lastTextAt || rec.lastActivityAt;
  await chrome.storage.local.set({ meetings });
}

// ---------------------------------------------------------------------------

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
