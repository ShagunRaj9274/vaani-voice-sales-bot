'use strict';
/*
 * Vaani server: zero dependencies (Node 18+).
 *  - serves the static app from /public
 *  - POST /api/chat     -> next thing the sales bot says
 *  - POST /api/analyze  -> summary, requirements, objections, next steps, sales status
 * The Anthropic API key stays on the server; the browser never sees it.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + (process.env.GEMINI_MODEL || 'gemini-2.5-flash') + ':generateContent';
const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ANALYSIS_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATUSES = ['Converted', 'Interested', 'Follow-up Required', 'Not Interested', 'Demo Requested', 'No Response'];
const LANG_NAMES = { en: 'English', hi: 'Hindi', te: 'Telugu' };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/* ---------- small helpers ---------- */
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

const hits = new Map();
function rateLimited(ip) {
  const windowMs = 10 * 60 * 1000;
  const max = Number(process.env.RATE_LIMIT_PER_10_MIN) || 150;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter((t) => now - t < 600000);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, 60000).unref();

function readBody(req, limit = 120 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function callGemini({ model, system, messages, max_tokens }) {
  if (!API_KEY) {
    throw Object.assign(
      new Error('The server is missing GEMINI_API_KEY.'),
      { status: 503 }
    );
  }

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  const response = await fetch(API_URL + '?key=' + encodeURIComponent(API_KEY), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: String(system || '') }]
      },
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens
      }
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    console.error('Gemini error', response.status, detail);
    throw Object.assign(
      new Error('The AI service returned an error (' + response.status + ').'),
      { status: 502 }
    );
  }

  const data = await response.json();
  return (data.candidates?.[0]?.content?.parts || [])
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/* ---------- prompts ---------- */
function cleanProduct(p = {}) {
  return {
    company: clip(p.company, 120) || 'our company',
    name: clip(p.name, 120) || 'our product',
    description: clip(p.description, 1200),
    features: clip(p.features, 1500),
    pricing: clip(p.pricing, 800),
    offer: clip(p.offer, 600),
    audience: clip(p.audience, 600),
  };
}

function buildSalesPrompt(product, agentName, lang) {
  const p = cleanProduct(product);
  const language = LANG_NAMES[lang] || 'English';
  const script =
    lang === 'hi' ? 'Write Hindi in Devanagari script.' : lang === 'te' ? 'Write Telugu in Telugu script.' : '';
  return `You are ${clip(agentName, 40) || 'Aisha'}, an AI sales assistant for ${p.company}, on a live voice call with a prospective customer. You are selling ${p.name}.

PRODUCT FACTS (your only source of truth)
- What it is: ${p.description || 'not provided'}
- Key features: ${p.features || 'not provided'}
- Pricing: ${p.pricing || 'not provided'}
- Offer / next step to propose: ${p.offer || 'a short demo or a free trial'}
- Best fit for: ${p.audience || 'not provided'}

LANGUAGE
Speak ${language}. ${script} If the customer switches to English, Hindi or Telugu, follow them. Keep product and brand names in Latin script.

HOW TO SPEAK (your words are read aloud by a text-to-speech voice)
- Plain spoken sentences only. No markdown, bullet points, emojis, asterisks or stage directions.
- Maximum 2 short sentences per turn, then stop. Ask only one question at a time.
- Write numbers and prices the way a person would say them aloud.
- Sound warm, confident and respectful, never pushy.

CALL FLOW
1. Opening (your first turn): greet the customer, say your name and company, say you are an AI assistant, mention that the call is being recorded for quality and a summary, and ask if now is a good time.
2. Discovery: ask short questions to learn their business, current tool and pain points.
3. Pitch: connect two or three relevant features to what they said. Do not list everything.
4. Objections (price, timing, switching effort, trust, already using something): acknowledge, answer briefly with facts you have, then check if that helps.
5. Close: propose the offer or a demo. If they agree, confirm the next step (their name, preferred time, email or phone) one detail at a time.

RULES
- Never invent features, prices, discounts, customers or statistics. If you do not know, say the team will confirm it in the follow-up.
- If the customer clearly says no twice, thank them politely and end the call.
- If they ask for a human, offer a follow-up call from the team.
- If they sincerely ask whether you are a person or a bot, say you are an AI assistant.
- Lines in square brackets that start with "System note" come from the call system, not the customer. Follow them without mentioning them.
- When the conversation has naturally finished (next step agreed, the customer declined, or they said goodbye), say one short goodbye and end your message with the exact token [END_CALL].`;
}

