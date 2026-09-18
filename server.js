const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const backup = require("./backup");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Neon (PostgreSQL) — la cadena de conexión viene de una variable de entorno,
// nunca hardcodeada en el código.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
// Sin esto, un error de fondo en una conexión inactiva del pool (por ejemplo,
// si algo la cierra a la fuerza) tumba todo el proceso de Node.
pool.on("error", (err) => console.log("[DB] Error de fondo (recuperado):", err.message));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      precio NUMERIC(10,2) NOT NULL,
      stock INT NOT NULL
    )
  `);
  console.log("Base de datos y tabla listas (Neon)");
}

app.get("/api/productos", async (req, res) => {
  try {
    const { buscar, pagina = 1, porPagina = 10 } = req.query;
    const offset = (pagina - 1) * porPagina;

    let where = "";
    const params = [];
    if (buscar) {
      where = "WHERE nombre ILIKE $1";
      params.push(`%${buscar}%`);
    }

    const countResult = await pool.query(`SELECT COUNT(*) AS total FROM productos ${where}`, params);
    const total = Number(countResult.rows[0].total);

    const dataParams = [...params, Number(porPagina), offset];
    const result = await pool.query(
      `SELECT * FROM productos ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    );

    res.json({
      productos: result.rows,
      total,
      pagina: Number(pagina),
      totalPaginas: Math.ceil(total / porPagina),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/productos/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM productos WHERE id=$1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Producto no encontrado" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/productos", async (req, res) => {
  try {
    const { nombre, precio, stock } = req.body;
    if (!nombre || precio === undefined || stock === undefined) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }
    if (precio < 0 || stock < 0) {
      return res.status(400).json({ error: "Precio y stock deben ser positivos" });
    }
    const result = await pool.query(
      "INSERT INTO productos (nombre, precio, stock) VALUES ($1, $2, $3) RETURNING id",
      [nombre, precio, stock]
    );
    res.json({ id: result.rows[0].id, nombre, precio, stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/productos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, precio, stock } = req.body;
    if (!nombre || precio === undefined || stock === undefined) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }
    if (precio < 0 || stock < 0) {
      return res.status(400).json({ error: "Precio y stock deben ser positivos" });
    }
    await pool.query("UPDATE productos SET nombre=$1, precio=$2, stock=$3 WHERE id=$4", [
      nombre, precio, stock, id,
    ]);
    res.json({ id: Number(id), nombre, precio, stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/productos/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM productos WHERE id=$1", [req.params.id]);
    res.json({ message: "Producto eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ENDPOINTS DE ADMINISTRACION ============

app.get("/api/admin/status", async (req, res) => {
  try {
    const tableResult = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'productos'"
    );
    const tableExists = tableResult.rows.length > 0;

    let productCount = 0;
    let totalStock = 0;
    if (tableExists) {
      const countResult = await pool.query(
        "SELECT COUNT(*) AS total, COALESCE(SUM(stock),0) AS totalstock FROM productos"
      );
      productCount = Number(countResult.rows[0].total);
      totalStock = Number(countResult.rows[0].totalstock);
    }

    res.json({
      server: true,
      database: "Neon (PostgreSQL)",
      dbExists: true,
      tableExists,
      productCount,
      totalStock,
    });
  } catch (err) {
    res.json({ server: false, error: err.message });
  }
});

app.post("/api/admin/query", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Consulta vacía" });
    if (!query.trim().toUpperCase().startsWith("SELECT")) {
      return res.status(400).json({ error: "Solo se permiten consultas SELECT" });
    }
    const result = await pool.query(query);
    res.json({ rows: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/delete-all", async (req, res) => {
  try {
    await pool.query("DELETE FROM productos");
    res.json({ message: "Todos los productos fueron eliminados" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/drop-db", async (req, res) => {
  try {
    await backup.eliminarBaseDatos(pool);
    res.json({ message: "Tabla de datos eliminada completamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Versión más agresiva: borra y recrea la base de datos "neondb" completa
// (no solo la tabla productos). Botón aparte del anterior, a propósito.
app.post("/api/admin/drop-db-neon", async (req, res) => {
  try {
    await backup.eliminarBaseDatosCompleta();
    res.json({ message: "Base de datos de Neon eliminada y recreada completamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/backups-nube", async (req, res) => {
  try {
    res.json(await backup.listarBackupsNube());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/backup", async (req, res) => {
  try {
    const frecuencia = req.body?.frecuencia || "manual";
    const r = await backup.crearBackup(pool, frecuencia);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/restore", async (req, res) => {
  try {
    const r = await backup.restaurarDesdeNube(pool, req.body?.frecuencia);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

initDB()
  .catch((err) => console.log("Aviso: la base de datos no está lista al iniciar:", err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log("========================================");
      console.log(`  Servidor en el puerto ${PORT}`);
      console.log("========================================");
      backup.iniciarBackupsAutomaticos(pool);
      console.log("========================================");
    });
  });
