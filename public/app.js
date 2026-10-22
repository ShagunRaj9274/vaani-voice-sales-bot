(() => {
  'use strict';

  /* ---------- helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmtDur = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  const fmtDate = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

  const LANGS = {
    en: { speech: 'en-IN', name: 'English' },
    hi: { speech: 'hi-IN', name: 'Hindi' },
    te: { speech: 'te-IN', name: 'Telugu' },
  };

  /* Demo products (fictional) so the bot can be shown end to end. Everything is editable in the UI. */
  const PRESETS = {
    flowdesk: {
      label: 'FlowDesk – customer support helpdesk',
      company: 'Sankar Group',
      name: 'FlowDesk',
      description: 'A helpdesk that puts email, WhatsApp and website chat into one shared inbox so support teams answer faster.',
      features: 'Shared inbox for email, WhatsApp and chat\nAI suggested replies\nAuto-assignment and SLA timers\nDaily reports on response and resolution time\nIntegrations with Slack, Shopify and Zoho',
      pricing: 'Starter plan is 999 rupees per agent per month. Growth plan is 1999 rupees per agent per month. Billed yearly.',
      offer: '14-day free trial with no card, plus a 20-minute guided demo.',
      audience: 'Support teams of 5 to 200 agents in e-commerce and service businesses.',
    },
    ledgerlite: {
      label: 'LedgerLite – GST accounting for small business',
      company: 'Sankar Group',
      name: 'LedgerLite',
      description: 'Simple accounting software for small businesses that handles GST invoices, stock and bank reconciliation.',
      features: 'GST-ready invoices and e-way bills\nAutomatic bank reconciliation\nInventory tracking\nAccountant access without sharing passwords\nMobile app for invoices on the go',
      pricing: 'Basic is 499 rupees per month. Pro, with inventory and multiple users, is 1299 rupees per month. Pay yearly and get two months free.',
      offer: 'Free 30-day trial and free data import from Excel or Tally.',
      audience: 'Shop owners, traders and small service firms with 1 to 20 employees.',
    },
    classnest: {
      label: 'ClassNest – school and coaching management',
      company: 'Sankar Group',
      name: 'ClassNest',
      description: 'School and coaching institute software for attendance, fee collection, timetables and parent communication.',
      features: 'Attendance by app or QR\nFee collection with UPI and automatic reminders\nTimetable and exam management\nParent app with notices and results\nOnline class links',
      pricing: '25 rupees per student per month, minimum 100 students. Setup and data migration are free.',
      offer: 'A 30-minute demo for the principal or director, then a free 1-month pilot.',
      audience: 'Schools and coaching institutes with 100 to 3000 students.',
    },
    custom: {
      label: 'Custom product (fill in details)',
      company: '', name: '', description: '', features: '', pricing: '', offer: '', audience: '',
    },
  };

  /* ---------- storage (IndexedDB: calls + recordings) ---------- */
  let dbPromise;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open('vaani-calls', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('calls')) d.createObjectStore('calls', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return openDb().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const dbPutCall = (c) => tx('calls', 'readwrite', (s) => s.put(c));
  const dbPutAudio = (id, blob) => tx('audio', 'readwrite', (s) => s.put(blob, id));
  const dbGetAudio = (id) => tx('audio', 'readonly', (s) => s.get(id));
  const dbAllCalls = () => tx('calls', 'readonly', (s) => s.getAll());
  const dbDelete = (id) => openDb().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(['calls', 'audio'], 'readwrite');
    t.objectStore('calls').delete(id);
    t.objectStore('audio').delete(id);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  }));

  /* ---------- elements ---------- */
  const presetSel = $('#preset');
  const langSel = $('#lang');
  const fields = {
    name: $('#fProduct'), company: $('#fCompany'), description: $('#fDesc'), features: $('#fFeatures'),
    pricing: $('#fPricing'), offer: $('#fOffer'), audience: $('#fAudience'),
  };
  const agentInput = $('#fAgent');
  const consent = $('#consent');
  const startBtn = $('#startBtn');
  const endBtn = $('#endBtn');
  const statusText = $('#statusText');
  const callbar = $('#callbar');
  const timerEl = $('#timer');
  const meterEl = $('#meter');
  const chat = $('#chat');
  const chatEmpty = $('#chatEmpty');
  const callChip = $('#callChip');
  const typeForm = $('#typeForm');
  const typeInput = $('#typeInput');
  const typeSend = $('#typeSend');
  const resultEl = $('#result');
  const errorBanner = $('#errorBanner');
  const configEls = [presetSel, langSel, agentInput, ...Object.values(fields)];

  /* ---------- call state ---------- */
  const SILENCE_MS = 15000;
  let active = false;
  let phase = 'idle';
  let call = null;
  let apiHistory = [];
  let customerTurns = 0;
  let startedAt = 0;
  let timerId = null;
  let turnId = 0;
  let silenceTimer = null;
  let silenceCount = 0;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let meterRaf = 0;
  let rec = null;
  let recErrors = 0;
  let recBlocked = false;
  let interimEl = null;
  let speechCancel = null;
  let retryFn = null;

  /* ---------- UI plumbing ---------- */
  const PHASE_TEXT = {
    idle: 'Ready to start',
    connecting: 'Connecting…',
    thinking: 'Bot is thinking…',
    speaking: 'Bot is speaking',
    listening: 'Listening to you',
    processing: 'Call ended. Analysing the conversation…',
    ended: 'Call ended',
  };

  function setPhase(p) {
    phase = p;
    callbar.dataset.phase = p;
    let text = PHASE_TEXT[p] || p;
    if (p === 'listening' && (!SR || recBlocked)) text = 'Waiting for your typed reply';
    statusText.textContent = text;
    updateControls();
  }

  function updateControls() {
    const inCall = active;
    startBtn.disabled = inCall || phase === 'processing' || !consent.checked;
    endBtn.disabled = !inCall;
    configEls.forEach((n) => { n.disabled = inCall || phase === 'processing'; });
    consent.disabled = inCall || phase === 'processing';
    typeInput.disabled = !inCall;
    typeSend.disabled = !inCall;
  }

  function showError(msg, retry) {
    errorBanner.replaceChildren(document.createTextNode(msg));
    retryFn = retry || null;
    if (retry) {
      const b = el('button', 'retry', 'Try again');
      b.type = 'button';
      b.addEventListener('click', () => { const f = retryFn; hideError(); if (f) f(); });
      errorBanner.append(b);
    }
    errorBanner.hidden = false;
  }
  function hideError() { errorBanner.hidden = true; errorBanner.replaceChildren(); retryFn = null; }

  function scrollChat() { chat.scrollTo({ top: chat.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' }); }

  function addMessage(role, text) {
    if (chatEmpty) chatEmpty.hidden = true;
    const wrap = el('div', 'msg ' + role);
    if (role !== 'system') wrap.append(el('div', 'who', role === 'bot' ? botName() : 'You'));
    wrap.append(el('div', 'bubble', text));
    chat.append(wrap);
    scrollChat();
    return wrap;
  }
  const botName = () => (agentInput.value.trim() || 'Aisha');

  function showInterim(text) {
    if (!text) return;
    if (!interimEl) {
      if (chatEmpty) chatEmpty.hidden = true;
      interimEl = el('div', 'msg customer interim');
      interimEl.append(el('div', 'who', 'You (speaking)'), el('div', 'bubble', text));
      chat.append(interimEl);
    } else {
      $('.bubble', interimEl).textContent = text;
    }
    scrollChat();
  }
  function removeInterim() { if (interimEl) { interimEl.remove(); interimEl = null; } }

  let thinkingEl = null;
  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = el('div', 'msg bot thinking');
    thinkingEl.append(el('div', 'who', botName()), el('div', 'bubble', '…'));
    chat.append(thinkingEl);
    scrollChat();
  }
  function hideThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

  /* ---------- product form ---------- */
  function fillPreset(key) {
    const p = PRESETS[key];
    Object.keys(fields).forEach((k) => { fields[k].value = p[k]; });
    if (key === 'custom') { try { const saved = JSON.parse(localStorage.getItem('vaani-custom') || 'null'); if (saved) Object.keys(fields).forEach((k) => { fields[k].value = saved[k] || ''; }); } catch { /* ignore */ } }
    const open = key === 'custom';
    $('.product-details').open = open || $('.product-details').open;
  }
  function readProduct() {
    const p = {};
    Object.keys(fields).forEach((k) => { p[k] = fields[k].value.trim(); });
    return p;
  }
  Object.entries(PRESETS).forEach(([k, v]) => { const o = el('option', '', v.label); o.value = k; presetSel.append(o); });
  presetSel.addEventListener('change', () => fillPreset(presetSel.value));
  Object.values(fields).forEach((f) => f.addEventListener('input', () => {
    if (presetSel.value === 'custom') { try { localStorage.setItem('vaani-custom', JSON.stringify(readProduct())); } catch { /* ignore */ } }
  }));
  fillPreset('flowdesk');
  consent.addEventListener('change', updateControls);

  const hasSR = Boolean(SR);
  if (!hasSR) $('#browserNote').hidden = false;

  /* ---------- network ---------- */
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(data.error || 'Request failed (' + r.status + ')');
    return data;
  }

  /* ---------- speech output ---------- */
  let voices = [];
  const loadVoices = () => { try { voices = speechSynthesis.getVoices(); } catch { voices = []; } };
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.addEventListener('voiceschanged', loadVoices); }

  function pickVoice(langTag) {
    const want = langTag.toLowerCase();
    const base = want.split('-')[0];
    const norm = (v) => v.lang.toLowerCase().replace('_', '-');
    const pool = voices.filter((v) => norm(v) === want).concat(voices.filter((v) => norm(v).split('-')[0] === base && norm(v) !== want));
    return pool.find((v) => /google|natural|online/i.test(v.name)) || pool[0] || null;
  }

  function cancelSpeech() {
    if (speechCancel) speechCancel();
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const lang = LANGS[call.language].speech;
      const voice = pickVoice(lang);
      const parts = text.split(/(?<=[.!?।॥])\s+/).map((s) => s.trim()).filter(Boolean);
      let i = 0;
      let stopped = false;
      let guard = null;
      const finish = () => { clearTimeout(guard); speechCancel = null; resolve(); };
      speechCancel = () => { stopped = true; finish(); };
      guard = setTimeout(() => { stopped = true; try { speechSynthesis.cancel(); } catch { /* ignore */ } finish(); }, 8000 + text.length * 110);
      const next = () => {
        if (stopped) return;
        if (i >= parts.length) return finish();
        const u = new SpeechSynthesisUtterance(parts[i++]);
        u.lang = lang;
        if (voice) u.voice = voice;
        u.rate = 1;
        u.onend = next;
        u.onerror = next;
        speechSynthesis.speak(u);
      };
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      setTimeout(next, 60);
    });
  }

  /* ---------- speech input ---------- */
  function stopRecognition() {
    const r = rec;
    rec = null;
    if (r) { try { r.abort(); } catch { /* ignore */ } }
  }

  function startRecognition() {
    if (!SR || recBlocked || !active || phase !== 'listening') return;
    stopRecognition();
    const me = new SR();
    rec = me;
    me.lang = LANGS[call.language].speech;
    me.interimResults = true;
    me.continuous = false;
    me.maxAlternatives = 1;
    let finalText = '';
    let lastInterim = '';
    me.onresult = (e) => {
      if (me !== rec) return;
      recErrors = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      lastInterim = interim;
      clearSilence();
      showInterim((finalText + interim).trim());
    };
    me.onerror = (e) => {
      if (me !== rec) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        recBlocked = true;
        showError('Speech recognition is blocked. Allow microphone access for this site, or type your replies below.');
        setPhase(phase);
      } else if (e.error === 'language-not-supported') {
        recBlocked = true;
        showError('This browser cannot recognise ' + LANGS[call.language].name + ' speech. You can type your replies instead.');
        setPhase(phase);
      } else if (e.error === 'network' || e.error === 'audio-capture') {
        recErrors++;
        if (recErrors >= 3) {
          recBlocked = true;
          showError('Voice input stopped working (' + e.error + '). You can type your replies below.');
          setPhase(phase);
        }
      }
    };
    me.onend = () => {
      if (me !== rec) return;
      rec = null;
      const text = (finalText || lastInterim).trim();
      if (text && active && phase === 'listening') return submitCustomer(text);
      if (active && phase === 'listening' && !recBlocked) {
        if (!silenceTimer) armSilence();
        setTimeout(startRecognition, 200);
      }
    };
    try { me.start(); } catch { /* already started */ }
  }

  function armSilence() { clearSilence(); silenceTimer = setTimeout(onSilence, SILENCE_MS); }
  function clearSilence() { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } }

  function onSilence() {
    silenceTimer = null;
    if (!active || phase !== 'listening') return;
    silenceCount++;
    stopRecognition();
    removeInterim();
    const note = silenceCount === 1
      ? '[System note: the customer has been silent for about 15 seconds. Politely check whether they are still there and offer to repeat or simplify your last question. One short sentence.]'
      : '[System note: the customer is still silent. Say one brief, polite goodbye, tell them they can call back any time, and end the call with [END_CALL].]';
    apiHistory.push({ role: 'user', content: note });
    runBot();
  }

  /* ---------- conversation loop ---------- */
  function listen() {
    if (!active) return;
    setPhase('listening');
    armSilence();
    startRecognition();
  }

  function submitCustomer(text) {
    stopRecognition();
    clearSilence();
    silenceCount = 0;
    removeInterim();
    addMessage('customer', text);
    call.transcript.push({ role: 'customer', text, t: Math.round((Date.now() - startedAt) / 1000) });
    apiHistory.push({ role: 'user', content: text });
    customerTurns++;
    runBot();
  }

  async function runBot() {
    if (!active) return;
    const my = ++turnId;
    cancelSpeech();
    stopRecognition();
    setPhase('thinking');
    showThinking();
    let reply;
    try {
      const data = await post('/api/chat', {
        product: call.product, agentName: botName(), language: call.language, history: apiHistory,
      });
      reply = data.reply;
    } catch (e) {
      if (my !== turnId || !active) return;
      hideThinking();
      showError('The bot could not respond: ' + e.message, () => { if (active) runBot(); });
      setPhase('listening');
      armSilence();
      return;
    }
    if (my !== turnId || !active) return;
    hideThinking();
    const wantsEnd = /\[END_CALL\]/i.test(reply);
    reply = reply.replace(/\[END_CALL\]/gi, '').trim();
    if (reply) {
      apiHistory.push({ role: 'assistant', content: reply });
      addMessage('bot', reply);
      call.transcript.push({ role: 'bot', text: reply, t: Math.round((Date.now() - startedAt) / 1000) });
      setPhase('speaking');
      await speak(reply);
      if (my !== turnId || !active) return;
    }
    if (wantsEnd) return endCall('bot');
    setTimeout(() => { if (my === turnId && active) listen(); }, 250);
  }

  typeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = typeInput.value.trim();
    if (!text || !active || phase === 'thinking' || phase === 'connecting') return;
    typeInput.value = '';
    cancelSpeech();
    submitCustomer(text);
  });
  typeInput.addEventListener('input', () => { if (phase === 'listening') armSilence(); });

  /* ---------- timer + meter + recording ---------- */
  function startTimer() {
    timerEl.textContent = '00:00';
    timerId = setInterval(() => { timerEl.textContent = fmtDur(Math.round((Date.now() - startedAt) / 1000)); }, 500);
  }
  function stopTimer() { clearInterval(timerId); timerId = null; }

  for (let i = 0; i < 28; i++) meterEl.append(document.createElement('span'));
  function startMeter() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const bars = [...meterEl.children];
      const loop = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(data);
        bars.forEach((b, i) => {
          const v = data[Math.floor((i * data.length) / bars.length / 2)] / 255;
          b.style.transform = 'scaleY(' + (0.12 + v * 0.88).toFixed(2) + ')';
        });
        meterRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* meter is optional */ }
  }
  function stopMeter() {
    cancelAnimationFrame(meterRaf);
    analyser = null;
    if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
    [...meterEl.children].forEach((b) => { b.style.transform = ''; });
  }

  function startRecording() {
    if (!stream || typeof MediaRecorder === 'undefined') return false;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch { return false; }
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(1000);
    return true;
  }
  function stopRecording() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve(chunks.length ? new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' }) : null);
      recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null);
      recorder.stop();
    });
  }
  function releaseMic() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    recorder = null;
  }

  /* ---------- start / end ---------- */
  function voicesReady() {
    return new Promise((resolve) => {
      loadVoices();
      if (voices.length || !('speechSynthesis' in window)) return resolve();
      const t = setTimeout(resolve, 1200);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); loadVoices(); resolve(); }, { once: true });
    });
  }

  async function startCall() {
    if (active || !consent.checked) return;
    hideError();
    const product = readProduct();
    if (!product.name || !product.description) {
      $('.product-details').open = true;
      showError('Add at least a product name and what it does before starting.');
      return;
    }
    // reset UI
    chat.querySelectorAll('.msg').forEach((n) => n.remove());
    if (chatEmpty) chatEmpty.hidden = true;
    resultEl.hidden = true;
    resultEl.replaceChildren();
    apiHistory = [];
    customerTurns = 0;
    silenceCount = 0;
    recBlocked = false;
    recErrors = 0;
    chunks = [];
    recorder = null;

    call = {
      id: 'call_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      startedAt: Date.now(),
      language: langSel.value,
      product,
      agentName: botName(),
      consent: { given: true, at: new Date().toISOString() },
      transcript: [],
      recorded: false,
    };
    active = true;
    startedAt = call.startedAt;
    callChip.textContent = product.name + ' · ' + LANGS[call.language].name;
    setPhase('connecting');
    startTimer();

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
      call.recorded = startRecording();
      startMeter();
    } catch {
      stream = null;
      showError('Microphone access was not allowed, so this call is not recorded and voice input is off. You can still type your replies.');
      recBlocked = true;
    }
    if (!active) return;

    await voicesReady();
    if (!active) return;
    if ('speechSynthesis' in window && !pickVoice(LANGS[call.language].speech)) {
      addMessage('system', 'No ' + LANGS[call.language].name + ' voice is installed on this device, so the bot will use a default voice. Pick English or install a ' + LANGS[call.language].name + ' voice in your system settings.');
    }
    runBot();
  }

  async function endCall(by) {
    if (!active) return;
    active = false;
    turnId++;
    clearSilence();
    stopRecognition();
    cancelSpeech();
    hideThinking();
    removeInterim();
    stopTimer();
    stopMeter();
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    timerEl.textContent = fmtDur(durationSec);
    setPhase('processing');

    const blob = await stopRecording();
    releaseMic();
    call.endedAt = Date.now();
    call.durationSec = durationSec;
    call.endedBy = by || 'customer';
    call.recorded = Boolean(blob);

    try {
      call.analysis = await post('/api/analyze', {
        product: call.product, language: call.language,
        transcript: call.transcript.map((t) => ({ role: t.role, text: t.text })), durationSec,
      });
    } catch (e) {
      call.analysis = {
        summary: 'The automatic summary could not be generated (' + e.message + ').',
        customer_requirements: [], objections: [], next_steps: [],
        status: customerTurns ? 'Follow-up Required' : 'No Response',
        status_reason: 'Fallback status because the analysis failed.',
        failed: true,
      };
    }

    let saveFailed = false;
    try {
      await dbPutCall(call);
      if (blob) await dbPutAudio(call.id, blob);
    } catch { saveFailed = true; }

    renderCall(call, blob, resultEl, { saveFailed });
    resultEl.hidden = false;
    setPhase('ended');
    resultEl.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    refreshHistory();
  }

  startBtn.addEventListener('click', startCall);
  endBtn.addEventListener('click', () => endCall('customer'));
  window.addEventListener('beforeunload', (e) => { if (active) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- rendering a finished call ---------- */
  let audioUrl = null;
  function renderCall(c, blob, container, opts = {}) {
    container.replaceChildren();
    const a = c.analysis || {};
    const root = el('div', 'call-detail');

    const head = el('div', 'cd-head');
    const title = el('div', 'cd-title');
    title.append(el('strong', '', (c.product && c.product.name) || 'Call'));
    title.append(el('span', '', fmtDate(c.startedAt) + ' · ' + fmtDur(c.durationSec || 0) + ' · ' + LANGS[c.language].name));
    const pill = el('span', 'pill st-' + slug(a.status || 'No Response'), a.status || 'No Response');
    head.append(title, pill);
    root.append(head);

    root.append(el('p', 'summary', a.summary || ''));
    if (a.status_reason) root.append(el('p', 'reason', 'Why this status: ' + a.status_reason));

    const cols = el('div', 'cols');
    [['Customer requirements', a.customer_requirements], ['Objections', a.objections], ['Next steps', a.next_steps]].forEach(([label, items]) => {
      const col = el('div', 'col');
      col.append(el('h3', '', label));
      if (items && items.length) {
        const ul = el('ul');
        items.forEach((i) => ul.append(el('li', '', i)));
        col.append(ul);
      } else col.append(el('p', 'none', 'None noted'));
      cols.append(col);
    });
    root.append(cols);

    const recBox = el('div', 'recording');
    recBox.append(el('h3', '', 'Recording'));
    if (blob) {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob);
      const audio = el('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = audioUrl;
      recBox.append(audio);
      const dl = el('a', '', 'Download recording');
      dl.href = audioUrl;
      dl.download = c.id + (blob.type.includes('mp4') ? '.m4a' : blob.type.includes('ogg') ? '.ogg' : '.webm');
      recBox.append(dl);
    } else {
      recBox.append(el('p', 'none', 'No recording was saved for this call.'));
    }
    if (c.consent) recBox.append(el('p', 'fine', 'Recording consent given ' + new Date(c.consent.at).toLocaleString() + '.'));
    if (opts.saveFailed) recBox.append(el('p', 'fine', 'This browser blocked storage, so the call could not be added to history.'));
    root.append(recBox);

    const tr = el('details', 'transcript');
    tr.open = Boolean(opts.openTranscript);
    tr.append(el('summary', '', 'Transcript (' + c.transcript.length + ' turns)'));
    c.transcript.forEach((t) => {
      const line = el('div', 't-line');
      line.append(el('span', 't-time', fmtDur(t.t || 0)), el('span', 't-who', t.role === 'bot' ? (c.agentName || 'Bot') : 'Customer'), el('span', 't-text', t.text));
      tr.append(line);
    });
    root.append(tr);

    if (opts.deletable) {
      const del = el('button', 'btn ghost', 'Delete this call');
      del.type = 'button';
      let armed = null;
      del.addEventListener('click', async () => {
        if (!armed) {
          del.textContent = 'Click again to delete';
          del.classList.add('danger');
          armed = setTimeout(() => { armed = null; del.textContent = 'Delete this call'; del.classList.remove('danger'); }, 4000);
          return;
        }
        clearTimeout(armed);
        await dbDelete(c.id).catch(() => {});
        selectedId = null;
        $('#historyDetail').replaceChildren(emptyDetail());
        refreshHistory();
      });
      root.append(del);
    }
    container.append(root);
  }

  /* ---------- history ---------- */
  let selectedId = null;
  const emptyDetail = () => { const d = el('div', 'empty'); d.append(el('p', 'empty-title', 'Select a call to see its recording, summary and transcript.')); return d; };

  async function refreshHistory() {
    let calls = [];
    try { calls = (await dbAllCalls()) || []; } catch { calls = []; }
    calls.sort((a, b) => b.startedAt - a.startedAt);
    $('#historyCount').textContent = String(calls.length);
    const list = $('#historyList');
    list.replaceChildren();
    if (!calls.length) {
      const e = el('div', 'empty');
      e.append(el('p', 'empty-title', 'No calls yet'), el('p', '', 'Finished calls appear here with their recording, summary, transcript and status.'));
      list.append(e);
      return;
    }
    calls.forEach((c) => {
      const b = el('button', 'hitem');
      b.type = 'button';
      if (c.id === selectedId) b.setAttribute('aria-current', 'true');
      const h1 = el('div', 'h1');
      h1.append(el('strong', '', (c.product && c.product.name) || 'Call'), el('span', 'pill st-' + slug((c.analysis && c.analysis.status) || 'No Response'), (c.analysis && c.analysis.status) || 'No Response'));
      b.append(h1, el('div', 'h2', fmtDate(c.startedAt) + ' · ' + fmtDur(c.durationSec || 0) + ' · ' + LANGS[c.language].name));
      b.addEventListener('click', () => openCall(c.id, calls));
      list.append(b);
    });
  }

  async function openCall(id, calls) {
    selectedId = id;
    const c = (calls || (await dbAllCalls())).find((x) => x.id === id);
    if (!c) return;
    let blob = null;
    try { blob = await dbGetAudio(id); } catch { /* ignore */ }
    renderCall(c, blob || null, $('#historyDetail'), { deletable: true, openTranscript: true });
    refreshHistory();
    if (window.matchMedia('(max-width: 900px)').matches) $('#historyDetail').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  /* ---------- tabs ---------- */
  function showTab(name) {
    const hist = name === 'history';
    $('#viewCall').hidden = hist;
    $('#viewHistory').hidden = !hist;
    $('#tabCall').setAttribute('aria-selected', String(!hist));
    $('#tabHistory').setAttribute('aria-selected', String(hist));
    if (hist) refreshHistory();
  }
  $('#tabCall').addEventListener('click', () => { showTab('call'); history.replaceState(null, '', '#call'); });
  $('#tabHistory').addEventListener('click', () => { showTab('history'); history.replaceState(null, '', '#history'); });
  if (location.hash === '#history') showTab('history');

  setPhase('idle');
  refreshHistory();
})();
