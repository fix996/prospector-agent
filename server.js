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

// Check if URL is a social media, maps, or directory URL (not a real business website)
function isSocialOrMapsUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();

  // Redes sociales
  const socialDomains = [
    'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com',
    'linkedin.com', 'pinterest.com', 'youtube.com'
  ];

  // Maps y directorios
  const mapsAndDirectories = [
    'google.com/maps', 'maps.google.com', 'maps.app.goo.gl',
    'yelp.com', 'tripadvisor.com', 'paginasamarillas.com',
    'mercadiario.com', 'guias.ar', 'cylex.com.ar',
    'hotfrog.com.ar', 'tuempresa.com.ar', 'argentinacompra.com',
    'directorios', 'directorio', 'listado', 'lista', 'catalogo'
  ];

  // Verificar redes sociales
  for (const domain of socialDomains) {
    if (lower.includes(domain)) return true;
  }

  // Verificar maps y directorios
  for (const item of mapsAndDirectories) {
    if (lower.includes(item)) return true;
  }

  // Verificar si es un subdominio de google (ej: google.com/maps/...)
  if (lower.includes('google') && !lower.includes('google.com.ar') && !lower.includes('google.com')) {
    return true;
  }

  // Patrones de URLs que parecen directorios (muchos negocios en una sola URL)
  const directoryPatterns = [
    /negocios/i, /shops/i, /stores/i, /empresas/i, /comercios/i,
    /resultados/i, /search/i, /q=/i  // Parámetros de búsqueda
  ];

  for (const pattern of directoryPatterns) {
    if (pattern.test(url)) return true;
  }

  return false;
}

// Extract Instagram URL from place data
function extractInstagramUrl(place) {
  // Check if there's a direct Instagram link in the place data
  if (place.instagram_url) return place.instagram_url;
  // Sometimes Instagram link is in the website field
  if (place.website && place.website.toLowerCase().includes('instagram.com')) {
    return place.website;
  }
  return null;
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
        num: Math.min(cantidad, 50) // SerpAPI max 50 para Maps
      },
      timeout: 10000
    });

    const results = response.data.results || [];
    return results.slice(0, cantidad).map(place => {
      const website = place.website;

      // Verificar si el website es red social o maps
      const websiteIsSocial = isSocialOrMapsUrl(website);

      // Extraer Instagram: puede venir en campo separado o ser el propio website
      let instagramUrl = extractInstagramUrl(place);
      if (!instagramUrl && website && website.toLowerCase().includes('instagram.com')) {
        instagramUrl = website;
      }

      // Extraer Facebook
      let facebookUrl = null;
      if (website && website.toLowerCase().includes('facebook.com')) {
        facebookUrl = website;
      }

      // Tiene web real solo si tiene website Y NO es red social
      const hasRealWeb = website && !websiteIsSocial;

      // Solo tiene Instagram si no tiene web real y tiene Instagram (en cualquier formato)
      const hasOnlyInstagram = !hasRealWeb && !!instagramUrl;

      return {
        id: generateId(),
        nombre: place.title || place.name || 'Negocio encontrado',
        zona: zona,
        rubro: rubro,
        telefono: place.phone || null,
        web_url: hasRealWeb ? website : null,
        instagram_url: instagramUrl,
        facebook_url: facebookUrl,
        estado: hasRealWeb ? 'pendiente_verificacion' : 'sin_web',
        solo_instagram: hasOnlyInstagram,
        detalle: place.address || '',
        fuente: 'maps',
        maps_url: place.gps_coordinates ? `https://www.google.com/maps/search/?q=${place.gps_coordinates.latitude},${place.gps_coordinates.longitude}` : null
      };
    });
  } catch (error) {
    console.error('Error buscando en Google Maps (SerpAPI):', error.message);
    return [];
  }
}

