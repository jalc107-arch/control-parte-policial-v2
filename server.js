console.log("SUBIR EXCEL ACTIVO VERSION NUEVA");

import XLSX from "xlsx";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";
import multer from "multer";

const upload = multer({ dest: "uploads/" });

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= TEST =================
app.get("/test", (req, res) => {
  res.send("FUNCIONA");
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

// ================= TOTAL PERSONAL =================
app.get("/api/total-personal", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) FROM personal");
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    const hora = colombiaNow.getHours();
    const minutos = colombiaNow.getMinutes();

    const horaTexto = colombiaNow.toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });

    let alerta = "";
    if (hora > 7 || (hora === 7 && minutos > 15)) {
      alerta = `REPORTE FUERA DE TIEMPO\nHORA DE ENVÍO: ${horaTexto}\nENVÍO NÚMERO: 1\n`;
    }

    // ================= CONSULTAS =================
    const personalQ = await pool.query(`
      SELECT 
        p.cedula,
        p.apellidos,
        p.nombres,
        g.codigo AS grado
      FROM personal p
      JOIN estaciones e ON p.estacion_id = e.id
      LEFT JOIN grados g ON g.id = p.grado_id
      WHERE e.nombre = $1
      ORDER BY p.apellidos, p.nombres
    `, [estacion]);

    const novedadesQ = await pool.query(`
      SELECT np.cedula, np.tipo_novedad
      FROM novedades_personal np
      JOIN estaciones e ON np.estacion_id = e.id
      WHERE e.nombre = $1
      AND np.fecha = CURRENT_DATE
      AND np.activa = true
    `, [estacion]);

    const novedadesCedulas = novedadesQ.rows.map(n => n.cedula);
    const disponibles = personalQ.rows.filter(p => !novedadesCedulas.includes(p.cedula));
    const novedades = novedadesQ.rows;

    // ================= FUNCIONES =================
    function contarPorCategoria(lista) {
      let of = 0, ne = 0, ptpp = 0, aux = 0;

      lista.forEach(p => {
        const grado = (p.grado || "").toUpperCase();

        if (["CR", "TC", "MY", "CT", "TE", "ST"].includes(grado)) of++;
        else if (["SI", "SI2", "SI3", "SI4"].includes(grado)) ne++;
        else if (["PT", "PP"].includes(grado)) ptpp++;
        else aux++;
      });

      return `${String(of).padStart(2, "0")}-${String(ne).padStart(2, "0")}-${String(ptpp).padStart(2, "0")}-${String(aux).padStart(2, "0")}`;
    }

    function formatoCorto(valor) {
      return valor
        .split("-")
        .map(num => parseInt(num, 10))
        .join("-");
    }

    // ================= PROCESAMIENTO =================
    const totalEfectiva = contarPorCategoria(personalQ.rows);
    const totalDisponible = contarPorCategoria(disponibles);

    const personasNovedad = novedades
      .map(n => {
        const persona = personalQ.rows.find(p => p.cedula === n.cedula);
        if (!persona) return null;
        return { ...persona, tipo_novedad: n.tipo_novedad };
      })
      .filter(Boolean);

    const mapaNovedades = {};
    personasNovedad.forEach(p => {
      if (!mapaNovedades[p.tipo_novedad]) {
        mapaNovedades[p.tipo_novedad] = [];
      }
      mapaNovedades[p.tipo_novedad].push(p);
    });

    // ================= TEXTO =================
    let texto = "";

    const fechaParte = colombiaNow.toISOString().slice(0, 10).replace(/-/g, "");
    const consecutivo = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
    const codigoParte = `PARTE-${estacion}-${fechaParte}-${consecutivo}`;

    const fechaHoraParte = new Date().toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    const unidad = req.query.unidad || "ESTACION";
    const grado = req.query.grado || "";
    const nombre = req.query.nombre || "";
    const cedula = req.query.cedula || "";
    const telefono = req.query.telefono || "";

    let encabezado = "";

    if (unidad === "ESTACION") {
      encabezado += `ESTACIÓN DE POLICÍA ${estacion}\n`;
    } else if (unidad === "COMUNITARIA") {
      encabezado += "POLICÍA COMUNITARIA\n";
    } else if (unidad === "DIJIN") {
      encabezado += "DIJIN\n";
    }

    encabezado += "\n";

    texto += encabezado;

    texto += "----------------------------------------\n";
    texto += `REGISTRO DEL PARTE\n`;
    texto += `COD: ${codigoParte}\n`;
    texto += `FECHA: ${fechaHoraParte}\n`;
    texto += "----------------------------------------\n\n";

    if (alerta) texto += alerta + "\n";

    texto += `PERSONAL:\n`;
    texto += `OF-NE-PT/PP-AUX\n\n`;

    texto += `FUERZA EFECTIVA: ${formatoCorto(totalEfectiva)}\n`;
    texto += `FUERZA DISPONIBLE: ${formatoCorto(totalDisponible)}\n`;

    texto += "\nNOVEDADES:\n";
    texto += "--------------------------------\n";

    const totalNovedades = Object.values(mapaNovedades)
      .reduce((acc, lista) => acc + lista.length, 0);

    texto += `TOTAL: ${totalNovedades}\n`;

    if (totalNovedades > 0) {
      for (const tipo in mapaNovedades) {
        const lista = mapaNovedades[tipo];
        const conteoTipo = contarPorCategoria(lista);

        texto += `${tipo}: ${formatoCorto(conteoTipo)}\n`;

       texto += "\n\nPERSONAL DISPONIBLE\n";
texto += "----------------------------------------\n";
texto += "GRADO  APELLIDOS       NOMBRES         C.C.\n";
texto += "----------------------------------------\n";

if (disponibles.length > 0) {
  disponibles.forEach(p => {
    texto += formatearFila(p);
  });
} else {
  texto += "NO HAY PERSONAL DISPONIBLE\n";
}

texto += "----------------------------------------\n";

        texto += "\n";
      }
    } else {
      texto += "SIN NOVEDADES\n";
    }

    
    texto += "\n\nPERSONAL DISPONIBLE:\n";
texto += "--------------------------------\n";

if (disponibles.length > 0) {
  disponibles.forEach(p => {
    texto += formatearFila(p);
  });
} else {
  texto += "NO HAY PERSONAL DISPONIBLE\n";
}

texto += "--------------------------------\n";

function formatearFila(p) {
  const grado = (p.grado || "").padEnd(6, " ");
  const apellidos = (p.apellidos || "").toUpperCase().padEnd(15, " ");
  const nombres = (p.nombres || "").toUpperCase().padEnd(15, " ");
  const cedula = (p.cedula || "").toString().padEnd(12, " ");

  return `${grado}${apellidos}${nombres}${cedula}\n`;
}
    
    texto += `\nELABORA:\n`;
    texto += `NOMBRE: ${grado} ${nombre}\n`;
    texto += `C.C.: ${cedula}\n`;
    texto += `TEL: ${telefono}`;

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

// ================= STATIC =================
app.use(express.static(path.join(__dirname, "public")));

// ================= SERVER =================
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
