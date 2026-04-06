import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import XLSX from "xlsx";
import fs from "fs";
import { pool } from "./db.js";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ dest: "uploads/" });

async function enviarWhatsAppOTP(telefono, codigo) {
  let destino = String(telefono || "").replace(/\D/g, "");

  if (!destino) {
    throw new Error("Teléfono vacío o inválido");
  }

  if (destino.startsWith("0")) {
    destino = destino.replace(/^0+/, "");
  }

  if (!destino.startsWith("57")) {
    destino = `57${destino}`;
  }

  const mensaje = `POLICÍA NACIONAL DE COLOMBIA

Sistema Control de Partes

Su código de verificación es: ${codigo}

Vigencia: 5 minutos
No compartir este código.`;

  const res = await fetch(process.env.WHATSAPP_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      token: process.env.WHATSAPP_API_TOKEN,
      to: destino,
      body: mensaje,
      priority: 10
    })
  });

  const data = await res.json().catch(() => ({}));

  console.log("WHATSAPP STATUS:", res.status);
  console.log("WHATSAPP DESTINO:", destino);
  console.log("RESPUESTA WHATSAPP:", data);

  if (!res.ok) {
    throw new Error(data?.message || "Error HTTP enviando WhatsApp");
  }

  if (
    data?.sent === false ||
    data?.error ||
    data?.message === "invalid number" ||
    data?.message === "invalid phone"
  ) {
    throw new Error(data?.message || "UltraMsg no confirmó el envío");
  }

  return data;
}

function obtenerPartesFechaBogota() {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false
  }).formatToParts(new Date());

  const get = (type) => partes.find(p => p.type === type)?.value || "";

  return {
    year: parseInt(get("year") || "0", 10),
    month: parseInt(get("month") || "0", 10),
    day: parseInt(get("day") || "0", 10),
    hour: parseInt(get("hour") || "0", 10),
    minute: parseInt(get("minute") || "0", 10),
    weekday: get("weekday")
  };
}

function obtenerFechaBogotaSQL() {
  const { year, month, day } = obtenerPartesFechaBogota();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function obtenerFechaTextoBogota() {
  const fecha = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const hora = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());

  return `${fecha.replace(",", "")} ${hora}`;
}

function validarHorarioParte() {
  const ahora = obtenerPartesFechaBogota();
  const total = ahora.hour * 60 + ahora.minute;
  const esFinDeSemana = ahora.weekday === "Sat" || ahora.weekday === "Sun";

  let tipo = null;
  let estado = "bloqueado";
  let mensaje = "⛔ Fuera del horario permitido para generar parte";
  let esMediodia = false;
  let extemporaneo = false;

  // Mediodía: solo novedades
  if (total >= (11 * 60 + 30) && total < (12 * 60 + 30)) {
    return {
      tipo: null,
      estado: "mediodia",
      mensaje: "⛔ En esta franja solo se pueden registrar novedades al mediodía",
      esMediodia: true,
      extemporaneo: false,
      esFinDeSemana
    };
  }

  if (!esFinDeSemana) {
    // Mañana normal
    if (total >= (4 * 60) && total <= (7 * 60 + 15)) {
      return {
        tipo: "mañana",
        estado: "permitido",
        mensaje: "OK",
        esMediodia: false,
        extemporaneo: false,
        esFinDeSemana
      };
    }

    // Mañana extemporánea
    if (total > (7 * 60 + 15) && total <= (8 * 60)) {
      return {
        tipo: "mañana",
        estado: "extraordinario",
        mensaje: "⚠️ Parte extraordinario de mañana",
        esMediodia: false,
        extemporaneo: true,
        esFinDeSemana
      };
    }

    // Noche normal
    if (total >= (17 * 60 + 30) && total <= (18 * 60 + 30)) {
      return {
        tipo: "noche",
        estado: "permitido",
        mensaje: "OK",
        esMediodia: false,
        extemporaneo: false,
        esFinDeSemana
      };
    }
  } else {
    // Fin de semana
    if (total >= (4 * 60) && total <= (8 * 60 + 15)) {
      return {
        tipo: "mañana",
        estado: "permitido",
        mensaje: "OK",
        esMediodia: false,
        extemporaneo: false,
        esFinDeSemana
      };
    }

    if (total >= (17 * 60 + 30) && total <= (18 * 60 + 30)) {
      return {
        tipo: "noche",
        estado: "permitido",
        mensaje: "OK",
        esMediodia: false,
        extemporaneo: false,
        esFinDeSemana
      };
    }
  }

  return { tipo, estado, mensaje, esMediodia, extemporaneo, esFinDeSemana };
}

function normalizarArrayValores(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map(v => String(v || "").trim())
    .filter(Boolean);
}

function esGradoOficial(grado = "") {
  const limpio = String(grado).toUpperCase().trim().replace(/\s+/g, "");
  const gradosOficiales = ["CR", "TC", "MY", "CT", "TE", "ST", "OFICIAL"];
  return gradosOficiales.includes(limpio) || limpio.includes("OFICIAL");
}

function construirOrdenGradoSQL(alias = "") {
  const pref = alias ? `${alias}.` : "";
  return `
    CASE UPPER(${pref}grado)
      WHEN 'CR' THEN 1
      WHEN 'TC' THEN 2
      WHEN 'MY' THEN 3
      WHEN 'CT' THEN 4
      WHEN 'TE' THEN 5
      WHEN 'ST' THEN 6
      WHEN 'CM' THEN 7
      WHEN 'SC' THEN 8
      WHEN 'IJ' THEN 9
      WHEN 'IT' THEN 10
      WHEN 'SI' THEN 11
      WHEN 'PT' THEN 12
      WHEN 'PP' THEN 13
      WHEN 'AUX' THEN 14
      ELSE 99
    END
  `;
}

function obtenerGrupoPorGrado(grado = "") {
  const g = String(grado || "").toUpperCase().trim();

  if (["CR", "TC", "MY", "CT", "TE", "ST"].includes(g)) return "OFICIALES";
  if (["CM", "SC", "IJ", "IT", "SI"].includes(g)) return "EJECUTIVO";
  if (["PT", "PP"].includes(g)) return "PATRULLEROS";
  if (["AUX"].includes(g)) return "AUXILIARES";
  return "OTROS";
}

function obtenerNivelJerarquico(grado = "") {
  const g = String(grado || "").toUpperCase().trim();

  if (["CR", "TC", "MY", "CT", "TE", "ST"].includes(g)) return "OFICIAL";
  if (["CM", "SC", "IJ", "IT", "SI"].includes(g)) return "EJECUTIVO";
  if (["PT", "PP"].includes(g)) return "PATRULLERO";
  if (["AUX"].includes(g)) return "AUXILIAR";

  return "OTRO";
}

function contarGrupoLista(lista) {
  return {
    oficiales: lista.filter(p => ["CR", "TC", "MY", "CT", "TE", "ST"].includes((p.grado || "").toUpperCase())).length,
    ejecutivo: lista.filter(p => ["CM", "SC", "IJ", "IT", "SI"].includes((p.grado || "").toUpperCase())).length,
    patrulleros: lista.filter(p => ["PT", "PP"].includes((p.grado || "").toUpperCase())).length,
    auxiliares: lista.filter(p => ["AUX"].includes((p.grado || "").toUpperCase())).length
  };
}

function formatoConteoGrupo(c) {
  return `${c.oficiales}-${c.ejecutivo}-${c.patrulleros}-${c.auxiliares}`;
}

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Ruta principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Prueba simple
app.get("/test", (req, res) => {
  res.send("FUNCIONA");
});

