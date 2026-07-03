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

// WhatsApp Cloud API
const WA_TOKEN     = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_VERIFY    = process.env.WHATSAPP_VERIFY_TOKEN || 'ozzie-verify';
const WA_BUSINESS  = process.env.WHATSAPP_BUSINESS || 'barber'; // which BIZ_FACTS entry this WhatsApp number represents
const waHistory = new Map(); // phone -> [{role, content}]

// Supabase (conversation history + client panel)
const SB_URL          = process.env.SUPABASE_URL || '';
const SB_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PANEL_TOKEN     = process.env.PANEL_TOKEN || 'ozzie-panel';

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

async function getOrCreateConversation(businessSlug, phone) {
  const businesses = await sbFetch(`businesses?slug=eq.${encodeURIComponent(businessSlug)}&select=id,bot_enabled,facts,name`);
  const business = businesses && businesses[0];
  if (!business) return null;

  const existing = await sbFetch(`conversations?business_id=eq.${business.id}&customer_phone=eq.${encodeURIComponent(phone)}&select=id,bot_enabled`);
  if (existing && existing[0]) return { business, conversation: existing[0] };

  const created = await sbFetch('conversations', {
    method: 'POST',
    body: { business_id: business.id, customer_phone: phone },
    prefer: 'return=representation'
  });
  return { business, conversation: created[0] };
}

function logMessage(conversationId, role, content) {
  return sbFetch('messages', { method: 'POST', body: { conversation_id: conversationId, role, content } }).catch(e => console.error('log message error:', e.message));
}

function saveBooking(conversationId, businessId, service, whenText, customerName) {
  return sbFetch('bookings', {
    method: 'POST',
    body: { conversation_id: conversationId, business_id: businessId, service, when_text: whenText, customer_name: customerName }
  }).catch(e => console.error('save booking error:', e.message));
}

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

function systemPrompt(business, lang) {
  return `Eres la persona que lleva el WhatsApp de este negocio:

${BIZ_FACTS[business] || BIZ_FACTS.barber}

Cómo escribes:
- REGLA DE IDIOMA (la más importante): responde SIEMPRE en el MISMO idioma en que te escribe el cliente en su último mensaje. Si te escribe en inglés, respondes en inglés. Si te escribe en español, en español. NUNCA cambies de idioma tú solo. Este negocio está en Vancouver (Canadá): POR DEFECTO todo es en INGLÉS. Si el mensaje NO tiene idioma claro (solo emoji, números, símbolos o un saludo ambiguo): responde en INGLÉS. Solo usa español si el cliente escribe claramente en español.
- Como una persona real del equipo, ocupada pero amable. Natural, cercano, cero corporativo.
- Mensajes MUY cortos, estilo WhatsApp real: 1-2 frases. A veces empieza en minúscula. Emoji solo de vez en cuando (máximo 1).
- Habla en voz de equipo: "abrimos"/"we're open", "te esperamos"/"see you then", "te lo miro"/"let me check".
- Varía las frases, nunca suenes a plantilla. Nada de listas ni formato.
- NUNCA digas que eres una IA, bot, asistente virtual o sistema automático. Y IGUAL de importante: nunca digas "no soy un bot" ni afirmes ser una persona — eso es mentir y está prohibido. Si te preguntan si eres un bot, NO respondas a la pregunta: ignórala con gracia y redirige, EN SU IDIOMA (ej. en inglés: "haha I'm right here to help — what do you need? 😄"; en español: "jaja tú dime qué necesitas y te lo miro ahora mismo 😄"). Ni sí, ni no, nunca.

Qué haces:
- Solo hablas de este negocio. Si preguntan otra cosa, redirige con amabilidad.
- Si el cliente quiere reservar necesitas SOLO estos 3 datos: (1) servicio o nº de personas, (2) día y hora, (3) nombre. Pide UNA cosa por mensaje, y solo las que falten (si el cliente ya dio alguna, no la vuelvas a pedir).
- NO pidas datos extra (ni dine-in/takeout, ni "qué viernes", ni teléfono, ni nada más). Si algo es ambiguo como "viernes", asume el próximo que viene, no preguntes.
- EN CUANTO tengas esos 3 datos, CONFIRMA YA en el mismo mensaje (frase corta y cálida) y añade al FINAL esta línea exacta, sin más preguntas:
BOOKING_CONFIRMED|<servicio o personas>|<día y hora>|<nombre>
- REGLA ANTI-INVENCIÓN (crítica): SOLO puedes afirmar datos que estén escritos arriba (horario, dirección, precios listados). CUALQUIER otra cosa que no esté arriba —opciones veganas/sin gluten, parking, métodos de pago, descuentos, qué seguros aceptáis, promociones, servicios extra— NO la afirmes ni la niegues con detalles inventados. En su lugar di con naturalidad que se lo confirmas, VARIANDO la frase cada vez (nunca repitas la misma palabra por palabra): p.ej. "let me check that for you and get back in a sec", "not 100% sure — I'll confirm with the team and let you know", "good q! I'll double-check and text you back", etc. En español igual, variando. Es preferible decir "te lo confirmo" antes que inventar. Inventar un dato falso es el peor error posible.`;
}

function sendWhatsAppMessage(to, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    });
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${WA_PHONE_ID}/messages`,
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

async function handleIncomingWhatsApp(from, text) {
  const history = waHistory.get(from) || [];
  history.push({ role: 'user', content: text });
  const clean = history.slice(-14);

  let ctx = null;
  try {
    ctx = await getOrCreateConversation(WA_BUSINESS, from);
  } catch (e) {
    console.error('Supabase lookup error:', e.message);
  }
  if (ctx) logMessage(ctx.conversation.id, 'user', text);

  const botOff = ctx && (ctx.business.bot_enabled === false || ctx.conversation.bot_enabled === false);
  if (botOff) return; // human has taken over this chat, or bot paused for this business

  try {
    const r = await callAnthropic({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt(WA_BUSINESS, 'en'),
      messages: clean
    });
    let reply = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const booking = reply.match(/BOOKING_CONFIRMED\|([^|]*)\|([^|]*)\|([^\n]*)/);
    reply = reply.replace(/BOOKING_CONFIRMED\|[^\n]*/g, '').trim();
    history.push({ role: 'assistant', content: reply });
    waHistory.set(from, history);
    if (ctx) {
      logMessage(ctx.conversation.id, 'assistant', reply);
      if (booking) saveBooking(ctx.conversation.id, ctx.business.id, booking[1].trim(), booking[2].trim(), booking[3].trim());
    }
    await sendWhatsAppMessage(from, reply);
  } catch (e) {
    console.error('WhatsApp handling error:', e.message);
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

  // Incoming WhatsApp messages
  if (req.method === 'POST' && pathname === '/webhook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200); res.end('EVENT_RECEIVED'); // ack immediately, Meta requires <5s
      try {
        const payload = JSON.parse(body);
        const changes = payload.entry?.[0]?.changes?.[0]?.value;
        const msg = changes?.messages?.[0];
        if (msg && msg.type === 'text') {
          handleIncomingWhatsApp(msg.from, msg.text.body);
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
        const r = await callAnthropic({
          model: MODEL,
          max_tokens: 400,
          system: systemPrompt(business, lang),
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
