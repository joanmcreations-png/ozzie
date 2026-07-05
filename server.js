// Recepcionista IA — Demo server
// Uso: node server.js  → http://localhost:3210
// Sin API key funciona igual (la web usa el modo demo). Con key: IA real.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env from this folder, or reuse the one from APP CREAR PRODUCTOS
for (const p of [path.join(__dirname, '.env'), path.join(__dirname, '..', 'APP CREAR PRODUCTOS', '.env')]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  break;
}

const PORT    = process.env.PORT || 3210;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = 'claude-haiku-4-5-20251001';

// WhatsApp Cloud API — one token, many numbers. Each business's own WhatsApp
// number lives in Supabase (businesses.whatsapp_phone_number_id); incoming
// webhooks are routed to the right business by that number, so adding a new
// client is just a new row in Supabase, no code/deploy needed.
const WA_TOKEN     = process.env.WHATSAPP_TOKEN || '';
const WA_VERIFY    = process.env.WHATSAPP_VERIFY_TOKEN || 'ozzie-verify';
const waHistory = new Map(); // "phoneNumberId:customerPhone" -> [{role, content}]

// Instagram DM — same Meta Graph API/App as WhatsApp, different product.
// Each business's Instagram professional account id lives in Supabase
// (businesses.instagram_account_id); same webhook, same verify token.
const IG_TOKEN  = process.env.INSTAGRAM_TOKEN || WA_TOKEN;
const IG_TEST_MODE = process.env.INSTAGRAM_TEST_MODE === 'true';
const igHistory = new Map(); // "igAccountId:senderPsid" -> [{role, content}]

// Supabase (conversation history + client panel)
const SB_URL          = process.env.SUPABASE_URL || '';
const SB_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PANEL_TOKEN     = process.env.PANEL_TOKEN || 'ozzie-panel';

// Google Calendar — per-business OAuth (each business connects their own calendar
// from the panel; we store their refresh_token and check/create real events with it)
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3210}/api/panel/google/callback`;

function sbFetch(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  return new Promise((resolve, reject) => {
    if (!SB_URL || !SB_SERVICE_KEY) return reject(new Error('Supabase not configured'));
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    };
    if (prefer) headers.Prefer = prefer;
    const req = https.request(`${SB_URL}/rest/v1/${pathAndQuery}`, { method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw ? JSON.parse(raw) : null);
        } else {
          reject(new Error(`Supabase ${method} ${pathAndQuery} failed: ${res.statusCode} ${raw}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const BUSINESS_FIELDS = 'id,bot_enabled,facts,name,timezone,google_refresh_token,google_calendar_id';

async function getBusinessByPhoneId(phoneNumberId) {
  const businesses = await sbFetch(`businesses?whatsapp_phone_number_id=eq.${encodeURIComponent(phoneNumberId)}&select=${BUSINESS_FIELDS}`);
  return businesses && businesses[0];
}

async function getBusinessByInstagramId(igAccountId) {
  const businesses = await sbFetch(`businesses?instagram_account_id=eq.${encodeURIComponent(igAccountId)}&select=${BUSINESS_FIELDS}`);
  return businesses && businesses[0];
}

async function getOrCreateConversation(business, phone) {
  const existing = await sbFetch(`conversations?business_id=eq.${business.id}&customer_phone=eq.${encodeURIComponent(phone)}&select=id,bot_enabled`);
  if (existing && existing[0]) return existing[0];

  const created = await sbFetch('conversations', {
    method: 'POST',
    body: { business_id: business.id, customer_phone: phone },
    prefer: 'return=representation'
  });
  return created[0];
}

function logMessage(conversationId, role, content) {
  return sbFetch('messages', { method: 'POST', body: { conversation_id: conversationId, role, content } }).catch(e => console.error('log message error:', e.message));
}

