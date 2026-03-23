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
function validarHorarioParte() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })
  );

  const hora = now.getHours();
  const minutos = now.getMinutes();
  const total = hora * 60 + minutos;

  const dia = now.getDay(); // 0 domingo, 6 sábado
  const esFinDeSemana = dia === 0 || dia === 6;

  const limiteManana = esFinDeSemana ? (8 * 60 + 15) : (7 * 60 + 15);
  const limiteNoche = 18 * 60 + 30;

  let tipo = "";
  let extemporaneo = false;
  let esMediodia = false;

  if (total >= 11 * 60 && total < 14 * 60) {
    esMediodia = true;
  }

  if (total <= limiteManana) {
    tipo = "mañana";
  } else if (total <= limiteNoche) {
    tipo = "noche";
  } else {
    tipo = "noche";
    extemporaneo = true;
  }

  return { tipo, extemporaneo, esMediodia };
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
  const { estacion, fecha, novedad } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO partes (estacion, fecha, novedad) VALUES ($1, $2, $3) RETURNING *",
      [estacion, fecha, novedad]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    const grado = (persona.grado || "").toUpperCase();
    const cargo = (persona.cargo || "").toUpperCase();
    const rol = (persona.rol || "").toUpperCase();

    const gradosOficiales = ["CR", "TC", "MY", "CT", "TE", "ST", "OFICIAL"];
    const esOficial =
      gradosOficiales.includes(grado) || grado.includes("OFICIAL");

    const cargosPermitidos = [
      "JEFE POLCO ESTACION",
      "JEFE ENCARGADO POLCO ESTACION",
      "SUBCOMANDANTE POLCO ESTACION"
    ];

    const puedeGenerarParte =
      esOficial ||
      cargosPermitidos.includes(cargo) ||
      rol === "OPERADOR_PARTE";

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
  rol: rol,
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
// ESTRUCTURA UNIDAD / SUBUNIDAD / ESTACION
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
// unidad y subunidad obligatorias
// estacion opcional
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
        CASE UPPER(grado)
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
        END,
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
app.post("/guardar-novedades", async (req, res) => {
  const { novedades, estacion } = req.body;

  try {
    if (!novedades || !Array.isArray(novedades)) {
      return res.status(400).json({ ok: false, error: "Datos inválidos" });
    }

    for (const n of novedades) {
  if (!n.cedula || !n.tipo) continue;

  await pool.query(
    `INSERT INTO novedades (cedula, estacion, tipo_novedad)
     VALUES ($1, $2, $3)
     ON CONFLICT (cedula, fecha)
     DO UPDATE SET
       estacion = EXCLUDED.estacion,
       tipo_novedad = EXCLUDED.tipo_novedad`,
    [n.cedula, estacion, n.tipo]
  );
}
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
app.get("/validar-parte", async (req, res) => {
  try {
    const { tipo, extemporaneo, esMediodia } = validarHorarioParte();

    if (esMediodia) {
      return res.json({
        ok: false,
        mensaje: "⛔ Solo se pueden registrar novedades al mediodía",
        esMediodia: true
      });
    }

    const hoy = new Date().toISOString().slice(0, 10);

    const existe = await pool.query(
      `SELECT COUNT(*) 
       FROM partes 
       WHERE DATE(fecha) = $1 
       AND tipo = $2`,
      [hoy, tipo]
    );

    if (parseInt(existe.rows[0].count) > 0) {
      return res.json({
        ok: false,
        mensaje: `⚠️ Ya se registró el parte de ${tipo}`
      });
    }

    res.json({
      ok: true,
      tipo,
      extemporaneo
    });

  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
// =========================
// LEVANTAR SERVIDOR
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
