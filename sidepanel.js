// Minutes — side panel. Rendering and user intent only; audio and the Gemini
// session live in the offscreen document, orchestration in the service worker.

const $ = (id) => document.getElementById(id);
const els = {
  navToggle: $('navToggle'),
  todayLine: $('todayLine'),
  recIndicator: $('recIndicator'),
  recWord: $('recWord'),
  elapsed: $('elapsed'),
  scroller: $('scroller'),
  viewLive: $('viewLive'),
  viewLibrary: $('viewLibrary'),
  viewReader: $('viewReader'),
  emptyLive: $('emptyLive'),
  transcript: $('transcript'),
  interim: $('interim'),
  stack: $('stack'),
  emptyLibrary: $('emptyLibrary'),
  readerBack: $('readerBack'),
  readerTitle: $('readerTitle'),
  readerMeta: $('readerMeta'),
  readerSave: $('readerSave'),
  readerBody: $('readerBody'),
  note: $('note'),
  seal: $('seal'),
  sealLabel: $('sealLabel'),
  deck: $('deck'),
};

const ui = {
  view: 'live', // live | library | reader
  recording: false,
  finalizing: false,
  sessionId: null,
  startedAt: null,
  renderedText: [], // text already inked per paragraph, for delta animation
  timer: null,
  noteTimer: null,
  readerId: null,
};

const hasApiKey = () => {
  const key = self.MINUTES_ENV?.GEMINI_API_KEY;
  return !!key && !/PASTE_YOUR/.test(key);
};

// ---------------------------------------------------------------------------
// Boot

init();

async function init() {
  els.todayLine.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  els.seal.addEventListener('click', onSealPressed);
  els.navToggle.addEventListener('click', () => {
    showView(ui.view === 'live' ? 'library' : 'live');
  });
  els.readerBack.addEventListener('click', () => showView('library'));
  els.readerSave.addEventListener('click', () => saveAgain(ui.readerId));

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.meetings && ui.view === 'library') renderLibrary();
  });

  if (!hasApiKey()) {
    showNote('To begin: copy env.example.js to env.js, add your Gemini API key, and reload the extension.', 'error', 0);
  }

  const state = await send({ target: 'bg', type: 'get-state' });
  if (state?.ok && state.recording) {
    resumeLiveView(state.session);
  }
  renderLibrary();
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

// ---------------------------------------------------------------------------
// Views

function showView(view) {
  ui.view = view;
  els.viewLive.classList.toggle('hidden', view !== 'live');
  els.viewLibrary.classList.toggle('hidden', view !== 'library');
  els.viewReader.classList.toggle('hidden', view !== 'reader');
  els.deck.classList.toggle('hidden', view !== 'live');
  els.navToggle.innerHTML = view === 'live' ? 'Notebook &rarr;' : '&larr; Today';
  if (view === 'library') renderLibrary();
  els.scroller.scrollTop = 0;
  if (view === 'live' && ui.recording) scrollToBottom(true);
}

// ---------------------------------------------------------------------------
// Recording control

async function onSealPressed() {
  if (ui.finalizing) return;
  if (ui.recording) {
    ui.finalizing = true;
    els.seal.disabled = true;
    els.sealLabel.textContent = 'sealing the record…';
    els.recWord.textContent = 'Finalizing';
    await send({ target: 'bg', type: 'stop' });
    return;
  }

  if (!hasApiKey()) {
    showNote('No Gemini API key yet — copy env.example.js to env.js and add yours, then reload the extension.', 'error', 0);
    return;
  }

  els.seal.disabled = true;
  els.sealLabel.textContent = 'listening for the room…';

  // Ask for the microphone from the panel: offscreen documents cannot show
  // permission prompts, but a grant here covers the whole extension. Only
  // prompt when undecided — a long-lived prompt would expire the user
  // gesture that tabCapture needs.
  let wantMic = true;
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'denied') {
      wantMic = false;
    } else if (perm.state === 'prompt') {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {
    wantMic = false;
  }

  const res = await send({ target: 'bg', type: 'start', wantMic });
  if (!res?.ok) {
    els.seal.disabled = false;
    els.sealLabel.textContent = 'press to record';
    const raw = res?.error || 'Could not start recording.';
    const friendly = /invoked|active tab|user gesture/i.test(raw)
      ? 'Chrome wants a fresh invitation — click the Minutes toolbar icon on your meeting tab, then press the seal again.'
      : raw;
    showNote(friendly, 'error', 9000);
    return;
  }
  if (!wantMic) {
    showNote('Microphone unavailable — taking down the tab’s audio only.', 'info', 7000);
  }
  enterRecording(res.sessionId, res.startedAt, []);
}

