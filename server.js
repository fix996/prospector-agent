require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Constants
const SERP_API_KEY = process.env.SERP_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Utility: Generate unique ID
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Utility: Check if a URL is valid
function isValidUrl(url) {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Utility: Verify website status (responsive, loads correctly)
async function verifyWebsite(url) {
  try {
    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      maxRedirects: 3,
      validateStatus: () => true
    });

    if (response.status >= 400) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const $ = cheerio.load(response.data);
    const hasViewport = $('meta[name="viewport"]').length > 0;

    if (!hasViewport) {
      return { ok: false, reason: 'no_viewport' };
    }

    return { ok: true };
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: error.code || 'connection_error' };
  }
}

// Search Google Maps via SerpAPI
async function searchMapsSerpApi(rubro, zona, cantidad) {
  try {
    const url = 'https://serpapi.com/search';

    const response = await axios.get(url, {
      params: {
        engine: 'google_maps',
        q: `${rubro} cerca de ${zona} Argentina`,
        api_key: SERP_API_KEY,
        hl: 'es',
        num: cantidad
      },
      timeout: 10000
    });

    const results = response.data.results || [];
    return results.slice(0, cantidad).map(place => ({
      id: generateId(),
      nombre: place.title || place.name || 'Negocio encontrado',
      zona: zona,
      rubro: rubro,
      telefono: place.phone || null,
      web_url: place.website || null,
      estado: place.website ? 'pendiente_verificacion' : 'sin_web',
      detalle: place.address || '',
      fuente: 'maps',
      maps_url: place.gps_coordinates ? `https://www.google.com/maps/search/?q=${place.gps_coordinates.latitude},${place.gps_coordinates.longitude}` : null
    }));
  } catch (error) {
    console.error('Error buscando en Google Maps (SerpAPI):', error.message);
    return [];
  }
}

// Search Web via SerpAPI
async function searchWebSerpApi(rubro, zona, cantidad) {
  try {
    const url = 'https://serpapi.com/search';

    const response = await axios.get(url, {
      params: {
        engine: 'google',
        q: `${rubro} ${zona} Argentina`,
        api_key: SERP_API_KEY,
        location: 'Argentina',
        hl: 'es',
        gl: 'ar',
        num: cantidad
      },
      timeout: 10000
    });

    const results = response.data.organic_results || [];
    return results.slice(0, cantidad).map(result => ({
      id: generateId(),
      nombre: result.title || result.site_name || 'Negocio encontrado',
      zona: zona,
      rubro: rubro,
      telefono: null,
      web_url: result.link || null,
      estado: 'pendiente_verificacion',
      detalle: result.snippet || '',
      fuente: 'web',
      maps_url: null
    }));
  } catch (error) {
    console.error('Error buscando en SerpAPI Web:', error.message);
    return [];
  }
}