// Search Web via SerpAPI - busca negocios que pueden no tener web propia
async function searchWebSerpApi(rubro, zona, cantidad) {
  try {
    const url = 'https://serpapi.com/search';

    // Búsqueda general para encontrar negocios en redes sociales y directorios
    const queries = [
      `site:instagram.com "${rubro}" "${zona}"`,
      `site:facebook.com "${rubro}" "${zona}" Argentina`,
      `"${rubro}" "${zona}" contacto`,
      `"${rubro}" "${zona}" telefono`
    ];

    const allResults = [];

    // Ejecutar múltiples búsquedas para tener más resultados
    for (const query of queries) {
      try {
        const response = await axios.get(url, {
          params: {
            engine: 'google',
            q: query,
            api_key: SERP_API_KEY,
            location: 'Argentina',
            hl: 'es',
            gl: 'ar',
            num: Math.min(Math.ceil(cantidad / queries.length), 50)
          },
          timeout: 10000
        });

        const results = response.data.organic_results || [];
        for (const result of results) {
          const link = result.link || '';

          // Saltar si es un directorio grande o mapa
          if (isSocialOrMapsUrl(link) && !link.includes('instagram.com') && !link.includes('facebook.com')) {
            continue;
          }

          allResults.push({
            id: generateId(),
            nombre: result.title || result.site_name || 'Negocio encontrado',
            zona: zona,
            rubro: rubro,
            telefono: null,
            web_url: null,
            instagram_url: link.includes('instagram.com') ? link : null,
            facebook_url: link.includes('facebook.com') ? link : null,
            estado: 'sin_web',
            solo_instagram: link.includes('instagram.com') || link.includes('facebook.com'),
            detalle: result.snippet || '',
            fuente: 'web',
            maps_url: null
          });
        }
      } catch (e) {
        console.warn(`Error en búsqueda "${query}":`, e.message);
      }
    }

    // Eliminar duplicados por nombre
    const seen = new Set();
    const uniqueResults = [];
    for (const result of allResults) {
      const key = (result.nombre + result.zona).toLowerCase();
      if (!seen.has(key) && uniqueResults.length < cantidad) {
        seen.add(key);
        uniqueResults.push(result);
      }
    }

    return uniqueResults;
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

    // Pedir 3 veces más resultados para tener margen después de filtrar duplicados y webs falsas
    const searchCantidad = Math.ceil(cantidad * 3);

    // Execute both searches in parallel using SerpAPI
    const [mapsResults, webResults] = await Promise.all([
      searchMapsSerpApi(rubro, zona, searchCantidad),
      searchWebSerpApi(rubro, zona, searchCantidad)
    ]);

    console.log(`Búsqueda: ${mapsResults.length} resultados de Maps, ${webResults.length} resultados de Web`);

    // Combine results: web results (Instagram profiles) first, then maps
    const combinedResults = [];
    const seenNames = new Set();

    // Add Web results first (Instagram profiles - businesses without real website)
    for (const result of webResults) {
      const key = (result.nombre + result.zona).toLowerCase();
      if (!seenNames.has(key) && combinedResults.length < cantidad) {
        seenNames.add(key);
        combinedResults.push(result);
      }
    }

    // Add Maps results until we reach the desired cantidad
    for (const result of mapsResults) {
      if (combinedResults.length >= cantidad) break;
      const key = (result.nombre + result.zona).toLowerCase();
      if (!seenNames.has(key)) {
        seenNames.add(key);
        combinedResults.push(result);
      }
    }

    console.log(`Total combinados: ${combinedResults.length} negocios`);

    // Verify websites in parallel (only for real websites, not social media)
    const verificationPromises = combinedResults.map(async (result) => {
      // If no web_url or it's a social media URL, mark as sin_web without fetching
      if (!result.web_url || isSocialOrMapsUrl(result.web_url)) {
        return {
          ...result,
          estado: 'sin_web',
          web_url: null
        };
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

    res.json(finalResults);
  } catch (error) {
    console.error('Error en /api/buscar:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/mensaje
app.post('/api/mensaje', async (req, res) => {
  try {
    const { lead, tipo = 'inicial', instrucciones_adicionales } = req.body;

    if (!lead || !lead.nombre) {
      return res.status(400).json({ error: 'Se requiere un lead con al menos el nombre' });
    }

    const systemPrompt = `Sos el asistente de ventas de Mi Negocio Web, agencia web argentina de la zona oeste del GBA (Luján, Moreno, Merlo, etc).

PRECIOS REALES:
- Plan Básico: $40.000 a $100.000 + dominio aparte. Incluye: base de datos simple, seguridad básica, personalización básica.
- Plan Pro: $250.000 a $350.000 + hosting incluido. Incluye: dominio, hosting, Cloudflare, seguridad mejorada, panel admin PRO.
- Plan Premium: $400.000 a $550.000 + soporte prioritario. Incluye: hasta 4 dominios, 100GB NVMe, catálogo de productos, SEO y estadísticas.

REGLAS ESTRICTAS (NO NEGOCIABLES):
1. DEMO GRATIS: SIEMPRE mencioná la demo gratuita como gancho principal en TODOS los mensajes. Es tu herramienta de venta más importante.
2. Mensajes MUY cortos: máximo 4 líneas, nunca más
3. Castellano argentino informal, tuteo siempre
4. Nunca usar: 'potenciar', 'impulsar', 'presencia digital', 'mundo digital', 'llevar al siguiente nivel'
5. Cuando pregunten precio, dar los precios reales en pesos argentinos
6. Nunca proponer llamadas ni reuniones, solo ofrecer la demo gratis
7. Terminar siempre con UNA sola pregunta corta
8. Si el negocio solo tiene Instagram, mencionar que una web propia les da más credibilidad que Instagram

JERARQUÍA DE INSTRUCCIONES:
- Las INSTRUCCIONES ADICIONALES del usuario tienen PRIORIDAD ABSOLUTA sobre todas las reglas anteriores
- Si el usuario te pide ser más directo, corto, formal, etc. HACÉLE CASO SIEMPRE
- Las instrucciones del usuario MODIFICAN o ANULAN las reglas de arriba cuando hay conflicto
- NUNCA ignores las instrucciones específicas del usuario

TU OBJETIVO: Conseguir que el cliente acepte la demo gratuita. Mencionála en cada mensaje.` + (instrucciones_adicionales ? `\n\nINSTRUCCIONES ADICIONALES DEL USUARIO (PRIORIDAD MÁXIMA - HACÉLES CASO SIEMPRE):\n${instrucciones_adicionales}` : '');

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
    const { lead, mensaje_enviado, respuesta_cliente, instrucciones_adicionales } = req.body;

    if (!lead || !lead.nombre || !respuesta_cliente) {
      return res.status(400).json({ error: 'Se requieren el lead y la respuesta del cliente' });
    }

    const systemPrompt = `Sos el asistente de ventas de Mi Negocio Web, agencia web argentina de la zona oeste del GBA (Luján, Moreno, Merlo, etc).

PRECIOS REALES:
- Plan Básico: $40.000 a $100.000 + dominio aparte. Incluye: base de datos simple, seguridad básica, personalización básica.
- Plan Pro: $250.000 a $350.000 + hosting incluido. Incluye: dominio, hosting, Cloudflare, seguridad mejorada, panel admin PRO.
- Plan Premium: $400.000 a $550.000 + soporte prioritario. Incluye: hasta 4 dominios, 100GB NVMe, catálogo de productos, SEO y estadísticas.

REGLAS ESTRICTAS (NO NEGOCIABLES):
1. DEMO GRATIS: SIEMPRE mencioná la demo gratuita como gancho principal en TODOS los mensajes. Es tu herramienta de venta más importante.
2. Mensajes MUY cortos: máximo 4 líneas, nunca más
3. Castellano argentino informal, tuteo siempre
4. Nunca usar: 'potenciar', 'impulsar', 'presencia digital', 'mundo digital', 'llevar al siguiente nivel'
5. Cuando pregunten precio, dar los precios reales en pesos argentinos
6. Nunca proponer llamadas ni reuniones, solo ofrecer la demo gratis
7. Terminar siempre con UNA sola pregunta corta
8. Si el negocio solo tiene Instagram, mencionar que una web propia les da más credibilidad que Instagram

JERARQUÍA DE INSTRUCCIONES:
- Las INSTRUCCIONES ADICIONALES del usuario tienen PRIORIDAD ABSOLUTA sobre todas las reglas anteriores
- Si el usuario te pide ser más directo, corto, formal, etc. HACÉLE CASO SIEMPRE
- Las instrucciones del usuario MODIFICAN o ANULAN las reglas de arriba cuando hay conflicto
- NUNCA ignores las instrucciones específicas del usuario

TU OBJETIVO: Conseguir que el cliente acepte la demo gratuita. Mencionála en cada mensaje.` + (instrucciones_adicionales ? `\n\nINSTRUCCIONES ADICIONALES DEL USUARIO (PRIORIDAD MÁXIMA - HACÉLES CASO SIEMPRE):\n${instrucciones_adicionales}` : '');

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
