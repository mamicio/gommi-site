import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir sitio estatico desde public/
app.use(express.static(join(__dirname, '..', 'public')));

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

// ── Google Sheets ───────────────────────────────────────

const SPREADSHEET_ID = '1JHg-WJusxoeDRm0lPFh7ZCXF50lOBx7X_6UP8lqoLI8';

async function registrarVentaEnSheets({ valorTotal, valorEnvio }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.log('  [Sheets] GOOGLE_SERVICE_ACCOUNT_KEY no configurada, omitiendo registro');
    return;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  const hoy = new Date();
  const fecha = `${hoy.getDate()}/${hoy.getMonth() + 1}/${String(hoy.getFullYear()).slice(2)}`;
  const valorNeto = valorTotal - valorEnvio;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Ingresos!A:F',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        fecha,                                           // A: Fecha
        valorNeto,                                       // B: Valor (sin envío)
        'Venta online',                                  // C: Concepto
        'Ingresos',                                      // D: Rubro
        'Sitio web',                                     // E: Vendedor
        `Envío: $${valorEnvio.toLocaleString('es-CO')}, Compra neta: $${valorNeto.toLocaleString('es-CO')}` // F: Observaciones
      ]],
    },
  });

  console.log(`  [Sheets] Venta registrada: $${valorNeto} (envío: $${valorEnvio})`);
}

// ── ePayco ──────────────────────────────────────────────

// Confirmación (servidor-a-servidor, POST desde ePayco)
app.post('/api/epayco/confirmacion', async (req, res) => {
  const data = req.body;
  console.log('\n[ePayco Confirmación]', JSON.stringify(data, null, 2));

  const refPayco = data.x_ref_payco;
  const estado = data.x_response;         // "Aceptada", "Rechazada", "Pendiente"
  const monto = Number(data.x_amount) || 0;
  const factura = data.x_id_invoice;

  console.log(`  Ref: ${refPayco}, Estado: ${estado}, Monto: $${monto}, Factura: ${factura}`);

  // Si el pago fue aceptado, registrar en Google Sheets
  if (estado === 'Aceptada') {
    try {
      // x_extra1 lo usaremos para enviar el valor del envío desde el checkout
      const valorEnvio = Number(data.x_extra1) || 0;
      await registrarVentaEnSheets({ valorTotal: monto, valorEnvio });
    } catch (err) {
      console.error('  [Sheets] Error registrando venta:', err.message);
    }
  }

  res.status(200).send('OK');
});

// Respuesta (redirect del cliente después de pagar)
app.get('/pago/resultado', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resultado del pago - Gommi</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Poppins', sans-serif; background: #f7f7f7; color: #2D3748; }
    .page { max-width: 600px; margin: 2rem auto; padding: 1rem; }
    .volver { color: #6B46C1; text-decoration: none; font-size: 0.9rem; }
    .volver:hover { text-decoration: underline; }
    .card {
      margin-top: 1.5rem; background: white; border-radius: 16px;
      padding: 2.5rem; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center;
    }
    .spinner {
      width: 40px; height: 40px; border: 4px solid #E2E8F0;
      border-top-color: #6B46C1; border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading p { color: #718096; margin-top: 1rem; }
    .icono { font-size: 3rem; margin-bottom: 0.5rem; }
    .titulo { font-size: 1.5rem; font-weight: 700; margin: 0.5rem 0; }
    .detalle { color: #718096; margin: 0.5rem 0; }
    .ref { font-size: 0.85rem; color: #A0AEC0; margin-top: 1rem; }
    .aceptada { color: #38A169; }
    .rechazada { color: #E53E3E; }
    .pendiente { color: #D69E2E; }
    .btn {
      display: inline-block; margin-top: 1.5rem; padding: 0.75rem 2rem;
      background: #6B46C1; color: white; border-radius: 8px;
      text-decoration: none; font-weight: 600;
    }
    .btn:hover { background: #553C9A; }
  </style>
</head>
<body>
  <div class="page">
    <a href="/" class="volver">&larr; Volver al inicio</a>
    <div class="card" id="resultado">
      <div class="loading" id="loading">
        <div class="spinner"></div>
        <p>Consultando estado del pago...</p>
      </div>
    </div>
  </div>
  <script>
    const el = document.getElementById('resultado');
    const ref = new URLSearchParams(location.search).get('ref_payco');
    if (!ref) {
      el.innerHTML = '<p class="icono">&#9888;&#65039;</p><p class="titulo">No se encontr\\u00f3 referencia de pago</p><a href="/" class="btn">Volver al inicio</a>';
    } else {
      fetch('https://secure.epayco.co/validation/v1/reference/' + ref)
        .then(r => r.json())
        .then(data => {
          const tx = data.data;
          const estado = (tx.x_response || '').toLowerCase();
          const monto = Number(tx.x_amount || 0).toLocaleString('es-CO');
          let icono = '&#9203;', clase = 'pendiente', titulo = 'Pago pendiente', msg = 'Tu pago est\\u00e1 siendo procesado.';
          if (estado === 'aceptada') { icono = '&#9989;'; clase = 'aceptada'; titulo = '\\u00a1Pago exitoso!'; msg = 'Tu pedido ha sido confirmado.'; }
          else if (estado === 'rechazada' || estado === 'fallida') { icono = '&#10060;'; clase = 'rechazada'; titulo = 'Pago rechazado'; msg = tx.x_response_reason_text || 'La transacci\\u00f3n no fue aprobada.'; }
          el.innerHTML = '<p class="icono">' + icono + '</p><p class="titulo ' + clase + '">' + titulo + '</p><p class="detalle">' + msg + '</p><p class="detalle">Monto: <strong>$' + monto + '</strong></p><p class="ref">Referencia ePayco: ' + ref + '</p><a href="/" class="btn">Volver al inicio</a>';
        })
        .catch(() => {
          el.innerHTML = '<p class="icono">&#9888;&#65039;</p><p class="titulo">Error consultando el pago</p><p class="detalle">Referencia: ' + ref + '</p><a href="/" class="btn">Volver al inicio</a>';
        });
    }
  </script>
</body>
</html>`);
});

// Fallback: cualquier ruta no-API sirve el index.html
app.get('/{*path}', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
import http from 'http';
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Gommi server en http://localhost:${PORT}`);
  console.log('  Sitio estatico: /public');
  console.log('  API: /api/ciudades, /api/cotizar');
});