async function saveBooking(conversationId, businessId, service, whenText, customerName, startIso, endIso) {
  let googleEventId = null;
  if (startIso && endIso) {
    try {
      const [business] = await sbFetch(`businesses?id=eq.${businessId}&select=${BUSINESS_FIELDS}`);
      if (business && business.google_refresh_token) {
        googleEventId = await createCalendarEvent(business, `${service} — ${customerName}`, startIso, endIso);
      }
    } catch (e) { console.error('Google Calendar event creation error:', e.message); }
  }
  return sbFetch('bookings', {
    method: 'POST',
    body: {
      conversation_id: conversationId, business_id: businessId, service, when_text: whenText, customer_name: customerName,
      start_iso: startIso || null, end_iso: endIso || null, google_event_id: googleEventId
    }
  }).catch(e => console.error('save booking error:', e.message));
}

// --- Google Calendar (per-business OAuth, real availability + event creation) ---

function googleTokenRequest(params) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
          else reject(new Error(j.error_description || j.error || 'Google token request failed'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getGoogleAccessToken(business) {
  if (!business.google_refresh_token) return null;
  const j = await googleTokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: business.google_refresh_token,
    grant_type: 'refresh_token'
  });
  return j.access_token;
}

function googleApiRequest(accessToken, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = raw ? JSON.parse(raw) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
          else reject(new Error(j.error?.message || 'Google Calendar API error ' + res.statusCode));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Returns { available: bool }. Fails open (treats as available) if the business
// has no calendar connected yet, or if the Google API call itself errors out —
// we never want a hiccup on our side to block a real booking.
async function checkAvailability(business, startIso, endIso) {
  if (!business.google_refresh_token) return { available: true };
  try {
    const accessToken = await getGoogleAccessToken(business);
    const calId = business.google_calendar_id || 'primary';
    const j = await googleApiRequest(accessToken, 'POST', '/calendar/v3/freeBusy', {
      timeMin: startIso, timeMax: endIso, items: [{ id: calId }]
    });
    const busy = j.calendars?.[calId]?.busy || [];
    return { available: busy.length === 0 };
  } catch (e) {
    console.error('checkAvailability error:', e.message);
    return { available: true };
  }
}

async function createCalendarEvent(business, summary, startIso, endIso) {
  const accessToken = await getGoogleAccessToken(business);
  const calId = business.google_calendar_id || 'primary';
  const j = await googleApiRequest(accessToken, 'POST', `/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: endIso }
  });
  return j.id || null;
}

const AVAILABILITY_TOOL = {
  name: 'check_availability',
  description: 'Check whether the business calendar is free for an exact time range. You MUST call this before confirming any booking. If it comes back not available, apologize briefly and ask the customer for a different time instead of confirming.',
  input_schema: {
    type: 'object',
    properties: {
      start_iso: { type: 'string', description: 'Proposed start time, ISO 8601 with UTC offset, e.g. 2026-07-06T17:00:00-07:00' },
      end_iso: { type: 'string', description: 'Proposed end time, ISO 8601 with UTC offset (default to 30-45 min after start unless the service implies otherwise)' }
    },
    required: ['start_iso', 'end_iso']
  }
};

const BIZ_FACTS = {
  barber: `Negocio: North Van Barbers (barbería en 123 Lonsdale Ave, North Vancouver).
Horario: lunes a sábado 9:00-19:00, domingos cerrado.
Precios: corte $35, corte + barba $50, afeitado clásico $30, niños $25.`,
  resto: `Negocio: La Costa Restaurant (456 Granville St, Vancouver, cerca de Waterfront Station).
Horario: todos los días 11:30-22:00, cocina cierra 21:30.
Precios: principales $18-$34, menú de mediodía entre semana $19. Hay patio exterior.
Para reservas pregunta número de personas en vez de servicio.`,
  dental: `Negocio: Kits Dental Clinic (789 W 4th Ave, Kitsilano, Vancouver, parking gratis detrás).
Horario: lunes a viernes 8:00-17:00. Urgencias mismo día si es posible.
Precios: limpieza desde $150, revisión + rayos X $120. Aceptan la mayoría de seguros.`
};

function systemPrompt(facts, lang, nowText, timezone, hasCalendarTool = true) {
  return `Eres la persona que lleva los mensajes (WhatsApp/Instagram) de este negocio:

${facts}

Ahora mismo es: ${nowText} (zona horaria ${timezone}). Usa esto para resolver "mañana", "el viernes", etc. a una fecha exacta.

Cómo escribes:
- REGLA DE IDIOMA (la más importante): responde SIEMPRE en el MISMO idioma en que te escribe el cliente en su último mensaje. Si te escribe en inglés, respondes en inglés. Si te escribe en español, en español. NUNCA cambies de idioma tú solo. Este negocio está en Vancouver (Canadá): POR DEFECTO todo es en INGLÉS. Si el mensaje NO tiene idioma claro (solo emoji, números, símbolos o un saludo ambiguo): responde en INGLÉS. Solo usa español si el cliente escribe claramente en español.
- Como una persona real del equipo, ocupada pero amable. Natural, cercano, cero corporativo.
- Mensajes MUY cortos, estilo mensaje directo real: 1-2 frases. A veces empieza en minúscula. Emoji solo de vez en cuando (máximo 1).
- Habla en voz de equipo: "abrimos"/"we're open", "te esperamos"/"see you then", "te lo miro"/"let me check".
- Varía las frases, nunca suenes a plantilla. Nada de listas ni formato.
- NUNCA digas que eres una IA, bot, asistente virtual o sistema automático. Y IGUAL de importante: nunca digas "no soy un bot" ni afirmes ser una persona — eso es mentir y está prohibido. Si te preguntan si eres un bot, NO respondas a la pregunta: ignórala con gracia y redirige, EN SU IDIOMA (ej. en inglés: "haha I'm right here to help — what do you need? 😄"; en español: "jaja tú dime qué necesitas y te lo miro ahora mismo 😄"). Ni sí, ni no, nunca.

Qué haces:
- Solo hablas de este negocio. Si preguntan otra cosa, redirige con amabilidad.
- Si el cliente quiere reservar necesitas SOLO estos 3 datos: (1) servicio o nº de personas, (2) día y hora, (3) nombre. Pide UNA cosa por mensaje, y solo las que falten (si el cliente ya dio alguna, no la vuelvas a pedir).
- NO pidas datos extra (ni dine-in/takeout, ni "qué viernes", ni teléfono, ni nada más). Si algo es ambiguo como "viernes", asume el próximo que viene, no preguntes.
- EN CUANTO tengas esos 3 datos${hasCalendarTool ? ', calcula la hora exacta en ISO 8601 (con offset de ' + timezone + ') y llama a la tool check_availability ANTES de confirmar nada. Si dice que NO está disponible, dilo con naturalidad y pide otra hora (no confirmes, no emitas la línea de abajo). Si SÍ está disponible' : ''}, confirma YA en el mismo mensaje (frase corta y cálida) y añade al FINAL esta línea exacta, sin más preguntas:
BOOKING_CONFIRMED|<servicio o personas>|<día y hora en texto natural>|<nombre>|<start_iso o vacío>|<end_iso o vacío>
  · IDIOMA DE LA TARJETA: los campos <servicio o personas> y <día y hora en texto natural> DEBEN ir en el MISMO idioma en que escribe el cliente, aunque los datos del negocio de arriba estén en otro idioma. Si el cliente escribe en inglés, el servicio va en inglés (ej. "classic shave", NO "afeitado clásico"; "haircut + beard", NO "corte + barba"). Traduce el nombre del servicio al idioma del cliente.
- REGLA ANTI-INVENCIÓN (crítica): SOLO puedes afirmar datos que estén escritos arriba (horario, dirección, precios listados). CUALQUIER otra cosa que no esté arriba —opciones veganas/sin gluten, parking, métodos de pago, descuentos, qué seguros aceptáis, promociones, servicios extra— NO la afirmes ni la niegues con detalles inventados. En su lugar di con naturalidad que se lo confirmas, VARIANDO la frase cada vez (nunca repitas la misma palabra por palabra): p.ej. "let me check that for you and get back in a sec", "not 100% sure — I'll confirm with the team and let you know", "good q! I'll double-check and text you back", etc. En español igual, variando. Es preferible decir "te lo confirmo" antes que inventar. Inventar un dato falso es el peor error posible.`;
}

function sendWhatsAppMessage(phoneNumberId, to, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    });
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${phoneNumberId}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WA_TOKEN}`
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(raw);
        else reject(new Error('WhatsApp send failed: ' + raw));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendInstagramMessage(igAccountId, recipientId, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      recipient: { id: recipientId },
      message: { text }
    });
    const req = https.request({
      hostname: 'graph.instagram.com',
      path: `/v21.0/${igAccountId}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${IG_TOKEN}`
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(raw);
        else reject(new Error('Instagram send failed: ' + raw));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Runs the conversation turn against Claude, handling the check_availability
// tool-use round-trip transparently. Returns { reply, booking } where booking
// is null unless the model just confirmed one (already availability-checked).
async function converseWithBooking(business, messages) {
  const nowText = new Date().toLocaleString('en-US', { timeZone: business.timezone || 'America/Vancouver', dateStyle: 'full', timeStyle: 'short' });
  const system = systemPrompt(business.facts, 'en', nowText, business.timezone || 'America/Vancouver');
  let turnMessages = messages;

  for (let i = 0; i < 4; i++) {
    const r = await callAnthropic({
      model: MODEL,
      max_tokens: 400,
      system,
      tools: [AVAILABILITY_TOOL],
      messages: turnMessages
    });

    const toolUse = (r.content || []).find(b => b.type === 'tool_use' && b.name === 'check_availability');
    if (toolUse) {
      const result = await checkAvailability(business, toolUse.input.start_iso, toolUse.input.end_iso);
      turnMessages = turnMessages.concat([
        { role: 'assistant', content: r.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }] }
      ]);
      continue;
    }

    let reply = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const m = reply.match(/BOOKING_CONFIRMED\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^\n]*)/);
    reply = reply.replace(/BOOKING_CONFIRMED\|[^\n]*/g, '').trim();
    const booking = m ? { service: m[1].trim(), whenText: m[2].trim(), name: m[3].trim(), startIso: m[4].trim(), endIso: m[5].trim() } : null;
    return { reply, booking };
  }
  throw new Error('check_availability tool loop did not resolve');
}

