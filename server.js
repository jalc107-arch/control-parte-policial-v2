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
app.post("/validar-responsable", async (req, res) => {
  const { cedula } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM personal WHERE cedula = $1",
      [cedula]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: false });
    }

    const persona = result.rows[0];

    const grado = (persona.grado || "").toUpperCase();
    const cargo = (persona.cargo || "").toUpperCase();
    const rol = (persona.rol || "").toUpperCase();

    const esOficial = grado.includes("OFICIAL");

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
      nombre: persona.nombres + " " + persona.apellidos,
      grado: persona.grado,
      cedula: persona.cedula,
      telefono: persona.telefono
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// Levantar servidor
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
