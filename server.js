import XLSX from "xlsx";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";
import multer from "multer";

const upload = multer({ dest: "uploads/" });

const app = express();
app.use(express.json());

// 🔥 IMPORTANTE PARA RAILWAY
const PORT = process.env.PORT || 8080;

// 🔥 RUTAS DE SISTEMA
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= TEST =================
app.get("/test", (req, res) => {
  res.send("FUNCIONA");
});

// ================= ROOT (IMPORTANTE) =================
app.get("/", (req, res) => {
  res.send("API PARTE POLICIAL ACTIVA");
});

// ================= HEALTH =================
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("select now() as hora");
    res.json({ ok: true, db: true, hora: result.rows[0].hora });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ================= PERSONAL =================
app.get("/personal", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM personal LIMIT 50");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= SUBIR EXCEL =================
app.post("/subir-excel", upload.single("archivo"), async (req, res) => {
  try {
    const filePath = req.file.path;

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const datos = XLSX.utils.sheet_to_json(sheet);

    for (const row of datos) {

      const { rows: gradoRows } = await pool.query(
        "SELECT id FROM grados WHERE codigo = $1",
        [row["GRADO"]]
      );

      const grado_id = gradoRows.length > 0 ? gradoRows[0].id : null;
      if (!grado_id) continue;

      const cedula = (row["CEDULA"] || "").toString().trim();
      if (!cedula) continue;

      await pool.query(
        `INSERT INTO personal 
        (grado_id, apellidos, nombres, cedula, telefono, correo, unidad, subunidad, estacion, organico, asignacion, turno, aptitud, cargo, activo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (cedula) DO UPDATE SET
          grado_id = EXCLUDED.grado_id,
          apellidos = EXCLUDED.apellidos,
          nombres = EXCLUDED.nombres,
          telefono = EXCLUDED.telefono,
          correo = EXCLUDED.correo,
          unidad = EXCLUDED.unidad,
          subunidad = EXCLUDED.subunidad,
          estacion = EXCLUDED.estacion,
          organico = EXCLUDED.organico,
          asignacion = EXCLUDED.asignacion,
          turno = EXCLUDED.turno,
          aptitud = EXCLUDED.aptitud,
          cargo = EXCLUDED.cargo,
          activo = EXCLUDED.activo`,
        [
          grado_id,
          row["APELLIDOS"] || "",
          row["NOMBRES"] || "",
          cedula,
          row["TELEFONO"] || "",
          row["CORREO"] || "",
          row["UNIDAD"] || "",
          row["SUBUNIDAD"] || "",
          row["ESTACION"] || "",
          row["ORGANICO"] || "",
          row["ASIGNACION"] || "",
          row["TURNO"] || "",
          row["APTITUD"] || "",
          row["CARGO"] || "",
          true
        ]
      );
    }

    res.send("✅ EXCEL SUBIDO Y PROCESADO");

  } catch (error) {
    res.status(500).send("❌ ERROR: " + error.message);
  }
});

// ================= PARTE =================
app.get("/parte-texto/:estacion", async (req, res) => {
  try {
    const { estacion } = req.params;

    const colombiaNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })
    );

    const fecha = colombiaNow.toLocaleString("es-CO");

    res.json({
      ok: true,
      texto: `PARTE GENERADO - ${estacion} - ${fecha}`
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ================= STATIC (MUY IMPORTANTE) =================
app.use(express.static(path.join(__dirname, "public")));
app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.use(express.json());

app.post("/rifas", async (req, res) => {
  const { nombre, fecha, total_boletas } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO rifas (nombre, fecha, total_boletas) VALUES ($1, $2, $3) RETURNING *",
      [nombre, fecha, total_boletas]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= SERVER =================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
