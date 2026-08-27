// Minutes — background service worker.
//
// The service worker never touches audio (MV3 forbids it). It orchestrates:
//   - handing a tabCapture stream id to the offscreen capture document,
//   - the meeting archive in chrome.storage.local,
//   - saving finished transcripts to Downloads/Meetings via chrome.downloads,
//   - recovering sessions that died mid-meeting (browser crash, forced quit).

const OFFSCREEN_URL = 'offscreen.html';

// Runs on every service-worker boot: any meeting still marked "recording"
// with no live offscreen document behind it died mid-session. Preserve and
// archive whatever was transcribed before the crash. Also re-syncs the
// toolbar badge, the only always-visible sign that Minutes is listening
// while the popup is closed.
sweepInterruptedSessions();

function setRecordingBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' }).catch(() => {});
  if (on) {
    chrome.action.setBadgeBackgroundColor({ color: '#a92e23' }).catch(() => {});
    chrome.action.setBadgeTextColor?.({ color: '#ffffff' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Storage

async function getMeetings() {
  const { meetings } = await chrome.storage.local.get('meetings');
  return meetings || {};
}

async function putMeeting(record) {
  const meetings = await getMeetings();
  meetings[record.id] = record;
  await chrome.storage.local.set({ meetings });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification:
      'Captures tab and microphone audio and streams it to the Gemini Live API for transcription. Audio capture cannot run in a service worker.',
  });
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'bg') return;

  const handlers = {
    'start': () => startRecording(msg),
    'stop': () => requestStop(),
    'get-state': () => getState(),
    'save-again': () => saveAgain(msg.id),
    'offscreen-stopped': () => finalizeSession(msg.sessionId, { interrupted: false }),
    'offscreen-error': () => handleOffscreenError(msg),
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  handler().then(
    (result) => sendResponse({ ok: true, ...(result || {}) }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // async response
});

function broadcast(message) {
  // Fire-and-forget to the side panel; it may be closed, which is fine.
  chrome.runtime.sendMessage({ target: 'panel', ...message }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Recording lifecycle

async function activeRecording() {
  const meetings = await getMeetings();
  return Object.values(meetings).find((m) => m.status === 'recording') || null;
}

async function startRecording(msg) {
  const existing = await activeRecording();
  if (existing && (await hasOffscreenDocument())) {
    throw new Error('Already recording.');
  }
  if (existing) {
    // Stale record from a dead session — archive it before starting fresh.
    await finalizeSession(existing.id, { interrupted: true });
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) {
    throw new Error('Switch to your meeting tab first — Minutes can only listen to normal web pages.');
  }

  // The user gesture from the side panel button carries across sendMessage,
  // so the service worker may mint a capture stream id for the active tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const record = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: tab.title || 'Untitled meeting',
    url: tab.url,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    status: 'recording',
    segments: [],
  };
  await putMeeting(record);

  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    sessionId: record.id,
    streamId,
    wantMic: msg.wantMic !== false,
  });
  if (!res?.ok) {
    const meetings = await getMeetings();
    delete meetings[record.id];
    await chrome.storage.local.set({ meetings });
    await closeOffscreenDocument();
    throw new Error(res?.error || 'Could not start audio capture.');
  }
  setRecordingBadge(true);
  return { sessionId: record.id, startedAt: record.startedAt };
}

async function requestStop() {
  if (!(await hasOffscreenDocument())) {
    // Nothing live — archive any stale record.
    const rec = await activeRecording();
    if (rec) await finalizeSession(rec.id, { interrupted: true });
    return;
  }
  // The offscreen document flushes trailing transcription, then reports
  // back with 'offscreen-stopped', which triggers finalizeSession.
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
}

async function finalizeSession(sessionId, { interrupted }) {
  const meetings = await getMeetings();
  const rec = meetings[sessionId];
  if (!rec || rec.status !== 'recording') {
    await closeOffscreenDocument();
    return;
  }

  rec.endedAt = interrupted ? rec.lastActivityAt || rec.startedAt : Date.now();
  rec.durationMs = Math.max(0, rec.endedAt - rec.startedAt);
  rec.status = interrupted ? 'interrupted' : 'completed';

  if (rec.segments.length > 0) {
    try {
      rec.savedAs = await downloadTranscript(rec);
    } catch (e) {
      rec.saveError = String(e?.message || e);
    }
  }

  meetings[sessionId] = rec;
  await chrome.storage.local.set({ meetings });
  await closeOffscreenDocument();
  setRecordingBadge(false);
  broadcast({ type: 'finalized', sessionId, savedAs: rec.savedAs || null, interrupted });
}

async function handleOffscreenError(msg) {
  broadcast({ type: 'status', state: 'error', code: msg.code, message: msg.message });
  if (!msg.fatal) return;

  const meetings = await getMeetings();
  const rec = meetings[msg.sessionId];
  if (rec && rec.status === 'recording') {
    if (rec.segments.length === 0) {
      // Died before a single word landed — nothing worth archiving.
      delete meetings[msg.sessionId];
      await chrome.storage.local.set({ meetings });
      await closeOffscreenDocument();
      setRecordingBadge(false);
    } else {
      await finalizeSession(msg.sessionId, { interrupted: true });
    }
  } else {
    await closeOffscreenDocument();
    setRecordingBadge(false);
  }
}

async function getState() {
  const rec = await activeRecording();
  if (rec && (await hasOffscreenDocument())) {
    return { recording: true, session: rec };
  }
  if (rec) {
    // Crash leftover discovered while the panel was asking — archive it.
    await finalizeSession(rec.id, { interrupted: true });
  }
  return { recording: false };
}

async function sweepInterruptedSessions() {
  try {
    const rec = await activeRecording();
    if (rec && !(await hasOffscreenDocument())) {
      await finalizeSession(rec.id, { interrupted: true });
    } else {
      setRecordingBadge(!!rec);
    }
  } catch (e) {
    // Sweep is best-effort; never block worker boot.
  }
}

// ---------------------------------------------------------------------------
// Archiving — Markdown into Downloads/Meetings/

async function saveAgain(id) {
  const meetings = await getMeetings();
  const rec = meetings[id];
  if (!rec) throw new Error('Meeting not found.');
  if (!rec.segments?.length) throw new Error('This meeting has no transcript.');
  const savedAs = await downloadTranscript(rec);
  rec.savedAs = savedAs;
  delete rec.saveError;
  await chrome.storage.local.set({ meetings });
  return { savedAs };
}

async function downloadTranscript(rec) {
  const filename = `Meetings/${transcriptFilename(rec)}`;
  const markdown = buildMarkdown(rec);
  const url = 'data:text/markdown;base64,' + base64(new TextEncoder().encode(markdown));
  await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return filename;
}

function transcriptFilename(rec) {
  const d = new Date(rec.startedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  const slug = (rec.title || 'meeting')
    .replace(/[<>:"/\\|?* -]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'meeting';
  return `${stamp}_${slug}.md`;
}

function buildMarkdown(rec) {
  const start = new Date(rec.startedAt);
  const end = new Date(rec.endedAt || rec.lastActivityAt || rec.startedAt);
  const lines = [
    `# ${rec.title}`,
    '',
    `- **Date:** ${start.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
    `- **Time:** ${clock(start)} – ${clock(end)}`,
    `- **Duration:** ${formatDuration(rec.durationMs ?? end - start)}`,
    `- **Meeting:** ${rec.url}`,
    `- **Tab:** ${rec.title}`,
  ];
  if (rec.status === 'interrupted') {
    lines.push('- **Note:** session ended unexpectedly — this is a partial transcript.');
  }
  lines.push('', '---', '');
  for (const seg of rec.segments) {
    lines.push(`**${clock(new Date(seg.at))}**  ${seg.text.trim()}`, '');
  }
  return lines.join('\n');
}

function clock(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

function base64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