// Prueba de base de datos
app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS hora");
    res.json({
      ok: true,
      db: true,
      hora: result.rows[0].hora
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// PARTES
// =========================
app.post("/partes", async (req, res) => {
  const {
    tipo,
    unidad,
    subunidad,
    estacion,
    grado_responsable,
    nombre_responsable,
    cedula_responsable,
    telefono_responsable,
    texto_parte
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO partes (
        tipo,
        unidad,
        subunidad,
        estacion,
        grado_responsable,
        nombre_responsable,
        cedula_responsable,
        telefono_responsable,
        texto_parte
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        tipo || null,
        unidad || null,
        subunidad || null,
        estacion || null,
        grado_responsable || null,
        nombre_responsable || null,
        cedula_responsable || null,
        telefono_responsable || null,
        texto_parte || null
      ]
    );

    res.json({ ok: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/partes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM partes ORDER BY id DESC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// VALIDAR RESPONSABLE
// =========================
app.post("/validar-responsable", async (req, res) => {
  const { cedula } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM personal WHERE cedula = $1 LIMIT 1",
      [cedula]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: false });
    }

    const persona = result.rows[0];

    const grado = (persona.grado || "").toUpperCase().trim().replace(/\s+/g, "");
    const cargo = (persona.cargo || "").toUpperCase().trim();
    const rol = (persona.rol || "").toUpperCase().trim();
    const esAdmin = rol === "ADMIN";

    const esOficial = esGradoOficial(grado);

    const cargosPermitidos = [
      "JEFE POLCO ESTACION",
      "JEFE ENCARGADO POLCO ESTACION",
      "SUBCOMANDANTE POLCO ESTACION"
    ];

    const puedeGenerarParte =
      esOficial ||
      cargosPermitidos.includes(cargo) ||
      rol === "OPERADOR_PARTE" ||
      rol === "ADMIN_EXCEL";

    const puedeSubirExcel =
      esOficial ||
      rol === "ADMIN_EXCEL";

   res.json({
  ok: true,
  autorizado: puedeGenerarParte,
  puedeSubirExcel,
  nombre: `${persona.nombres || ""} ${persona.apellidos || ""}`.trim(),
  grado: persona.grado || "",
  cedula: persona.cedula || "",
  telefono: persona.telefono || "",
  unidad: persona.unidad || "",
  subunidad: persona.subunidad || "",
  estacion: persona.estacion || "",
  organico: persona.organico || "",
  rol,
  esOficial,
  es_admin: esAdmin
});
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// SUBIR EXCEL
// =========================
app.post("/subir-excel", upload.single("archivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No se recibió archivo");
    }

    const filePath = req.file.path;

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const datos = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!datos.length) {
      fs.unlinkSync(filePath);
      return res.status(400).send("El Excel está vacío");
    }

    let insertados = 0;
    let actualizados = 0;
    let omitidos = 0;

    for (const row of datos) {
      const cedula = String(row["CÉDULA"] || row["CEDULA"] || "").trim();

      if (!cedula) {
        omitidos++;
        continue;
      }

      const existe = await pool.query(
        "SELECT id FROM personal WHERE cedula = $1 LIMIT 1",
        [cedula]
      );

      const payload = [
        String(row["GRADO"] || "").trim(),
        String(row["APELLIDOS"] || "").trim(),
        String(row["NOMBRES"] || "").trim(),
        cedula,
        String(row["TELEFONO"] || row["TELÉFONO"] || "").trim(),
        String(row["CORREO"] || "").trim(),
        String(row["UNIDAD"] || row["UNIDAD1"] || "").trim(),
        String(row["SUBUNIDAD"] || "").trim(),
        String(row["ESTACIÓN"] || row["ESTACION"] || "").trim(),
        String(row["ORGÁNICO"] || row["ORGANICO"] || "").trim(),
        String(row["ASIGNACIÓN"] || row["ASIGNACION"] || "").trim(),
        String(row["TURNO"] || "").trim(),
        String(row["APTITUD"] || "").trim(),
        String(row["CARGO"] || "").trim(),
        String(row["ROL"] || "").trim(),
        true
      ];

      if (existe.rows.length > 0) {
        await pool.query(
          `
          UPDATE personal SET
            grado = $1,
            apellidos = $2,
            nombres = $3,
            telefono = $5,
            correo = $6,
            unidad = $7,
            subunidad = $8,
            estacion = $9,
            organico = $10,
            asignacion = $11,
            turno = $12,
            aptitud = $13,
            cargo = $14,
            rol = $15,
            activo = $16
          WHERE cedula = $4
          `,
          payload
        );
        actualizados++;
      } else {
        await pool.query(
          `
          INSERT INTO personal (
            grado,
            apellidos,
            nombres,
            cedula,
            telefono,
            correo,
            unidad,
            subunidad,
            estacion,
            organico,
            asignacion,
            turno,
            aptitud,
            cargo,
            rol,
            activo
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
          )
          `,
          payload
        );
        insertados++;
      }
    }

    fs.unlinkSync(filePath);

    res.send(
      `Excel procesado correctamente. Insertados: ${insertados}. Actualizados: ${actualizados}. Omitidos: ${omitidos}.`
    );
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).send("Error procesando Excel: " + error.message);
  }
});