async function handleIncomingWhatsApp(phoneNumberId, from, text) {
  const historyKey = `${phoneNumberId}:${from}`;
  const history = waHistory.get(historyKey) || [];
  history.push({ role: 'user', content: text });
  const clean = history.slice(-14);

  let business = null, conversation = null;
  try {
    business = await getBusinessByPhoneId(phoneNumberId);
    if (business) conversation = await getOrCreateConversation(business, from);
  } catch (e) {
    console.error('Supabase lookup error:', e.message);
  }
  if (!business) {
    console.error('No business configured in Supabase for WhatsApp number', phoneNumberId);
    return;
  }
  if (conversation) logMessage(conversation.id, 'user', text);

  const botOff = business.bot_enabled === false || (conversation && conversation.bot_enabled === false);
  if (botOff) return; // human has taken over this chat, or bot paused for this business

  try {
    const { reply, booking } = await converseWithBooking(business, clean);
    history.push({ role: 'assistant', content: reply });
    waHistory.set(historyKey, history);
    if (conversation) {
      logMessage(conversation.id, 'assistant', reply);
      if (booking) saveBooking(conversation.id, business.id, booking.service, booking.whenText, booking.name, booking.startIso, booking.endIso);
    }
    await sendWhatsAppMessage(phoneNumberId, from, reply);
  } catch (e) {
    console.error('WhatsApp handling error:', e.message);
  }
}

