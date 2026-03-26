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
      ok: puedeGenerarParte,
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
      esOficial
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
  const { unidad, subunidad, estacion, organico } = req.body;

  try {
    if (!unidad || !subunidad) {
      return res.status(400).json({
        ok: false,
        error: "Unidad y subunidad son obligatorias"
      });
    }

    let query = `
      SELECT *
      FROM personal
      WHERE activo = true
        AND unidad = $1
        AND subunidad = $2
    `;

    const params = [unidad, subunidad];
    let index = 3;

    if (estacion && estacion.trim() !== "") {
      query += ` AND estacion = $${index}`;
      params.push(estacion);
      index++;
    }

    if (organico && organico.trim() !== "") {
      query += ` AND organico = $${index}`;
      params.push(organico);
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
  const { novedades, estacion, grado = "", rol = "" } = req.body;

  try {
    if (!novedades || !Array.isArray(novedades)) {
      return res.status(400).json({ ok: false, error: "Datos inválidos" });
    }

    const gradoLimpio = String(grado).toUpperCase().trim().replace(/\s+/g, "");
    const rolLimpio = String(rol).toUpperCase().trim();

    const esOficial = esGradoOficial(gradoLimpio);
    const esExento = esOficial || rolLimpio === "ADMIN_EXCEL";

    const { estado, esMediodia } = validarHorarioParte();

    if (!esExento) {
      if (!esMediodia && estado === "bloqueado") {
        return res.json({
          ok: false,
          mensaje: "⚠️ Fuera de horario. Solo puedes trabajar en modo consulta, sin guardar novedades."
        });
      }
    }

    for (const n of novedades) {
      if (!n.cedula || !n.tipo) continue;

      await pool.query(
        `INSERT INTO novedades (cedula, estacion, tipo_novedad, fecha)
         VALUES ($1, $2, $3, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)
         ON CONFLICT (cedula, fecha)
         DO UPDATE SET
           estacion = EXCLUDED.estacion,
           tipo_novedad = EXCLUDED.tipo_novedad`,
        [n.cedula, estacion, n.tipo]
      );
    }

    return res.json({
      ok: true,
      mensaje: esMediodia
        ? "Novedades guardadas correctamente en franja de mediodía ✅"
        : "Novedades guardadas correctamente ✅"
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
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

    const { tipo, estado, mensaje, esMediodia, extemporaneo } = validarHorarioParte();

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

app.post("/guardar-servicio-extraordinario", async (req, res) => {
  try {
    const { personal, responsable_cedula, responsable_nombre } = req.body;

    if (!personal || !personal.length) {
      return res.json({ ok: false, mensaje: "Sin personal" });
    }

    const ahora = new Date();

    const registros = personal.map(p => ({
      cedula: (p.cedula || "").toString().trim(),
      nombres: p.nombres || "",
      apellidos: p.apellidos || "",
      grado: p.grado || "",
      unidad: p.unidad || "",
      subunidad: p.subunidad || "",
      estacion: p.estacion || "",
      organico: p.organico || "",
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
      asignado_por_nombre
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,
    [
      r.cedula || null,
      obtenerFechaBogotaSQL(),
      r.unidad || null,
      r.subunidad || null,
      r.estacion || null,
      r.organico || null,
      r.grado || null,
      r.apellidos || null,
      r.nombres || null,
      r.responsable_cedula || null,
      r.responsable_nombre || null
    ]
  );
}

res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: err.message });
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
    subunidad,
    estacion,
    grado_responsable,
    nombre_responsable,
    cedula_responsable,
    telefono_responsable,
    texto_parte
  } = req.body;

  const grado = (grado_responsable || "").toUpperCase().trim().replace(/\s+/g, "");
  const esOficial = esGradoOficial(grado);

  const { estado, esMediodia } = validarHorarioParte();

  if (!esOficial) {
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

    res.json({
      ok: true,
      data: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
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
        p.estacion,
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
  const {
    seleccionados = [],
    responsable_cedula = "",
    responsable_nombre = ""
  } = req.body;

  try {
    if (!Array.isArray(seleccionados) || seleccionados.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No se recibieron seleccionados"
      });
    }

    const fecha = obtenerFechaBogotaSQL();

    for (const p of seleccionados) {
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
          asignado_por_nombre
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          p.cedula || null,
          fecha,
          p.unidad || null,
          p.subunidad || null,
          p.estacion || null,
          p.organico || null,
          p.grado || null,
          p.apellidos || null,
          p.nombres || null,
          responsable_cedula || null,
          responsable_nombre || null
        ]
      );
    }

    return res.json({
      ok: true,
      mensaje: "Servicios extraordinarios guardados correctamente"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
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
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================
// LEVANTAR SERVIDOR
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
