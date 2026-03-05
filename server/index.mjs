import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Servir sitio Astro compilado
app.use(express.static(join(__dirname, '..', 'dist')));

const API_BASE = 'https://www3.interrapidisimo.com';
const ORIGEN = 'MEDELLIN\\ANT\\COL';

// Caches
let localidadCache = null;   // nombre -> IdLocalidad
let ciudadesCache = null;    // { departamentos, data } para el frontend
let tokenCache = null;
let tokenExpiry = 0;

async function getToken() {
  if (tokenCache && Date.now() < tokenExpiry) return tokenCache;

  const res = await fetch(`${API_BASE}/ApiLogin/api/Autenticacion/GenerarTokenTemporal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  const data = await res.json();
  tokenCache = data.usuario.Data.Token;
  tokenExpiry = Date.now() + 5000;
  return tokenCache;
}

function getHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'IdAplicativoOrigen': '3',
    'IdCentroServicio': '1',
    'NombreCentroServicio': '1',
    'usuario': 'admin'
  };
}

async function loadLocalidades() {
  if (localidadCache) return;

  console.log('  Cargando localidades de Interrapidísimo...');
  const token = await getToken();
  const res = await fetch(
    `${API_BASE}/Apicontroller/api/ParametrosFramework/ObtenerLocalidadesNoPaisNoDepartamentoColombia`,
    { headers: getHeaders(token) }
  );

  const text = await res.text();
  let cities;
  try {
    cities = JSON.parse(text);
  } catch (e) {
    console.error('  Error parsing cities response:', text.substring(0, 200));
    throw new Error(`API localidades error: ${text.substring(0, 100)}`);
  }

  if (!Array.isArray(cities)) {
    throw new Error('API localidades: respuesta inesperada');
  }

  // Build ID lookup: "MEDELLIN\ANT\COL" -> "05001000"
  localidadCache = {};
  for (const city of cities) {
    localidadCache[city.Nombre] = city.IdLocalidad.trim();
  }

  // Build departamentos for frontend (only type "3" = municipalities)
  const departamentos = {};
  for (const city of cities) {
    if (city.IdTipoLocalidad !== '3') continue; // skip veredas, barrios, etc.

    const dep = city.NombreAncestroPGrado; // "ANTIOQUIA", "CUNDINAMARCA", etc.
    if (!dep) continue;

    if (!departamentos[dep]) departamentos[dep] = [];
    departamentos[dep].push({
      nombre: city.NombreCorto,
      codigo: city.Nombre
    });
  }

  // Sort cities within each department
  for (const dep of Object.keys(departamentos)) {
    departamentos[dep].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  ciudadesCache = {
    departamentos: Object.keys(departamentos).sort(),
    data: departamentos
  };

  console.log(`  Cache creado: ${Object.keys(localidadCache).length} localidades, ${ciudadesCache.departamentos.length} departamentos`);
}

// API: obtener departamentos y ciudades
app.get('/api/ciudades', async (req, res) => {
  try {
    await loadLocalidades();
    res.json(ciudadesCache);
  } catch (error) {
    console.error('Error cargando ciudades:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: cotizar envío
app.post('/api/cotizar', async (req, res) => {
  const { ciudadDestino, peso = 1, valorComercial = 45000, tipoEntrega = 1 } = req.body;

  if (!ciudadDestino) {
    return res.status(400).json({ error: 'Ciudad destino es requerida' });
  }

  const inicio = Date.now();

  try {
    console.log(`\nCotizando: ${ORIGEN} → ${ciudadDestino}`);

    await loadLocalidades();
    const origenId = localidadCache[ORIGEN];
    const destinoId = localidadCache[ciudadDestino];

    if (!origenId) {
      return res.status(400).json({ error: `Ciudad origen no encontrada: ${ORIGEN}` });
    }
    if (!destinoId) {
      return res.status(400).json({ error: `Ciudad destino no encontrada: ${ciudadDestino}` });
    }

    console.log(`  Origen ID: ${origenId}, Destino ID: ${destinoId}`);

    // Call cotizar API (with retry on auth failure)
    const url = `${API_BASE}/Apicontroller/api/AdmisionMensajeria/ResultadoListaCotizar/${origenId}/${destinoId}/${peso}/${valorComercial}/${tipoEntrega}`;

    let servicios;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        tokenCache = null;
        tokenExpiry = 0;
      }
      const token = await getToken();
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: getHeaders(token),
        body: ''
      });

      if (apiRes.ok) {
        servicios = await apiRes.json();
        break;
      }

      const errText = await apiRes.text();
      console.log(`  Intento ${attempt + 1} falló: ${apiRes.status} - ${errText.substring(0, 100)}`);
      if (attempt === 1) {
        throw new Error(`API error: ${apiRes.status} ${apiRes.statusText}`);
      }
    }
    const duracion = Date.now() - inicio;

    if (!Array.isArray(servicios) || servicios.length === 0) {
      console.log('  Sin servicios disponibles');
      return res.json({ ok: false, error: 'No hay servicios disponibles para esta ruta', duracionMs: duracion });
    }

    const resultados = servicios.map(s => {
      const valorTotal = Math.round(s.Precio.Valor + s.Precio.ValorPrimaSeguro);
      return {
        servicio: s.NombreServicio,
        valorFlete: s.Precio.Valor,
        valorSeguro: s.Precio.ValorPrimaSeguro,
        valorTotal,
        tiempoEntrega: s.TiempoEntrega,
        formasPago: s.FormaPagoServicio?.FormaPago?.map(f => f.Descripcion) || []
      };
    });

    const mensajeria = resultados.find(r => r.servicio.toLowerCase().includes('mensaj'));

    console.log(`  Servicios: ${resultados.map(r => `${r.servicio} $${r.valorTotal}`).join(', ')}`);
    console.log(`  Tiempo: ${duracion}ms`);

    res.json({
      ok: true,
      ciudadOrigen: ORIGEN,
      ciudadDestino,
      mensajeria: mensajeria || null,
      todosServicios: resultados,
      duracionMs: duracion
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message,
      duracionMs: Date.now() - inicio
    });
  }
});

// Fallback: cualquier ruta no-API sirve el sitio Astro
app.get('/{*path}', (req, res) => {
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
import http from 'http';
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Gommi server en http://localhost:${PORT}`);
  console.log('  Sitio estático: /dist');
  console.log('  API: /api/ciudades, /api/cotizar');
});