function enterRecording(sessionId, startedAt, segments) {
  ui.recording = true;
  ui.finalizing = false;
  ui.sessionId = sessionId;
  ui.startedAt = startedAt;
  ui.renderedText = [];

  els.transcript.replaceChildren();
  els.interim.classList.add('hidden');
  els.emptyLive.classList.add('hidden');
  segments.forEach((seg, i) => renderSegment(i, seg, { animate: false }));

  els.seal.disabled = false;
  els.seal.classList.add('recording');
  els.seal.setAttribute('aria-label', 'Stop recording');
  els.sealLabel.textContent = 'press to stop';
  els.recWord.textContent = 'Recording';
  els.recIndicator.classList.remove('hidden');

  clearInterval(ui.timer);
  ui.timer = setInterval(tickElapsed, 1000);
  tickElapsed();

  showView('live');
  scrollToBottom(true);
}

function exitRecording({ savedAs, interrupted }) {
  ui.recording = false;
  ui.finalizing = false;
  ui.sessionId = null;
  clearInterval(ui.timer);
  ui.timer = null;

  els.seal.disabled = false;
  els.seal.classList.remove('recording');
  els.seal.setAttribute('aria-label', 'Start recording');
  els.sealLabel.textContent = 'press to record';
  els.recIndicator.classList.add('hidden');
  els.interim.classList.add('hidden');

  if (savedAs) {
    showNote(`Filed away — Downloads / ${savedAs.replace('/', ' / ')}`, 'info', 9000);
  } else if (interrupted) {
    showNote('That session ended unexpectedly; the partial transcript is kept in the notebook.', 'info', 9000);
  }
  renderLibrary();
}

async function resumeLiveView(record) {
  // Panel was re-opened mid-recording: repaint what has been written so far.
  enterRecording(record.id, record.startedAt, record.segments || []);
}