// POST /api/buscar
app.post('/api/buscar', async (req, res) => {
  try {
    const { rubro, zona, cantidad = 20 } = req.body;

    if (!rubro || !zona) {
      return res.status(400).json({ error: 'Se requieren los campos "rubro" y "zona"' });
    }

    // Execute both searches in parallel using SerpAPI
    const [mapsResults, webResults] = await Promise.all([
      searchMapsSerpApi(rubro, zona, cantidad),
      searchWebSerpApi(rubro, zona, cantidad)
    ]);

    // Combine results, avoiding duplicates by web_url
    const seenUrls = new Set();
    const combinedResults = [];

    // Add Maps results first
    for (const result of mapsResults) {
      if (result.web_url) {
        seenUrls.add(result.web_url);
      }
      combinedResults.push(result);
    }

    // Add Web results that aren't already in Maps
    for (const result of webResults) {
      if (!result.web_url || !seenUrls.has(result.web_url)) {
        combinedResults.push(result);
      }
    }

    // Verify websites in parallel
    const verificationPromises = combinedResults.map(async (result) => {
      if (!result.web_url) {
        return { ...result, estado: 'sin_web' };
      }

      const verification = await verifyWebsite(result.web_url);

      if (!verification.ok) {
        return {
          ...result,
          estado: 'web_vieja',
          detalle: `${result.detalle} [${verification.reason}]`
        };
      }

      return { ...result, estado: 'tiene_web' };
    });

    const finalResults = await Promise.all(verificationPromises);

    // Mark source for combined results
    const resultsWithSource = finalResults.map(r => ({
      ...r,
      fuente: r.fuente === 'maps' && seenUrls.has(r.web_url) ? 'ambos' : r.fuente
    }));

    res.json(resultsWithSource);
  } catch (error) {
    console.error('Error en /api/buscar:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/mensaje
app.post('/api/mensaje', async (req, res) => {
  try {
    const { lead, tipo = 'inicial' } = req.body;

    if (!lead || !lead.nombre) {
      return res.status(400).json({ error: 'Se requiere un lead con al menos el nombre' });
    }

    const systemPrompt = `Sos un asistente de prospección comercial para "Mi Negocio Web", una agencia web argentina que ayuda a PyMEs a tener presencia online profesional.

Tu tarea es redactar mensajes de contacto para dueños de negocios.

Características del tono:
- Cercano y profesional, sin ser formal en exceso
- En español argentino (usá "vos", no "tú")
- Breve y directo al punto
- Enfocado en el valor que aportamos, no en características técnicas
- Sin sonar a venta agresiva

Estructura del mensaje:
1. Saludo personalizado con el nombre del negocio
2. Mencionar algo específico de su situación (rubro, zona, o si su web necesita actualización)
3. Propuesta de valor clara
4. Llamado a la acción suave (ofrecer una charla sin cargo, no "comprar ya")

Servicios de Mi Negocio Web:
- Diseño de páginas web modernas y responsive
- Optimización para móviles
- Presencia en Google Maps
- Mejora de velocidad y SEO básico

El mensaje debe ser para enviar por WhatsApp o email.`;

    const userPrompt = `Escribí un mensaje de prospección para:

Negocio: ${lead.nombre}
Rubro: ${lead.rubro || 'No especificado'}
Zona: ${lead.zona || 'No especificada'}
Teléfono: ${lead.telefono || 'No disponible'}
Estado web: ${lead.estado || 'No verificado'}
${lead.web_url ? `Web actual: ${lead.web_url}` : ''}

Tipo de mensaje: ${tipo === 'seguimiento' ? 'Seguimiento (ya hubo contacto previo)' : 'Contacto inicial'}

${lead.estado === 'sin_web' ? 'Este negocio NO tiene página web.' : ''}
${lead.estado === 'web_vieja' ? 'Este negocio tiene una web vieja o que no es responsive.' : ''}
${lead.estado === 'tiene_web' ? 'Este negocio ya tiene web moderna, pero podríamos ofrecer mejoras o rediseño.' : ''}

Escribí el mensaje completo, listo para copiar y pegar.`;

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 500
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        timeout: 15000
      }
    );

    const mensaje = groqResponse.data.choices[0].message.content;

    res.json({
      lead,
      tipo,
      mensaje
    });
  } catch (error) {
    console.error('Error en /api/mensaje:', error.message);

    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'API key de Groq inválida' });
    }

    res.status(500).json({ error: 'Error generando el mensaje' });
  }
});

// POST /api/respuesta
app.post('/api/respuesta', async (req, res) => {
  try {
    const { lead, mensaje_enviado, respuesta_cliente } = req.body;

    if (!lead || !lead.nombre || !respuesta_cliente) {
      return res.status(400).json({ error: 'Se requieren el lead y la respuesta del cliente' });
    }

    const systemPrompt = `Sos un asistente de prospección comercial para "Mi Negocio Web", una agencia web argentina.

Tu tarea es redactar respuestas a clientes que ya recibieron un mensaje inicial y respondieron.

Características del tono:
- Cercano y profesional, sin ser formal en exceso
- En español argentino (usá "vos", no "tú")
- Breve y directo al punto
- Enfocado en el valor que aportamos
- Sin sonar a venta agresiva

Objetivo:
- Responder dudas o objeciones del cliente
- Mantener la conversación fluida
- Proponer próximos pasos concretos (una llamada, reunión, demo)

Servicios de Mi Negocio Web:
- Diseño de páginas web modernas y responsive
- Optimización para móviles
- Presencia en Google Maps
- Mejora de velocidad y SEO básico`;

    const userPrompt = `El cliente respondió esto:

"${respuesta_cliente}"

Contexto del lead:
- Negocio: ${lead.nombre}
- Rubro: ${lead.rubro || 'No especificado'}
- Zona: ${lead.zona || 'No especificada'}
- Estado web: ${lead.estado || 'No verificado'}

Mensaje que le enviaste antes:
${mensaje_enviado || 'No disponible'}

Escribí una respuesta completa, lista para copiar y pegar.`;

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 500
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        timeout: 15000
      }
    );

    const respuesta = groqResponse.data.choices[0].message.content;

    res.json({
      respuesta
    });
  } catch (error) {
    console.error('Error en /api/respuesta:', error.message);

    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'API key de Groq inválida' });
    }

    res.status(500).json({ error: 'Error generando la respuesta' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Prospector Agent corriendo en puerto ${PORT}`);
  console.log(`📍 Mi Negocio Web - Agencia Web Argentina`);
});