// =========================
// ESTRUCTURA UNIDAD / SUBUNIDAD / ESTACION / ORGANICO
// =========================
app.get("/estructura", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT
        unidad,
        subunidad,
        estacion,
        organico
      FROM personal
      WHERE activo = true
      ORDER BY unidad, subunidad, estacion, organico
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// CARGAR PERSONAL FILTRADO
// =========================
app.post("/personal-filtrado", async (req, res) => {
  const { unidad, subunidades = [], estaciones = [], organicos = [] } = req.body;

  try {
    if (!unidad) {
      return res.status(400).json({
        ok: false,
        error: "Unidad es obligatoria"
      });
    }

    let query = `
      SELECT *
      FROM personal
      WHERE activo = true
        AND unidad = $1
    `;

    const params = [unidad];
    let index = 2;

    if (Array.isArray(subunidades) && subunidades.length > 0) {
      query += ` AND subunidad = ANY($${index})`;
      params.push(subunidades);
      index++;
    }

    if (Array.isArray(estaciones) && estaciones.length > 0) {
      query += ` AND estacion = ANY($${index})`;
      params.push(estaciones);
      index++;
    }

    if (Array.isArray(organicos) && organicos.length > 0) {
      query += ` AND organico = ANY($${index})`;
      params.push(organicos);
      index++;
    }

    query += `
      ORDER BY
        ${construirOrdenGradoSQL()},
        apellidos,
        nombres
    `;

    const result = await pool.query(query, params);

    res.json({
      ok: true,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// =========================
// GUARDAR NOVEDADES
// =========================
app.post("/guardar-novedades", async (req, res) => {
  const {
    unidad,
    subunidades = [],
    estaciones = [],
    organicos = [],
    novedades = [],
    grado = "",
    rol = "",
    cedula_responsable = "",
    nombre_responsable = ""
  } = req.body;

  try {
    if (!unidad) {
      return res.status(400).json({
        ok: false,
        error: "La unidad es obligatoria"
      });
    }

    if (!Array.isArray(novedades)) {
      return res.status(400).json({
        ok: false,
        error: "Datos inválidos"
      });
    }

    const gradoLimpio = String(grado).toUpperCase().trim().replace(/\s+/g, "");
    const rolLimpio = String(rol).toUpperCase().trim();

    const esOficial = esGradoOficial(gradoLimpio);
    const esExento = esOficial || rolLimpio === "ADMIN_EXCEL";

    const { estado, esMediodia } = validarHorarioParte();

    const config = await pool.query(
      "SELECT valor FROM configuracion_sistema WHERE clave = 'parte_extra_global' LIMIT 1"
    );

    const parteExtraGlobal =
      config.rows.length > 0 && config.rows[0].valor === "true";

    if (!esExento && !parteExtraGlobal) {
      if (!esMediodia && estado === "bloqueado") {
        return res.json({
          ok: false,
          mensaje: "⚠️ Fuera de horario. Solo puedes trabajar en modo consulta, sin guardar novedades."
        });
      }
    }

    const horario = validarHorarioParte();
    let franja = "general";

    if (horario.esMediodia) {
      franja = "mediodia";
    } else if (horario.tipo === "mañana") {
      franja = "mañana";
    } else if (horario.tipo === "noche") {
      franja = "noche";
    }

    const estacionTexto = Array.isArray(estaciones) ? estaciones.join(", ") : "";
    const subunidadTexto = Array.isArray(subunidades) ? subunidades.join(", ") : "";
    const organicoTexto = Array.isArray(organicos) ? organicos.join(", ") : "";

    for (const n of novedades) {
      if (!n.cedula || !n.tipo) continue;

      await pool.query(
        `INSERT INTO novedades (
          cedula,
          estacion,
          tipo_novedad,
          fecha,
          actualizado_por_cedula,
          actualizado_por_nombre,
          hora_registro,
          franja
        )
        VALUES (
          $1,
          $2,
          $3,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date,
          $4,
          $5,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota'),
          $6
        )
        ON CONFLICT (cedula, fecha)
        DO UPDATE SET
          estacion = EXCLUDED.estacion,
          tipo_novedad = EXCLUDED.tipo_novedad,
          actualizado_por_cedula = EXCLUDED.actualizado_por_cedula,
          actualizado_por_nombre = EXCLUDED.actualizado_por_nombre,
          hora_registro = EXCLUDED.hora_registro,
          franja = EXCLUDED.franja`,
        [
          n.cedula,
          estacionTexto || subunidadTexto || organicoTexto || null,
          n.tipo,
          cedula_responsable,
          nombre_responsable,
          franja
        ]
      );
    }

    return res.json({
      ok: true,
      mensaje: esMediodia
        ? "Novedades guardadas correctamente en franja de mediodía ✅"
        : "Novedades guardadas correctamente ✅"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// VALIDAR SI EL PARTE ES OFICIAL O SOLO CONSULTA
// =========================
app.get("/validar-parte", async (req, res) => {
  try {
    const grado = (req.query.grado || "").toUpperCase().trim().replace(/\s+/g, "");
    const rol = (req.query.rol || "").toUpperCase().trim();

    const esOficial = esGradoOficial(grado);
    const esExento = esOficial || rol === "ADMIN_EXCEL";

    const config = await pool.query(
  "SELECT valor FROM configuracion_sistema WHERE clave = 'parte_extra_global' LIMIT 1"
);

const parteExtraGlobal =
  config.rows.length > 0 && config.rows[0].valor === "true";

    const { tipo, estado, mensaje, esMediodia, extemporaneo } = validarHorarioParte();

    if (parteExtraGlobal) {
  return res.json({
    ok: true,
    tipo: "extraordinario_global",
    estado: "extraordinario_global",
    mensaje: "Parte extraordinario habilitado por administración",
    esMediodia: false,
    extemporaneo: true,
    guardarOficial: true
  });
}

    if (esExento) {
      return res.json({
        ok: true,
        tipo: tipo || "manual",
        estado,
        mensaje: "OK",
        esMediodia: false,
        extemporaneo,
        guardarOficial: true
      });
    }

    if (esMediodia) {
      return res.json({
        ok: false,
        mensaje,
        esMediodia: true
      });
    }

    if (estado === "bloqueado") {
      return res.json({
        ok: true,
        tipo: null,
        estado: "bloqueado",
        mensaje: "⚠️ Parte solo de consulta. No quedará guardado en la plataforma.",
        esMediodia: false,
        extemporaneo: false,
        guardarOficial: false
      });
    }

    const hoy = obtenerFechaBogotaSQL();

    const existe = await pool.query(
      `SELECT COUNT(*)
       FROM partes
       WHERE DATE(fecha) = $1
       AND tipo = $2`,
      [hoy, tipo]
    );

    if (parseInt(existe.rows[0].count, 10) > 0) {
      return res.json({
        ok: false,
        mensaje: `⚠️ Ya se registró el parte de ${tipo}`
      });
    }

    return res.json({
      ok: true,
      tipo,
      estado,
      mensaje,
      esMediodia: false,
      extemporaneo,
      guardarOficial: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/control-cumplimiento-diario", async (req, res) => {
  try {
    const fecha = (req.query.fecha || obtenerFechaBogotaSQL()).trim();

    const estacionesResult = await pool.query(`
      select estacion
      from estaciones_control
      where activo = true
      order by estacion
    `);

    const estacionesEsperadas = estacionesResult.rows.map(r => r.estacion);

    const partesMananaResult = await pool.query(`
      select distinct estacion
      from partes
      where date(fecha) = $1
        and tipo = 'mañana'
        and estacion is not null
    `, [fecha]);

    const partesNocheResult = await pool.query(`
      select distinct estacion
      from partes
      where date(fecha) = $1
        and tipo = 'noche'
        and estacion is not null
    `, [fecha]);

    const novedadesDiaResult = await pool.query(`
      select distinct estacion
      from novedades
      where fecha = $1
        and estacion is not null
    `, [fecha]);

    const novedadesMediodiaResult = await pool.query(`
      select
        estacion,
        actualizado_por_cedula,
        actualizado_por_nombre,
        hora_registro,
        franja
      from novedades
      where fecha = $1
        and franja = 'mediodia'
        and estacion is not null
      order by estacion
    `, [fecha]);

    const partesManana = new Set(partesMananaResult.rows.map(r => r.estacion));
    const partesNoche = new Set(partesNocheResult.rows.map(r => r.estacion));
    const novedadesDia = new Set(novedadesDiaResult.rows.map(r => r.estacion));
    const novedadesMediodia = new Set(novedadesMediodiaResult.rows.map(r => r.estacion));

    const faltanManana = estacionesEsperadas.filter(e => !partesManana.has(e));
    const faltanNoche = estacionesEsperadas.filter(e => !partesNoche.has(e));
    const faltanNovedadesDia = estacionesEsperadas.filter(e => !novedadesDia.has(e));
    const faltanNovedadesMediodia = estacionesEsperadas.filter(e => !novedadesMediodia.has(e));

    res.json({
      ok: true,
      fecha,
      totalEstaciones: estacionesEsperadas.length,
      partesMananaReportadas: [...partesManana],
      partesNocheReportadas: [...partesNoche],
      novedadesDiaReportadas: [...novedadesDia],
      novedadesMediodiaDetalle: novedadesMediodiaResult.rows,
      faltanManana,
      faltanNoche,
      faltanNovedadesDia,
      faltanNovedadesMediodia
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// =========================
// SERVICIO EXTRA OCUPADOS
// =========================
app.get("/servicio-extra-ocupados", async (req, res) => {
  try {
    const fecha = String(req.query.fecha || "").trim();

    if (!fecha) {
      return res.status(400).json({
        ok: false,
        error: "La fecha es obligatoria"
      });
    }

    const result = await pool.query(
  `
  SELECT DISTINCT cedula
  FROM servicios_extraordinarios
  WHERE fecha = $1
    AND COALESCE(cerrado, false) = false
  `,
  [fecha]
);

    res.json({
      ok: true,
      ocupados: result.rows
        .map(r => String(r.cedula || "").trim())
        .filter(Boolean)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// =========================
// GENERAR TEXTO DEL PARTE
// =========================
app.post("/parte-texto", async (req, res) => {
  const {
    estacion = "",
    organico = "",
    unidad = "",
    grado = "",
    nombre = "",
    cedula = "",
    telefono = ""
  } = req.query;

  const novedadesPantalla = Array.isArray(req.body?.novedades) ? req.body.novedades : [];

  try {
    if (!unidad) {
      return res.status(400).json({
        ok: false,
        error: "La unidad es obligatoria"
      });
    }

    if (!estacion && !organico) {
      return res.status(400).json({
        ok: false,
        error: "Debes seleccionar estación u orgánico"
      });
    }

    let query = `
      SELECT
        p.grado,
        p.apellidos,
        p.nombres,
        p.cedula
      FROM personal p
      WHERE p.activo = true
        AND p.unidad = $1
    `;

    const params = [unidad];
    let index = 2;

    if (estacion && estacion.trim() !== "") {
      query += ` AND p.estacion = $${index}`;
      params.push(estacion);
      index++;
    }

    if (organico && organico.trim() !== "") {
      query += ` AND p.organico = $${index}`;
      params.push(organico);
      index++;
    }

    query += `
      ORDER BY
        ${construirOrdenGradoSQL("p")},
        p.apellidos,
        p.nombres
    `;

    const result = await pool.query(query, params);

    const mapaNovedades = {};
    novedadesPantalla.forEach(n => {
      mapaNovedades[String(n.cedula || "").trim()] = String(n.tipo || "").trim().toUpperCase();
    });

    const personal = result.rows.map(p => ({
      ...p,
      tipo_novedad: mapaNovedades[String(p.cedula)] || ""
    }));

    const esOficialG = (g) => ["CR", "TC", "MY", "CT", "TE", "ST"].includes((g || "").toUpperCase());
    const esEjecutivo = (g) => ["CM", "SC", "IJ", "IT", "SI"].includes((g || "").toUpperCase());
    const esPatrullero = (g) => ["PT", "PP"].includes((g || "").toUpperCase());
    const esAuxiliar = (g) => ["AUX"].includes((g || "").toUpperCase());

    function contarGrupo(lista) {
      return {
        oficiales: lista.filter(p => esOficialG(p.grado)).length,
        ejecutivo: lista.filter(p => esEjecutivo(p.grado)).length,
        patrulleros: lista.filter(p => esPatrullero(p.grado)).length,
        auxiliares: lista.filter(p => esAuxiliar(p.grado)).length
      };
    }

    function formatoConteo(c) {
      return `${c.oficiales}-${c.ejecutivo}-${c.patrulleros}-${c.auxiliares}`;
    }

    const disponibles = personal.filter(p => !p.tipo_novedad || p.tipo_novedad === "");
    const conNovedad = personal.filter(p => p.tipo_novedad && p.tipo_novedad !== "");

    const fuerzaEfectiva = contarGrupo(personal);
    const fuerzaDisponible = contarGrupo(disponibles);
    const fuerzaNovedades = contarGrupo(conNovedad);

    const novedadesPorTipo = {};
    for (const p of conNovedad) {
      const tipo = p.tipo_novedad;
      if (!novedadesPorTipo[tipo]) novedadesPorTipo[tipo] = [];
      novedadesPorTipo[tipo].push(p);
    }

    let texto = "";

    const { extemporaneo } = validarHorarioParte();
    if (extemporaneo) {
      texto += "⚠️ PARTE EXTEMPORÁNEO\n\n";
    }

    texto += `PARTE DE PERSONAL\n`;
    texto += `UNIDAD: ${unidad}\n`;
    if (estacion) texto += `ESTACIÓN: ${estacion}\n`;
    if (organico) texto += `ORGÁNICO: ${organico}\n`;
    texto += `ELABORADO POR: ${grado} ${nombre}\n`;
    texto += `CÉDULA: ${cedula}\n`;
    texto += `TELÉFONO: ${telefono}\n`;
    texto += `FECHA: ${obtenerFechaTextoBogota()}\n\n`;

    texto += `FUERZA EFECTIVA       ${formatoConteo(fuerzaEfectiva)}\n`;
    texto += `FUERZA DISPONIBLE     ${formatoConteo(fuerzaDisponible)}\n`;
    texto += `NOVEDADES             ${formatoConteo(fuerzaNovedades)}\n\n`;

    texto += `DISPONIBLES ${formatoConteo(fuerzaDisponible)}\n`;
    disponibles.forEach((p, i) => {
      texto += `${i + 1}. ${p.grado || ""} ${p.apellidos || ""} ${p.nombres || ""}\n`;
    });

    texto += `\nNOVEDADES ${formatoConteo(fuerzaNovedades)}\n\n`;

    const ordenTipos = [
      "SERVICIO",
      "SERVICIO EXTRAORDINARIO",
      "COMISION DE SERVICIO",
      "COMISION EXTERIOR",
      "PLAN ELECTORAL",
      "PERMISO",
      "PERMISO NAVIDEÑO",
      "PERMISO SEMANA SANTA",
      "PERMISO EXTRAORDINARIOS",
      "VACACIONES",
      "SUSPENDIDOS",
      "EXCUSADOS",
      "FRANQUICIA",
      "LICENCIA LUTO",
      "LICENCIA MATERNIDAD",
      "HOSPITALIZADO",
      "CITA MEDICA",
      "CURSO ASCENSO",
      "RETARDADOS DE LA FORMACION",
      "FUERA DE LA FORMACION",
      "HORARIO FLEXIBLE",
      "CUMPLE FUNCIONES DIFERENTES DE POLCO",
      "NO ES DE POLCO PERO CUMPLE FUNCIONES DE POLCO"
    ];

    const tiposExistentes = [
      ...ordenTipos.filter(t => novedadesPorTipo[t]),
      ...Object.keys(novedadesPorTipo).filter(t => !ordenTipos.includes(t))
    ];

    for (const tipo of tiposExistentes) {
      const lista = novedadesPorTipo[tipo];
      const conteoTipo = contarGrupo(lista);

      texto += `${tipo} ${formatoConteo(conteoTipo)}\n`;
      lista.forEach((p, i) => {
        texto += `${i + 1}. ${p.grado || ""} ${p.apellidos || ""} ${p.nombres || ""}\n`;
      });
      texto += `\n`;
    }

    res.json({
      ok: true,
      texto
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ==============================
// GUARDA PARTE PDF
// ==============================
app.post("/guardar-parte-pdf", async (req, res) => {
  const {
    tipo,
    unidad,
    subunidades = [],
    estaciones = [],
    grado_responsable,
    nombre_responsable,
    cedula_responsable,
    telefono_responsable,
    texto_parte,
    novedades = []
  } = req.body;

  const grado = (grado_responsable || "").toUpperCase().trim().replace(/\s+/g, "");
  const esOficial = esGradoOficial(grado);

  try {
    const { estado, esMediodia } = validarHorarioParte();

    const config = await pool.query(
      "SELECT valor FROM configuracion_sistema WHERE clave = 'parte_extra_global' LIMIT 1"
    );

    const parteExtraGlobal =
      config.rows.length > 0 && config.rows[0].valor === "true";

    if (!esOficial && !parteExtraGlobal) {
      if (esMediodia) {
        return res.json({
          ok: false,
          mensaje: "⛔ Al mediodía solo se registran novedades. No se guarda parte."
        });
      }

      if (estado === "bloqueado") {
        return res.json({
          ok: false,
          mensaje: "⛔ Fuera de horario. No se puede guardar el parte."
        });
      }
    }

    if (!tipo && !esOficial) {
      return res.json({
        ok: false,
        mensaje: "⛔ No hay tipo de parte válido para guardar."
      });
    }

    if (!unidad) {
      return res.json({
        ok: false,
        mensaje: "⛔ La unidad es obligatoria."
      });
    }

    const subunidadTexto = subunidades.join(", ");
    const estacionTexto = estaciones.join(", ");

    // 🔥 NOVEDADES
    if (Array.isArray(novedades) && novedades.length > 0) {
      const horario = validarHorarioParte();

      let franja = "general";
      if (horario.esMediodia) franja = "mediodia";
      else if (horario.tipo === "mañana") franja = "mañana";
      else if (horario.tipo === "noche") franja = "noche";

      for (const n of novedades) {
        if (!n.cedula || !n.tipo) continue;

        await pool.query(
          `INSERT INTO novedades (
            cedula,
            estacion,
            tipo_novedad,
            fecha,
            actualizado_por_cedula,
            actualizado_por_nombre,
            hora_registro,
            franja
          )
          VALUES (
            $1,$2,$3,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date,
            $4,$5,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota'),
            $6
          )
          ON CONFLICT (cedula, fecha)
          DO UPDATE SET
            estacion = EXCLUDED.estacion,
            tipo_novedad = EXCLUDED.tipo_novedad,
            actualizado_por_cedula = EXCLUDED.actualizado_por_cedula,
            actualizado_por_nombre = EXCLUDED.actualizado_por_nombre,
            hora_registro = EXCLUDED.hora_registro,
            franja = EXCLUDED.franja`,
          [
            n.cedula,
            estacionTexto || null,
            n.tipo,
            cedula_responsable,
            nombre_responsable,
            franja
          ]
        );
      }
    }

    // 🔥 PARTE
    const result = await pool.query(
      `INSERT INTO partes (
        tipo,
        unidad,
        subunidad,
        estacion,
        grado_responsable,
        nombre_responsable,
        cedula_responsable,
        telefono_responsable,
        texto_parte
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        tipo || null,
        unidad || null,
        subunidadTexto || null,
        estacionTexto || null,
        grado_responsable || null,
        nombre_responsable || null,
        cedula_responsable || null,
        telefono_responsable || null,
        texto_parte || null
      ]
    );

    return res.json({
      ok: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error("ERROR /guardar-parte-pdf:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// =========================
// CONSULTA GENERAL DE NOVEDADES (SOLO OFICIALES Y ADMIN)
// =========================
app.post("/consulta-novedades", async (req, res) => {
  const {
    unidad,
    subunidades = [],
    estaciones = [],
    organicos = [],
    grado = "",
    rol = "",
    tiposFiltro = []
  } = req.body;

  try {
    const gradoLimpio = String(grado).toUpperCase().trim().replace(/\s+/g, "");
    const rolLimpio = String(rol).toUpperCase().trim();

    const esOficial = esGradoOficial(gradoLimpio);
    const esAdmin = rolLimpio === "ADMIN_EXCEL";

    if (!esOficial && !esAdmin) {
      return res.status(403).json({
        ok: false,
        error: "No autorizado para consulta general"
      });
    }

    if (!unidad) {
      return res.status(400).json({
        ok: false,
        error: "Unidad es obligatoria"
      });
    }

    const subunidadesLimpias = normalizarArrayValores(subunidades);
    const estacionesLimpias = normalizarArrayValores(estaciones);
    const organicosLimpios = normalizarArrayValores(organicos);
    const tiposLimpios = normalizarArrayValores(tiposFiltro).map(v => v.toUpperCase());

   let query = `
  SELECT
    p.grado,
    p.apellidos,
    p.nombres,
    p.cedula,
    p.telefono,
    p.unidad,
    p.subunidad,
    p.estacion,
    p.organico,
    p.aptitud,
    COALESCE(n.tipo_novedad, '') AS tipo_novedad
  FROM personal p
        LEFT JOIN novedades n
        ON p.cedula = n.cedula
        AND n.fecha = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date
      WHERE p.activo = true
        AND p.unidad = $1
    `;

    const params = [unidad];
    let index = 2;

    if (subunidadesLimpias.length > 0) {
      query += ` AND p.subunidad = ANY($${index})`;
      params.push(subunidadesLimpias);
      index++;
    }

    if (estacionesLimpias.length > 0) {
      query += ` AND p.estacion = ANY($${index})`;
      params.push(estacionesLimpias);
      index++;
    }

    if (organicosLimpios.length > 0) {
      query += ` AND p.organico = ANY($${index})`;
      params.push(organicosLimpios);
      index++;
    }

    query += `
      ORDER BY
        ${construirOrdenGradoSQL("p")},
        p.apellidos,
        p.nombres
    `;

    const result = await pool.query(query, params);

    const personal = result.rows.map(p => ({
      ...p,
      tipo_novedad: String(p.tipo_novedad || "").trim().toUpperCase()
    }));

    const esOficialG = (g) => ["CR", "TC", "MY", "CT", "TE", "ST"].includes((g || "").toUpperCase());
    const esEjecutivo = (g) => ["CM", "SC", "IJ", "IT", "SI"].includes((g || "").toUpperCase());
    const esPatrullero = (g) => ["PT", "PP"].includes((g || "").toUpperCase());
    const esAuxiliar = (g) => ["AUX"].includes((g || "").toUpperCase());

    function contarGrupo(lista) {
      return {
        oficiales: lista.filter(p => esOficialG(p.grado)).length,
        ejecutivo: lista.filter(p => esEjecutivo(p.grado)).length,
        patrulleros: lista.filter(p => esPatrullero(p.grado)).length,
        auxiliares: lista.filter(p => esAuxiliar(p.grado)).length
      };
    }

    function formatoConteo(c) {
      return `${c.oficiales}-${c.ejecutivo}-${c.patrulleros}-${c.auxiliares}`;
    }

    let personalFiltrado = personal;

    if (tiposLimpios.length > 0) {
      const incluirDisponibles = tiposLimpios.includes("DISPONIBLE");
      const otrosTipos = tiposLimpios.filter(t => t !== "DISPONIBLE");

      personalFiltrado = personal.filter(p => {
        const tipo = p.tipo_novedad || "";
        if (!tipo) return incluirDisponibles;
        return otrosTipos.includes(tipo);
      });
    }

    const fuerzaEfectivaConteo = contarGrupo(personalFiltrado);
    const fuerzaEfectivaTotal = personalFiltrado.length;

    const agrupados = {};

    personalFiltrado.forEach(p => {
      const tipo = p.tipo_novedad && p.tipo_novedad !== "" ? p.tipo_novedad : "DISPONIBLE";
      if (!agrupados[tipo]) agrupados[tipo] = [];
      agrupados[tipo].push(p);
    });

    const ordenTipos = [
      "DISPONIBLE",
      "SERVICIO",
      "SERVICIO EXTRAORDINARIO",
      "COMISION DE SERVICIO",
      "COMISION EXTERIOR",
      "PLAN ELECTORAL",
      "PERMISO",
      "PERMISO EXTRAORDINARIOS",
      "PERMISO NAVIDEÑO",
      "PERMISO SEMANA SANTA",
      "VACACIONES",
      "SUSPENDIDOS",
      "EXCUSADOS",
      "FRANQUICIA",
      "LICENCIA LUTO",
      "LICENCIA MATERNIDAD",
      "HOSPITALIZADO",
      "CITA MEDICA",
      "CURSO ASCENSO",
      "RETARDADOS DE LA FORMACION",
      "FUERA DE LA FORMACION",
      "HORARIO FLEXIBLE",
      "CUMPLE FUNCIONES DIFERENTES DE POLCO",
      "NO ES DE POLCO PERO CUMPLE FUNCIONES DE POLCO"
    ];

    const general = [];
    const detalleAgrupado = [];

    general.push({
      tipo: "FUERZA EFECTIVA",
      conteo: formatoConteo(fuerzaEfectivaConteo),
      total: fuerzaEfectivaTotal
    });

    const tiposExistentes = [
      ...ordenTipos.filter(t => agrupados[t]),
      ...Object.keys(agrupados).filter(t => !ordenTipos.includes(t))
    ];

    for (const tipo of tiposExistentes) {
      const lista = agrupados[tipo];
      const conteo = contarGrupo(lista);
      const total = lista.length;

      general.push({
        tipo,
        conteo: formatoConteo(conteo),
        total
      });

      detalleAgrupado.push({
        tipo,
        conteo: formatoConteo(conteo),
        total,
        personas: lista.map(p => ({
          grado: p.grado || "",
          apellidos: p.apellidos || "",
          nombres: p.nombres || "",
          cedula: p.cedula || "",
          telefono: p.telefono || "",
          estacion: p.estacion || ""
        }))
      });
    }

return res.json({
  ok: true,
  general,
  detalleAgrupado,
  personalCompleto: personalFiltrado
});
    
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// GUARDAR SERVICIOS EXTRAORDINARIOS
// =========================
app.post("/guardar-servicio-extraordinario", async (req, res) => {
  try {
    const {
      personal,
      responsable_cedula,
      responsable_nombre,
      fecha_servicio,
      titulo_servicio
    } = req.body;

    if (!personal || !personal.length) {
      return res.json({ ok: false, mensaje: "Sin personal" });
    }

    const fechaFinal = fecha_servicio || obtenerFechaBogotaSQL();
    const tituloFinal = String(titulo_servicio || "SERVICIO EXTRAORDINARIO").trim();

    const registros = personal.map(p => ({
      cedula: (p.cedula || "").toString().trim(),
      nombres: p.nombres || "",
      apellidos: p.apellidos || "",
      grado: p.grado || "",
      unidad: p.unidad || "",
      subunidad: p.subunidad || "",
      estacion: p.estacion || "",
      organico: p.organico || "",
      cargo_servicio: p.cargoServicio || "",
      responsable_cedula,
      responsable_nombre
    }));

    for (const r of registros) {
      await pool.query(
        `
        INSERT INTO servicios_extraordinarios (
          cedula,
          fecha,
          unidad,
          subunidad,
          estacion,
          organico,
          grado,
          apellidos,
          nombres,
          asignado_por_cedula,
          asignado_por_nombre,
          titulo_servicio,
          cargo_servicio
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          r.cedula || null,
          fechaFinal,
          r.unidad || null,
          r.subunidad || null,
          r.estacion || null,
          r.organico || null,
          r.grado || null,
          r.apellidos || null,
          r.nombres || null,
          r.responsable_cedula || null,
          r.responsable_nombre || null,
          tituloFinal || null,
          r.cargo_servicio || null
        ]
      );
    }

    res.json({
      ok: true,
      mensaje: "Servicio extraordinario guardado correctamente"
    });

  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: err.message });
  }
});
// =========================
app.get("/modulo11-servicios", async (req, res) => {
  try {
    const { fecha, unidad } = req.query;

    if (!fecha || !unidad) {
      return res.json({ ok: false, error: "Fecha y unidad obligatorias" });
    }

    const result = await pool.query(
      `
      SELECT DISTINCT
        COALESCE(titulo_servicio, 'SERVICIO EXTRAORDINARIO') AS titulo_servicio
      FROM servicios_extraordinarios
      WHERE fecha = $1
        AND unidad = $2
      ORDER BY titulo_servicio
      `,
      [fecha, unidad]
    );

    res.json({
      ok: true,
      data: result.rows.map(r => ({
        id: r.titulo_servicio,
        titulo_servicio: r.titulo_servicio
      }))
    });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

// =========================
// HISTORIAL DE SERVICIOS EXTRAORDINARIOS
// =========================
app.post("/historial-servicio-extraordinario", async (req, res) => {
  const {
    unidad = "",
    subunidades = [],
    estaciones = [],
    organicos = [],
    fechaInicio = "",
    fechaFin = "",
    grado = "",
    rol = ""
  } = req.body;

  try {
    const gradoLimpio = String(grado).toUpperCase().trim().replace(/\s+/g, "");
    const rolLimpio = String(rol).toUpperCase().trim();

    const esOficial = esGradoOficial(gradoLimpio);
    const esAdmin = rolLimpio === "ADMIN_EXCEL";

    // 🔒 Validación
    if (!esOficial && !esAdmin) {
      return res.status(403).json({
        ok: false,
        error: "No autorizado para consultar historial"
      });
    }

    let query = `
      SELECT
        grado,
        apellidos,
        nombres,
        cedula,
        unidad,
        subunidad,
        estacion,
        organico,
        COUNT(*) AS veces,
        MIN(fecha) AS primera_vez,
        MAX(fecha) AS ultima_vez
      FROM servicios_extraordinarios
      WHERE 1=1
    `;

    const params = [];
    let index = 1;

    if (unidad) {
      query += ` AND unidad = $${index}`;
      params.push(unidad);
      index++;
    }

    const subunidadesLimpias = normalizarArrayValores(subunidades);
    const estacionesLimpias = normalizarArrayValores(estaciones);
    const organicosLimpios = normalizarArrayValores(organicos);

    if (subunidadesLimpias.length > 0) {
      query += ` AND subunidad = ANY($${index})`;
      params.push(subunidadesLimpias);
      index++;
    }

    if (estacionesLimpias.length > 0) {
      query += ` AND estacion = ANY($${index})`;
      params.push(estacionesLimpias);
      index++;
    }

    if (organicosLimpios.length > 0) {
      query += ` AND organico = ANY($${index})`;
      params.push(organicosLimpios);
      index++;
    }

    if (fechaInicio) {
      query += ` AND fecha >= $${index}`;
      params.push(fechaInicio);
      index++;
    }

    if (fechaFin) {
      query += ` AND fecha <= $${index}`;
      params.push(fechaFin);
      index++;
    }

    query += `
      GROUP BY grado, apellidos, nombres, cedula, unidad, subunidad, estacion, organico
      ORDER BY
        ${construirOrdenGradoSQL()},
        apellidos,
        nombres
    `;

    const result = await pool.query(query, params);

    return res.json({
      ok: true,
      data: result.rows
    });

  } catch (error) {
    console.error("ERROR HISTORIAL:", error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// CONFIG PARTE EXTRA GLOBAL
// =========================
app.get("/config/parte-extra-global", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT valor FROM configuracion_sistema WHERE clave = 'parte_extra_global' LIMIT 1"
    );

    const activo =
      result.rows.length > 0 && String(result.rows[0].valor) === "true";

    res.json({
      ok: true,
      activo
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/config/parte-extra-global", async (req, res) => {
  try {
    const { activo } = req.body;

    await pool.query(
      `
      INSERT INTO configuracion_sistema (clave, valor)
      VALUES ('parte_extra_global', $1)
      ON CONFLICT (clave)
      DO UPDATE SET valor = EXCLUDED.valor
      `,
      [activo ? "true" : "false"]
    );

    res.json({
      ok: true,
      activo: !!activo,
      mensaje: activo
        ? "Parte extraordinario global ACTIVADO"
        : "Parte extraordinario global DESACTIVADO"
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// OTP - ENVIAR CODIGO
// =========================
app.post("/enviar-codigo", async (req, res) => {
  const { cedula } = req.body;

  try {
    if (!cedula) {
      return res.status(400).json({
        ok: false,
        mensaje: "Cédula obligatoria"
      });
    }

    const personaResult = await pool.query(
      "SELECT cedula, telefono, nombres, apellidos FROM personal WHERE cedula = $1 LIMIT 1",
      [cedula]
    );

    if (personaResult.rows.length === 0) {
      return res.json({
        ok: false,
        mensaje: "Cédula no encontrada"
      });
    }

    const persona = personaResult.rows[0];
    const telefono = String(persona.telefono || "").trim();

    // 🔒 Limitar intentos (máximo 3 códigos por 5 minutos)
const intentos = await pool.query(
  `SELECT COUNT(*) FROM otp_codigos
   WHERE cedula = $1
   AND created_at > NOW() - INTERVAL '5 minutes'`,
  [cedula]
);

if (parseInt(intentos.rows[0].count, 10) >= 3) {
  return res.json({
    ok: false,
    mensaje: "Has solicitado muchos códigos. Intenta en 5 minutos."
  });
}

    if (!telefono) {
      return res.json({
        ok: false,
        mensaje: "El funcionario no tiene teléfono registrado"
      });
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const expira = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos

    await pool.query(
      `INSERT INTO otp_codigos (cedula, codigo, expira, usado)
       VALUES ($1, $2, $3, false)`,
      [cedula, codigo, expira]
    );

   try {
  await enviarWhatsAppOTP(telefono, codigo);

  console.log("OTP enviado:", {
    cedula,
    telefono,
    expira
  });

  return res.json({
    ok: true,
    mensaje: "Código enviado correctamente al teléfono registrado"
  });
} catch (envioError) {
  console.error("ERROR ENVIO OTP:", envioError.message);

  return res.status(500).json({
    ok: false,
    mensaje: `No se pudo enviar el código por WhatsApp: ${envioError.message}`
  });
}
    
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// OTP - VALIDAR CODIGO
// =========================
app.post("/validar-codigo", async (req, res) => {
  const { cedula, codigo } = req.body;

  try {
    // 🔒 Validación básica
    if (!cedula || !codigo) {
      return res.status(400).json({
        ok: false,
        mensaje: "Cédula y código son obligatorios"
      });
    }

    // 🔍 Buscar código más reciente
    const result = await pool.query(
      `SELECT id, expira, usado
       FROM otp_codigos
       WHERE cedula = $1
         AND codigo = $2
       ORDER BY id DESC
       LIMIT 1`,
      [cedula, codigo]
    );

    // ❌ No existe
    if (result.rows.length === 0) {
      return res.json({
        ok: false,
        mensaje: "Código inválido"
      });
    }

    const otp = result.rows[0];

    // ❌ Ya usado
    if (otp.usado) {
      return res.json({
        ok: false,
        mensaje: "Este código ya fue utilizado"
      });
    }

    // ❌ Expirado
    if (new Date() > new Date(otp.expira)) {
      return res.json({
        ok: false,
        mensaje: "El código ha expirado"
      });
    }

    // ✅ Marcar como usado
    await pool.query(
      "UPDATE otp_codigos SET usado = true WHERE id = $1",
      [otp.id]
    );

    return res.json({
      ok: true,
      mensaje: "Código validado correctamente"
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/modulo12-subunidades", async (req, res) => {
  try {
    const fecha = String(req.query.fecha || "").trim();
    const unidad = String(req.query.unidad || "").trim();
    const servicio = String(req.query.servicio || "").trim();

    if (!fecha || !unidad || !servicio) {
      return res.json({ ok: false, error: "Fecha, unidad y servicio obligatorios" });
    }

    const result = await pool.query(
      `
      SELECT DISTINCT subunidad
      FROM servicios_extraordinarios
      WHERE fecha = $1
        AND unidad = $2
        AND COALESCE(titulo_servicio, 'SERVICIO EXTRAORDINARIO') = $3
        AND subunidad IS NOT NULL
        AND TRIM(subunidad) <> ''
      ORDER BY subunidad
      `,
      [fecha, unidad, servicio]
    );

    return res.json({
      ok: true,
      data: result.rows.map(r => ({
        subunidad: r.subunidad
      }))
    });
  } catch (error) {
    console.error("ERROR MODULO12 SUBUNIDADES:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// =========================
// PARTE EXTRA MODULO 11
// =========================
app.get("/modulo11-parte-extra", async (req, res) => {
  try {
    const fecha = String(req.query.fecha || "").trim();
    const unidad = String(req.query.unidad || "").trim();
    const servicio = String(req.query.servicio || "").trim();

    if (!fecha || !unidad || !servicio) {
      return res.json({ ok: false, error: "Fecha, unidad y servicio son obligatorias" });
    }

    const servicios = await pool.query(
      `
      SELECT
        s.cedula,
        s.grado,
        s.apellidos,
        s.nombres,
        p.telefono,
        s.unidad,
        s.subunidad,
        s.estacion,
        s.organico
      FROM servicios_extraordinarios s
      LEFT JOIN personal p ON s.cedula = p.cedula
      WHERE s.fecha = $1
        AND s.unidad = $2
        AND COALESCE(s.titulo_servicio, 'SERVICIO EXTRAORDINARIO') = $3
      ORDER BY s.subunidad, ${construirOrdenGradoSQL("s")}, s.apellidos, s.nombres
      `,
      [fecha, unidad, servicio]
    );

    const controles = await pool.query(
      `
      SELECT
        cedula,
        subunidad,
        estado_control,
        observacion
      FROM modulo11_control_servicio
      WHERE fecha = $1
        AND unidad = $2
        AND titulo_servicio = $3
      `,
      [fecha, unidad, servicio]
    );

    const partes12 = await pool.query(
      `
      SELECT
        subunidad,
        estado_parte,
        responsable_grado,
        responsable_apellidos,
        responsable_nombres,
        responsable_cedula,
        responsable_telefono,
        hora_inicio,
        hora_cierre
      FROM modulo12_partes
      WHERE fecha = $1
        AND unidad = $2
        AND servicio = $3
      `,
      [fecha, unidad, servicio]
    );

    const mapaControl = {};
    controles.rows.forEach(r => {
      mapaControl[`${String(r.subunidad || "").trim()}__${String(r.cedula || "").trim()}`] = {
        estado_control: String(r.estado_control || "").trim().toUpperCase(),
        observacion: r.observacion || ""
      };
    });

    const mapaParte12 = {};
    partes12.rows.forEach(r => {
      mapaParte12[String(r.subunidad || "").trim()] = {
        estado_parte: r.estado_parte || "NO HAN DADO PARTE",
        responsable_parte: {
          hora: r.hora_cierre || r.hora_inicio || "",
          grado: r.responsable_grado || "",
          apellidos: r.responsable_apellidos || "",
          nombres: r.responsable_nombres || "",
          cedula: r.responsable_cedula || "",
          telefono: r.responsable_telefono || ""
        }
      };
    });

    const agrupado = {};

    servicios.rows.forEach(p => {
      const sub = String(p.subunidad || "SIN SUBUNIDAD").trim();
      if (!agrupado[sub]) agrupado[sub] = [];

      const key = `${sub}__${String(p.cedula || "").trim()}`;
      const control = mapaControl[key] || {};

      agrupado[sub].push({
        ...p,
        estado_control: control.estado_control
          ? String(control.estado_control).trim().toUpperCase()
          : "",
        observacion: control.observacion || ""
      });
    });

    const resumen = Object.keys(agrupado).sort().map(subunidad => {
      const parte12 = mapaParte12[subunidad] || {
        estado_parte: "NO HAN DADO PARTE",
        responsable_parte: null
      };

      return {
        subunidad,
        resumen: construirResumenModulo11DesdeLista(agrupado[subunidad]),
        estado_parte: parte12.estado_parte,
        responsable_parte: parte12.responsable_parte
      };
    });

    return res.json({
      ok: true,
      resumen,
      responsable: null
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// =========================
// DETALLE MODULO 11
// =========================
app.get("/modulo11-detalle", async (req, res) => {
  try {
    const fecha = String(req.query.fecha || "").trim();
    const unidad = String(req.query.unidad || "").trim();
    const servicio = String(req.query.servicio || "").trim();
    const subunidad = String(req.query.subunidad || "").trim();

    if (!fecha || !unidad || !servicio || !subunidad) {
      return res.json({ ok: false, error: "Fecha, unidad, servicio y subunidad son obligatorios" });
    }

    const servicios = await pool.query(
      `
      SELECT
        s.cedula,
        s.grado,
        s.apellidos,
        s.nombres,
        p.telefono,
        s.unidad,
        s.subunidad,
        s.estacion,
        s.organico
      FROM servicios_extraordinarios s
      LEFT JOIN personal p ON s.cedula = p.cedula
      WHERE s.fecha = $1
        AND s.unidad = $2
        AND s.subunidad = $3
        AND COALESCE(s.titulo_servicio, 'SERVICIO EXTRAORDINARIO') = $4
      ORDER BY ${construirOrdenGradoSQL("s")}, s.apellidos, s.nombres
      `,
      [fecha, unidad, subunidad, servicio]
    );

    const controles = await pool.query(
      `
      SELECT
        cedula,
        estado_control,
        observacion,
        es_reemplazo_manual,
        reemplaza_a_cedula,
        grado,
        apellidos,
        nombres,
        telefono
      FROM modulo11_control_servicio
      WHERE fecha = $1
        AND unidad = $2
        AND subunidad = $3
        AND titulo_servicio = $4
      `,
      [fecha, unidad, subunidad, servicio]
    );

    const mapaControl = {};
    controles.rows.forEach(r => {
      mapaControl[String(r.cedula || "").trim()] = r;
    });

    const detalle = servicios.rows.map(p => {
      const control = mapaControl[String(p.cedula || "").trim()] || {};
      return {
        ...p,
        estado_control: control.estado_control
          ? String(control.estado_control).trim().toUpperCase()
          : "",
        observacion: control.observacion || "",
        es_reemplazo_manual: !!control.es_reemplazo_manual,
        reemplaza_a_cedula: control.reemplaza_a_cedula || ""
      };
    });

    controles.rows
      .filter(r => r.es_reemplazo_manual)
      .forEach(r => {
        detalle.push({
          grado: r.grado || "",
          apellidos: r.apellidos || "",
          nombres: r.nombres || "",
          cedula: r.cedula || "",
          telefono: r.telefono || "",
          unidad,
          subunidad,
          estado_control: String(r.estado_control || "REEMPLAZO").trim().toUpperCase(),
          observacion: r.observacion || "",
          es_reemplazo_manual: true,
          reemplaza_a_cedula: r.reemplaza_a_cedula || ""
        });
      });

    return res.json({ ok: true, detalle });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// =========================
// GUARDAR CONTROL MODULO 11
// =========================
app.post("/modulo11-guardar-control", async (req, res) => {
  try {
    const { fecha, unidad, subunidad, servicio, responsable = {}, detalle = [] } = req.body;

    if (!fecha || !unidad || !subunidad || !servicio) {
      return res.json({ ok: false, error: "Fecha, unidad, subunidad y servicio son obligatorios" });
    }

    await pool.query(
      `
      DELETE FROM modulo11_control_servicio
      WHERE fecha = $1
        AND unidad = $2
        AND subunidad = $3
        AND titulo_servicio = $4
      `,
      [fecha, unidad, subunidad, servicio]
    );

    for (const p of detalle) {
      await pool.query(
        `
        INSERT INTO modulo11_control_servicio (
          fecha,
          unidad,
          subunidad,
          titulo_servicio,
          cedula,
          grado,
          apellidos,
          nombres,
          telefono,
          estado_control,
          observacion,
          es_reemplazo_manual,
          reemplaza_a_cedula,
          responsable_nombre,
          responsable_cedula,
          responsable_telefono
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `,
        [
          fecha,
          unidad,
          subunidad,
          servicio,
          p.cedula || null,
          p.grado || null,
          p.apellidos || null,
          p.nombres || null,
          p.telefono || null,
          String(p.estado_control || "DISPONIBLE").trim().toUpperCase(),
          p.observacion || null,
          !!p.es_reemplazo_manual,
          p.reemplaza_a_cedula || null,
          responsable.nombre || null,
          responsable.cedula || null,
          responsable.telefono || null
        ]
      );
    }

    return res.json({ ok: true });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// =========================
// CERRAR SERVICIO MODULO 11
// =========================

app.post("/modulo11-cerrar-servicio", async (req, res) => {
  try {
    const {
      fecha,
      unidad,
      subunidad,
      servicio,
      responsable_cedula,
      responsable_nombre
    } = req.body;

    if (!fecha || !unidad || !subunidad || !servicio) {
      return res.json({ ok: false, error: "Fecha, unidad, subunidad y servicio son obligatorios" });
    }

    await pool.query(
      `
      UPDATE servicios_extraordinarios
      SET
        cerrado = true,
        fecha_cierre = NOW(),
        cerrado_por_cedula = $5,
        cerrado_por_nombre = $6
      WHERE fecha = $1
        AND unidad = $2
        AND subunidad = $3
        AND COALESCE(titulo_servicio, 'SERVICIO EXTRAORDINARIO') = $4
      `,
      [
        fecha,
        unidad,
        subunidad,
        servicio,
        responsable_cedula || null,
        responsable_nombre || null
      ]
    );

    return res.json({ ok: true });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// =========================
// FUNCIONES AUXILIARES
// =========================
function grupo4Servidor(grado = "") {
  const g = String(grado || "").toUpperCase().trim();

  if (["CR","TC","MY","CT","TE","ST"].includes(g)) return [1,0,0,0];
  if (["CM","SC","IJ","IT","SI"].includes(g)) return [0,1,0,0];
  if (["PT","PP"].includes(g)) return [0,0,1,0];
  if (["AUX"].includes(g)) return [0,0,0,1];

  return [0,0,0,0];
}

function sumar4Servidor(a = [0,0,0,0], b = [0,0,0,0]) {
  return [
    (a[0] || 0) + (b[0] || 0),
    (a[1] || 0) + (b[1] || 0),
    (a[2] || 0) + (b[2] || 0),
    (a[3] || 0) + (b[3] || 0)
  ];
}
function construirResumenModulo11DesdeLista(lista = []) {
  const base = {
    fuerza_efectiva: [0,0,0,0],
    fuerza_disponible: [0,0,0,0],
    novedades: [0,0,0,0],
    excusado: [0,0,0,0],
    no_asiste: [0,0,0,0],
    retardado: [0,0,0,0],
    reemplazo: [0,0,0,0],
    incapacidad: [0,0,0,0],
    hospitalizado: [0,0,0,0]
  };

  lista.forEach(p => {
    const g = grupo4Servidor(p.grado || "");
    const estado = String(p.estado_control || "").trim().toUpperCase();

    base.fuerza_efectiva = sumar4Servidor(base.fuerza_efectiva, g);

    if (estado === "DISPONIBLE" || estado === "REEMPLAZO" || estado === "SACANDO PARTE" || estado === "PARTE") {
      base.fuerza_disponible = sumar4Servidor(base.fuerza_disponible, g);
    }

    if (["EXCUSADO","NO ASISTE","RETARDADO","INCAPACIDAD","HOSPITALIZADO"].includes(estado)) {
      base.novedades = sumar4Servidor(base.novedades, g);
    }

    if (estado === "EXCUSADO") base.excusado = sumar4Servidor(base.excusado, g);
    if (estado === "NO ASISTE") base.no_asiste = sumar4Servidor(base.no_asiste, g);
    if (estado === "RETARDADO") base.retardado = sumar4Servidor(base.retardado, g);
    if (estado === "REEMPLAZO") base.reemplazo = sumar4Servidor(base.reemplazo, g);
    if (estado === "INCAPACIDAD") base.incapacidad = sumar4Servidor(base.incapacidad, g);
    if (estado === "HOSPITALIZADO") base.hospitalizado = sumar4Servidor(base.hospitalizado, g);
  });

  return base;
}
// =========================
// MODULO 12 - INICIAR PARTE SUBUNIDAD
// =========================
app.post("/modulo12-iniciar-parte", async (req, res) => {
  try {
    const {
      fecha,
      unidad,
      servicio,
      subunidad,
      responsable = {}
    } = req.body;

    if (!fecha || !unidad || !servicio || !subunidad) {
      return res.json({ ok: false, error: "Fecha, unidad, servicio y subunidad son obligatorios" });
    }

    const horaBogota = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date());

    await pool.query(
      `
      INSERT INTO modulo12_partes (
        fecha,
        unidad,
        servicio,
        subunidad,
        estado_parte,
        responsable_grado,
        responsable_apellidos,
        responsable_nombres,
        responsable_cedula,
        responsable_telefono,
        hora_inicio,
        updated_at
      )
      VALUES ($1,$2,$3,$4,'SACANDO PARTE',$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
      ON CONFLICT (fecha, unidad, servicio, subunidad)
      DO UPDATE SET
        estado_parte = 'SACANDO PARTE',
        responsable_grado = EXCLUDED.responsable_grado,
        responsable_apellidos = EXCLUDED.responsable_apellidos,
        responsable_nombres = EXCLUDED.responsable_nombres,
        responsable_cedula = EXCLUDED.responsable_cedula,
        responsable_telefono = EXCLUDED.responsable_telefono,
        hora_inicio = COALESCE(modulo12_partes.hora_inicio, EXCLUDED.hora_inicio),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        fecha,
        unidad,
        servicio,
        subunidad,
        responsable.grado || null,
        responsable.apellidos || null,
        responsable.nombres || null,
        responsable.cedula || null,
        responsable.telefono || null,
        horaBogota
      ]
    );

    return res.json({ ok: true, estado_parte: "SACANDO PARTE", hora_inicio: horaBogota });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =========================
// MODULO 12 - CERRAR PARTE SUBUNIDAD
// =========================
app.post("/modulo12-cerrar-parte", async (req, res) => {
  try {
    const {
      fecha,
      unidad,
      servicio,
      subunidad,
      responsable = {}
    } = req.body;

    if (!fecha || !unidad || !servicio || !subunidad) {
      return res.json({ ok: false, error: "Fecha, unidad, servicio y subunidad son obligatorios" });
    }

    const horaBogota = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date());

    await pool.query(
      `
      INSERT INTO modulo12_partes (
        fecha,
        unidad,
        servicio,
        subunidad,
        estado_parte,
        responsable_grado,
        responsable_apellidos,
        responsable_nombres,
        responsable_cedula,
        responsable_telefono,
        hora_cierre,
        updated_at
      )
      VALUES ($1,$2,$3,$4,'PARTE DADO',$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
      ON CONFLICT (fecha, unidad, servicio, subunidad)
      DO UPDATE SET
        estado_parte = 'PARTE DADO',
        responsable_grado = EXCLUDED.responsable_grado,
        responsable_apellidos = EXCLUDED.responsable_apellidos,
        responsable_nombres = EXCLUDED.responsable_nombres,
        responsable_cedula = EXCLUDED.responsable_cedula,
        responsable_telefono = EXCLUDED.responsable_telefono,
        hora_cierre = EXCLUDED.hora_cierre,
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        fecha,
        unidad,
        servicio,
        subunidad,
        responsable.grado || null,
        responsable.apellidos || null,
        responsable.nombres || null,
        responsable.cedula || null,
        responsable.telefono || null,
        horaBogota
      ]
    );

    return res.json({ ok: true, estado_parte: "PARTE DADO", hora_cierre: horaBogota });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =========================
// MODULO 12 - CONSULTAR ESTADO DE PARTE
// =========================
app.get("/modulo12-estado-parte", async (req, res) => {
  try {
    const fecha = String(req.query.fecha || "").trim();
    const unidad = String(req.query.unidad || "").trim();
    const servicio = String(req.query.servicio || "").trim();
    const subunidad = String(req.query.subunidad || "").trim();

    if (!fecha || !unidad || !servicio || !subunidad) {
      return res.json({ ok: false, error: "Fecha, unidad, servicio y subunidad son obligatorios" });
    }

    const result = await pool.query(
      `
      SELECT
        estado_parte,
        responsable_grado,
        responsable_apellidos,
        responsable_nombres,
        responsable_cedula,
        responsable_telefono,
        hora_inicio,
        hora_cierre
      FROM modulo12_partes
      WHERE fecha = $1
        AND unidad = $2
        AND servicio = $3
        AND subunidad = $4
      LIMIT 1
      `,
      [fecha, unidad, servicio, subunidad]
    );

    if (!result.rows.length) {
      return res.json({
        ok: true,
        estado_parte: "NO HAN DADO PARTE",
        responsable_parte: null
      });
    }

    const row = result.rows[0];

    return res.json({
      ok: true,
      estado_parte: row.estado_parte || "NO HAN DADO PARTE",
      responsable_parte: {
        hora: row.hora_cierre || row.hora_inicio || "",
        grado: row.responsable_grado || "",
        apellidos: row.responsable_apellidos || "",
        nombres: row.responsable_nombres || "",
        cedula: row.responsable_cedula || "",
        telefono: row.responsable_telefono || ""
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug-columnas-partes", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'partes'
      ORDER BY column_name
    `);

    res.json(result.rows);
  } catch (error) {
    res.json({ error: error.message });
  }
});
// =========================
// LEVANTAR SERVIDOR
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