function tickElapsed() {
  const s = Math.max(0, Math.floor((Date.now() - ui.startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  els.elapsed.textContent = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------------------
// Messages from the offscreen document / service worker

function onMessage(msg) {
  if (msg?.target !== 'panel') return;

  if (msg.type === 'transcript-update' && msg.sessionId === ui.sessionId) {
    els.interim.classList.add('hidden');
    renderSegment(msg.index, msg.segment, { animate: true });
    return;
  }

  if (msg.type === 'interim' && msg.sessionId === ui.sessionId) {
    els.interim.textContent = msg.text;
    els.interim.classList.remove('hidden');
    scrollToBottom();
    return;
  }

  if (msg.type === 'status') {
    onStatus(msg);
    return;
  }

  if (msg.type === 'finalized') {
    exitRecording(msg);
  }
}

function onStatus(msg) {
  switch (msg.state) {
    case 'connecting':
      els.recWord.textContent = 'Connecting';
      break;
    case 'recording':
      els.recWord.textContent = 'Recording';
      break;
    case 'reconnecting':
      els.recWord.textContent = 'Reconnecting';
      showNote('The line dropped for a moment — reconnecting…', 'info', 5000);
      break;
    case 'mic-unavailable':
      showNote('Microphone unavailable — taking down the tab’s audio only.', 'info', 7000);
      break;
    case 'finalizing':
      els.recWord.textContent = 'Finalizing';
      break;
    case 'error':
      showNote(msg.message || 'Something went wrong.', 'error', 0);
      break;
  }
}

// ---------------------------------------------------------------------------
// Transcript rendering — new ink fades onto the page

function renderSegment(index, segment, { animate }) {
  els.emptyLive.classList.add('hidden');
  let para = els.transcript.children[index];

  if (!para) {
    para = document.createElement('div');
    para.className = 'para';
    if (!animate) para.style.animation = 'none';

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = clock(segment.at);

    const text = document.createElement('p');
    text.className = 'text';

    para.append(stamp, text);
    els.transcript.appendChild(para);
    ui.renderedText[index] = '';
  }

  const textEl = para.querySelector('.text');
  const prev = ui.renderedText[index] || '';

  if (animate && segment.text.startsWith(prev) && prev.length > 0) {
    const span = document.createElement('span');
    span.className = 'ink';
    span.textContent = segment.text.slice(prev.length);
    textEl.appendChild(span);
  } else {
    textEl.textContent = segment.text;
  }
  ui.renderedText[index] = segment.text;

  scrollToBottom();
}

function scrollToBottom(force) {
  const el = els.scroller;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Library — a stack of dated pages

async function getMeetings() {
  const { meetings } = await chrome.storage.local.get('meetings');
  return meetings || {};
}

async function renderLibrary() {
  const meetings = Object.values(await getMeetings())
    .filter((m) => m.status !== 'recording')
    .sort((a, b) => b.startedAt - a.startedAt);

  els.emptyLibrary.classList.toggle('hidden', meetings.length > 0);
  els.stack.replaceChildren(
    ...meetings.map((m) => {
      const sheet = document.createElement('article');
      sheet.className = 'sheet';

      const title = document.createElement('h3');
      title.textContent = m.title;
      title.title = m.title;

      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.append(metaLine(m));

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        inkLink('Open transcript', () => openReader(m.id)),
        inkLink('Save again', () => saveAgain(m.id))
      );

      sheet.append(title, meta, actions);
      return sheet;
    })
  );
}

function metaLine(m) {
  const frag = document.createDocumentFragment();
  const d = new Date(m.startedAt);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  frag.append(`${date} · ${clock(m.startedAt)} · ${duration(m.durationMs)}`);
  if (m.status === 'interrupted') {
    const badge = document.createElement('span');
    badge.className = 'partial';
    badge.textContent = ' · partial';
    frag.append(badge);
  }
  return frag;
}

function inkLink(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ink-link';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function saveAgain(id) {
  if (!id) return;
  const res = await send({ target: 'bg', type: 'save-again', id });
  if (res?.ok) {
    showNote(`Filed away — Downloads / ${res.savedAs.replace('/', ' / ')}`, 'info', 8000);
  } else {
    showNote(res?.error || 'Could not save the transcript.', 'error', 8000);
  }
}

// ---------------------------------------------------------------------------
// Reader

async function openReader(id) {
  const meetings = await getMeetings();
  const m = meetings[id];
  if (!m) return;
  ui.readerId = id;

  els.readerTitle.textContent = m.title;
  const d = new Date(m.startedAt);
  els.readerMeta.textContent =
    d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
    ` · ${clock(m.startedAt)} · ${duration(m.durationMs)}` +
    (m.status === 'interrupted' ? ' · partial' : '');

  els.readerBody.replaceChildren(
    ...(m.segments || []).map((seg) => {
      const para = document.createElement('div');
      para.className = 'para';
      para.style.animation = 'none';
      const stamp = document.createElement('span');
      stamp.className = 'stamp';
      stamp.textContent = clock(seg.at);
      const text = document.createElement('p');
      text.className = 'text';
      text.textContent = seg.text;
      para.append(stamp, text);
      return para;
    })
  );
  showView('reader');
}

// ---------------------------------------------------------------------------
// Small helpers

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function duration(ms) {
  if (!ms) return '—';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function showNote(text, kind, ms) {
  clearTimeout(ui.noteTimer);
  els.note.textContent = text;
  els.note.classList.toggle('error', kind === 'error');
  els.note.classList.remove('hidden');
  if (ms) {
    ui.noteTimer = setTimeout(() => els.note.classList.add('hidden'), ms);
  }
}