function buildAnalysisPrompt(product, language) {
  const p = cleanProduct(product);
  return `You analyse sales call transcripts for ${p.company}, who sell ${p.name}. The call was held in ${LANG_NAMES[language] || 'English'}. Write all output in English.

Return ONLY a JSON object with exactly these keys:
{
  "summary": "2-3 sentences: who the customer is, what was discussed, how the call ended",
  "customer_requirements": ["short phrases, what the customer needs or asked for"],
  "objections": ["short phrases, concerns or reasons for hesitation"],
  "next_steps": ["concrete follow-up actions, with times or contact details if given"],
  "status": "one of: ${STATUSES.join(' | ')}",
  "status_reason": "one sentence explaining the status"
}

Status rules (pick the single best match):
- Converted: the customer agreed to buy or sign up (paid plan, subscription or trial) during the call.
- Demo Requested: the customer asked for, or agreed to, a demo, walkthrough or meeting, and has not converted.
- Interested: positive and engaged, asked buying-related questions, but no commitment or fixed next step.
- Follow-up Required: undecided, asked to be called later or sent details, or has open objections but did not refuse.
- Not Interested: clearly declined.
- No Response: the customer said nothing meaningful.
Use empty arrays when nothing applies. Do not invent details that are not in the transcript.`;
}

/* ---------- API handlers ---------- */
function normalizeHistory(history) {
  const out = [{ role: 'user', content: '[System note: the call has just connected.]' }];
  const list = Array.isArray(history) ? history.slice(-60) : [];
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = clip(m.content, 1500).trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last.role === m.role) last.content += '\n' + content;
    else out.push({ role: m.role, content });
  }
  if (out[out.length - 1].role !== 'user') {
    out.push({ role: 'user', content: '[System note: continue the call.]' });
  }
  return out;
}

async function handleChat(body) {
  const system = buildSalesPrompt(body.product, body.agentName, body.language);
  const messages = normalizeHistory(body.history);
  const reply = (await callGemini({ model: CHAT_MODEL, system, messages, max_tokens: 500 })).trim();
  if (!reply) throw Object.assign(new Error('The AI returned an empty reply.'), { status: 502 });
  return { reply };
}

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no JSON in reply');
  return JSON.parse(text.slice(s, e + 1));
}

const list = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 300).trim()).filter(Boolean).slice(0, 6) : []);

function normalizeStatus(s) {
  const wanted = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  return STATUSES.find((x) => x.toLowerCase().replace(/[^a-z]/g, '') === wanted) || 'Follow-up Required';
}

async function handleAnalyze(body) {
  const transcript = (Array.isArray(body.transcript) ? body.transcript : [])
    .slice(-120)
    .map((t) => ({ role: t && t.role === 'customer' ? 'customer' : 'bot', text: clip(t && t.text, 1500).trim() }))
    .filter((t) => t.text);
  const customerTurns = transcript.filter((t) => t.role === 'customer').length;

  if (customerTurns === 0) {
    return {
      summary: 'The customer did not speak during the call, so no conversation took place.',
      customer_requirements: [],
      objections: [],
      next_steps: ['Try the customer again at a different time.'],
      status: 'No Response',
      status_reason: 'No customer replies were recorded.',
    };
  }

  const text = transcript.map((t) => (t.role === 'customer' ? 'Customer: ' : 'Sales bot: ') + t.text).join('\n');
  const raw = await callGemini({
    model: ANALYSIS_MODEL,
    system: buildAnalysisPrompt(body.product, body.language),
    messages: [{ role: 'user', content: 'Call transcript:\n\n' + text }],
    max_tokens: 900,
  });
  let data;
  try {
    data = extractJson(raw);
  } catch {
    throw Object.assign(new Error('Could not read the AI analysis.'), { status: 502 });
  }
  return {
    summary: clip(data.summary, 800).trim() || 'No summary available.',
    customer_requirements: list(data.customer_requirements),
    objections: list(data.objections),
    next_steps: list(data.next_steps),
    status: normalizeStatus(data.status),
    status_reason: clip(data.status_reason, 300).trim(),
  };
}

/* ---------- static files ---------- */
function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'microphone=(self)',
    });
    res.end(buf);
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/health') return sendJson(res, 200, { ok: true, aiConfigured: Boolean(API_KEY) });

  if (url === '/api/chat' || url === '/api/analyze') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests. Please wait a few minutes.' });
    try {
      const body = await readBody(req);
      const result = url === '/api/chat' ? await handleChat(body) : await handleAnalyze(body);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || 'Server error' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Vaani running on http://localhost:${PORT}`);
  if (!API_KEY) console.warn('Warning: GEMINI_API_KEY is not set. The bot cannot answer until it is.');
});


