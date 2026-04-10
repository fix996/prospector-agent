# Prospector Agent

Agente de prospección de clientes para **Mi Negocio Web**.

## Instalación

```bash
npm install
```

## Configuración

Copiar `.env.example` a `.env` y completar las API keys:

```bash
PORT=3000
GOOGLE_MAPS_API_KEY=tu_key_aqui
SERP_API_KEY=tu_key_aqui
ANTHROPIC_API_KEY=tu_key_aqui
```

## Ejecución

```bash
npm start
```

## Endpoints

### POST /api/buscar

Busca negocios por rubro y zona.

**Body:**
```json
{
  "rubro": "peluqueria",
  "zona": "Lujan Buenos Aires",
  "cantidad": 20
}
```

**Respuesta:** Array de leads con estado de su web.

### POST /api/mensaje

Genera mensaje de prospección con IA.

**Body:**
```json
{
  "lead": {
    "nombre": "Peluquería Style",
    "rubro": "peluqueria",
    "zona": "Luján",
    "estado": "sin_web"
  },
  "tipo": "inicial"
}
```

**Respuesta:** Mensaje generado por Claude.

### GET /api/health

Check de salud del servidor.