async function handleIncomingInstagram(igAccountId, senderId, text) {
  const historyKey = `${igAccountId}:${senderId}`;
  const history = igHistory.get(historyKey) || [];
  history.push({ role: 'user', content: text });
  const clean = history.slice(-14);

  let business = null, conversation = null;
  try {
    business = await getBusinessByInstagramId(igAccountId);
    if (business && IG_TEST_MODE) {
      // Modo prueba: solo contesta a quien ya tenga conversación abierta, o a la
      // primera persona que escriba si todavía no hay ninguna (así el bot no
      // responde a seguidores reales de la cuenta mientras se está probando).
      const others = await sbFetch(`conversations?business_id=eq.${business.id}&customer_phone=neq.${encodeURIComponent(senderId)}&select=id&limit=1`);
      if (others && others.length) {
        console.log('Instagram test mode: ignorando mensaje de', senderId, '(no es la cuenta de prueba)');
        return;
      }
    }
    if (business) conversation = await getOrCreateConversation(business, senderId);
  } catch (e) {
    console.error('Supabase lookup error:', e.message);
  }
  if (!business) {
    console.error('No business configured in Supabase for Instagram account', igAccountId);
    return;
  }
  if (conversation) logMessage(conversation.id, 'user', text);

  const botOff = business.bot_enabled === false || (conversation && conversation.bot_enabled === false);
  if (botOff) return; // human has taken over this chat, or bot paused for this business

  try {
    const { reply, booking } = await converseWithBooking(business, clean);
    history.push({ role: 'assistant', content: reply });
    igHistory.set(historyKey, history);
    if (conversation) {
      logMessage(conversation.id, 'assistant', reply);
      if (booking) saveBooking(conversation.id, business.id, booking.service, booking.whenText, booking.name, booking.startIso, booking.endIso);
    }
    await sendInstagramMessage(igAccountId, senderId, reply);
  } catch (e) {
    console.error('Instagram handling error:', e.message);
  }
}

