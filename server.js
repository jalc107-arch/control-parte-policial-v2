import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Ruta principal: mostrar el index.html
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

// Guardar partes
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

// Ver todos los partes
app.get("/partes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM partes ORDER BY id DESC");
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
app.get("/responsable/:cedula", async (req, res) => {
  const { cedula } = req.params;

  // Cédulas autorizadas para ver el botón "Subir Excel"
  const ADMIN_CEDULAS = [
    "12345678",
    "87654321"
  ];

  // Grados que se toman como oficiales
  const GRADOS_OFICIALES = ["CR", "TC", "MY", "CT", "TE", "ST"];

  try {
    const result = await pool.query(
      `
      SELECT
        p.cedula,
        p.nombres,
        p.apellidos,
        p.telefono,
        p.estacion,
        g.codigo AS grado
      FROM personal p
      LEFT JOIN grados g ON g.id = p.grado_id
      WHERE p.cedula = $1
      LIMIT 1
      `,
      [cedula]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Responsable no encontrado"
      });
    }

    const persona = result.rows[0];
    const grado = (persona.grado || "").toUpperCase();
    const es_oficial = GRADOS_OFICIALES.includes(grado);
    const puede_subir_excel = ADMIN_CEDULAS.includes(persona.cedula);

    return res.json({
      ok: true,
      data: {
        cedula: persona.cedula,
        nombre: `${persona.apellidos || ""} ${persona.nombres || ""}`.trim(),
        grado: grado,
        telefono: persona.telefono || "",
        estacion: persona.estacion || "",
        es_oficial,
        puede_subir_excel
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// Levantar servidor
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
