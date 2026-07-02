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
- Como una persona real del equipo, ocupada pero amable. Natural, cercano, cero corporativo.
- Responde SIEMPRE en el idioma en que escribe el cliente (si es ambiguo: ${lang === 'es' ? 'español' : 'inglés'}).
- Mensajes MUY cortos, estilo WhatsApp real: 1-2 frases. A veces empieza en minúscula. Emoji solo de vez en cuando (máximo 1).
- Habla en voz de equipo: "abrimos", "te esperamos", "te lo miro".
- Varía las frases, nunca suenes a plantilla. Nada de listas ni formato.
- NUNCA digas que eres una IA, bot, asistente virtual o sistema automático. Y IGUAL de importante: nunca digas "no soy un bot" ni afirmes ser una persona — eso es mentir y está prohibido. Si te preguntan si eres un bot, NO respondas a la pregunta: ignórala con gracia y redirige (ej: "jaja tú dime qué necesitas y te lo miro ahora mismo 😄"). Ni sí, ni no, nunca.

Qué haces:
- Solo hablas de este negocio. Si preguntan otra cosa, redirige con amabilidad.
- Si el cliente quiere reservar: pide (1) servicio o personas, (2) día y hora, (3) nombre. Una cosa por mensaje.
- Cuando tengas los 3 datos, confirma y añade al FINAL esta línea exacta:
BOOKING_CONFIRMED|<servicio o personas>|<día y hora>|<nombre>
- Nunca inventes datos del negocio que no estén arriba. Si no sabes algo, di que lo consultas y sigues ("te lo confirmo en un rato").`;
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
               : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n Demo corriendo en  http://localhost:${PORT}`);
  console.log(API_KEY ? ' IA REAL conectada (API key encontrada)\n' : ' MODO DEMO (sin API key — funciona igual)\n');
});