function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (res.statusCode !== 200) return reject(new Error(j.error?.message || 'API error ' + res.statusCode));
          resolve(j);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Meta webhook verification handshake
  if (req.method === 'GET' && pathname === '/webhook') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === WA_VERIFY) {
      res.writeHead(200); res.end(challenge);
    } else {
      res.writeHead(403); res.end('Forbidden');
    }
    return;
  }

  // Incoming WhatsApp + Instagram messages (same Meta webhook endpoint)
  if (req.method === 'POST' && pathname === '/webhook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200); res.end('EVENT_RECEIVED'); // ack immediately, Meta requires <5s
      try {
        const payload = JSON.parse(body);
        if (payload.object === 'instagram') {
          const messaging = payload.entry?.[0]?.messaging?.[0];
          const igAccountId = messaging?.recipient?.id;
          // is_echo = message the business itself sent via the API, played back to us — ignore, or we'd reply to ourselves
          if (messaging?.message && !messaging.message.is_echo && messaging.message.text && igAccountId) {
            handleIncomingInstagram(igAccountId, messaging.sender.id, messaging.message.text);
          }
          return;
        }
        const changes = payload.entry?.[0]?.changes?.[0]?.value;
        const phoneNumberId = changes?.metadata?.phone_number_id;
        const msg = changes?.messages?.[0];
        if (msg && msg.type === 'text' && phoneNumberId) {
          handleIncomingWhatsApp(phoneNumberId, msg.from, msg.text.body);
        }
      } catch (e) { console.error('Webhook parse error:', e.message); }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ai: !!API_KEY }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        if (!API_KEY) throw new Error('Sin API key');
        const { business, lang, messages } = JSON.parse(body);
        const clean = (messages || [])
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-14);
        const demoNowText = new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver', dateStyle: 'full', timeStyle: 'short' });
        const r = await callAnthropic({
          model: MODEL,
          max_tokens: 400,
          system: systemPrompt(BIZ_FACTS[business] || BIZ_FACTS.barber, lang, demoNowText, 'America/Vancouver', false),
          messages: clean
        });
        const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        res.end(JSON.stringify({ text }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Client panel API — protected by a shared token (?token=...)
  if (pathname.startsWith('/api/panel/')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader('Content-Type', 'application/json');

    if (pathname === '/api/panel/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { token } = JSON.parse(body);
          res.end(JSON.stringify({ ok: token === PANEL_TOKEN }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // Google redirects the business owner's browser straight here after consent —
    // it can't carry our panel token, so this route is exempt from the check below.
    // state=business_id is the only thing tying the code back to a business.
    if (pathname === '/api/panel/google/callback' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const code = url.searchParams.get('code');
      const businessId = url.searchParams.get('state');
      try {
        if (!code || !businessId) throw new Error('Missing code or state');
        const tokens = await googleTokenRequest({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code'
        });
        if (!tokens.refresh_token) throw new Error('Google no devolvió refresh_token (revoca el acceso en myaccount.google.com/permissions y vuelve a intentarlo)');
        await sbFetch(`businesses?id=eq.${encodeURIComponent(businessId)}`, {
          method: 'PATCH',
          body: { google_refresh_token: tokens.refresh_token, google_calendar_id: 'primary' }
        });
        res.end('<html><body style="font-family:sans-serif;padding:40px">Google Calendar conectado ✅ — ya puedes cerrar esta pestaña.</body></html>');
      } catch (e) {
        res.end(`<html><body style="font-family:sans-serif;padding:40px">Error conectando Google Calendar: ${e.message}</body></html>`);
      }
      return;
    }

    if (url.searchParams.get('token') !== PANEL_TOKEN) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }

    if (pathname === '/api/panel/conversations' && req.method === 'GET') {
      try {
        const rows = await sbFetch('conversations?select=id,customer_phone,customer_name,bot_enabled,updated_at,business:businesses(name,slug)&order=updated_at.desc');
        res.end(JSON.stringify(rows));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (pathname === '/api/panel/messages' && req.method === 'GET') {
      try {
        const cid = url.searchParams.get('conversation_id');
        const rows = await sbFetch(`messages?conversation_id=eq.${encodeURIComponent(cid)}&select=role,content,created_at&order=created_at.asc`);
        res.end(JSON.stringify(rows));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (pathname === '/api/panel/businesses' && req.method === 'GET') {
      try {
        const rows = await sbFetch('businesses?select=id,slug,name,whatsapp_phone_number_id,instagram_account_id,bot_enabled,created_at,google_refresh_token&order=created_at.desc');
        // never send the raw refresh token to the browser — just whether it's connected
        const safe = rows.map(({ google_refresh_token, ...rest }) => ({ ...rest, google_connected: !!google_refresh_token }));
        res.end(JSON.stringify(safe));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (pathname === '/api/panel/businesses' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { slug, name, whatsapp_phone_number_id, instagram_account_id, facts } = JSON.parse(body);
          if (!slug || !name || (!whatsapp_phone_number_id && !instagram_account_id)) {
            throw new Error('slug, name and at least one of whatsapp_phone_number_id / instagram_account_id are required');
          }
          const created = await sbFetch('businesses', {
            method: 'POST',
            body: { slug, name, whatsapp_phone_number_id: whatsapp_phone_number_id || null, instagram_account_id: instagram_account_id || null, facts: facts || '' },
            prefer: 'return=representation'
          });
          res.end(JSON.stringify(created[0]));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // Starts the Google OAuth consent flow for a given business — opened in a new
    // tab from the panel, not called via fetch (it's a browser redirect to Google).
    if (pathname === '/api/panel/google/connect' && req.method === 'GET') {
      const businessId = url.searchParams.get('business_id');
      if (!businessId) { res.writeHead(400); res.end(JSON.stringify({ error: 'business_id required' })); return; }
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/calendar',
        state: businessId
      }).toString();
      res.writeHead(302, { Location: authUrl }); res.end();
      return;
    }

    if (pathname === '/api/panel/toggle' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { conversation_id, bot_enabled } = JSON.parse(body);
          await sbFetch(`conversations?id=eq.${encodeURIComponent(conversation_id)}`, { method: 'PATCH', body: { bot_enabled } });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }

  // Static — '/' es la landing pública; la demo vive en index.html (embebida en iframe)
  const urlPath = pathname === '/' ? '/landing.html' : pathname;
  const filePath = path.join(__dirname, urlPath.replace(/^\//, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = ext === '.html' ? 'text/html; charset=utf-8'
               : ext === '.js'   ? 'application/javascript'
               : ext === '.css'  ? 'text/css'
               : ext === '.png'  ? 'image/png'
               : ext === '.svg'  ? 'image/svg+xml'
               : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n Demo corriendo en  http://localhost:${PORT}`);
  console.log(API_KEY ? ' IA REAL conectada (API key encontrada)\n' : ' MODO DEMO (sin API key — funciona igual)\n');
});
