const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const execFileAsync = promisify(execFile);

// Carpeta separada de la versión local (SQL Server), para no mezclar formatos.
const RCLONE_REMOTE = "gdrive:BackupsTienda-Cloud";
const BACKUP_DIR = path.join(__dirname, "tmp-backups");
const RCLONE_CONFIG_PATH = path.join(__dirname, "rclone.conf");
const FRECUENCIAS = ["5min", "1hour", "daily", "manual"];
const RETENCION = { "5min": 5, "1hour": 24, daily: 14, manual: 20 };

// El token de Google Drive nunca va en el código: en Render se guarda como
// variable de entorno secreta y aquí se vuelca a un archivo local al arrancar.
if (process.env.RCLONE_CONFIG_CONTENT && !fs.existsSync(RCLONE_CONFIG_PATH)) {
  fs.writeFileSync(RCLONE_CONFIG_PATH, process.env.RCLONE_CONFIG_CONTENT);
}

async function rclone(args, timeout = 30000) {
  const { stdout } = await execFileAsync(
    "rclone",
    ["--config", RCLONE_CONFIG_PATH, "-q", ...args],
    { timeout }
  );
  return stdout;
}

function timestamp() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

// Backup "lógico": exporta las filas de la tabla a JSON y lo sube a la nube.
// Es el equivalente a BACKUP DATABASE pero para un motor administrado como Neon,
// donde no existe un archivo .bak que copiar directamente.
async function crearBackup(pool, frecuencia) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const archivo = `productos_${frecuencia}_${timestamp()}.json`;
  const rutaLocal = path.join(BACKUP_DIR, archivo);

  const result = await pool.query("SELECT * FROM productos ORDER BY id");
  fs.writeFileSync(rutaLocal, JSON.stringify(result.rows, null, 2));
  const tamano = fs.statSync(rutaLocal).size;

  await rclone(["copy", rutaLocal, `${RCLONE_REMOTE}/${frecuencia}/`], 120000);
  fs.unlinkSync(rutaLocal); // ya está en la nube: no duplicar el archivo local

  await limpiarAntiguosEnNube(frecuencia);
  return { archivo, tamano };
}

async function limpiarAntiguosEnNube(frecuencia) {
  const max = RETENCION[frecuencia] || 10;
  try {
    const salida = await rclone(["lsf", `${RCLONE_REMOTE}/${frecuencia}/`]);
    const nube = salida.trim().split("\n").filter(Boolean).sort().reverse();
    for (const f of nube.slice(max)) {
      await rclone(["delete", `${RCLONE_REMOTE}/${frecuencia}/${f}`]);
    }
  } catch (e) {
    /* carpeta en la nube aún no existe */
  }
}

async function listarBackupsNube() {
  const resultado = {};
  await Promise.all(
    FRECUENCIAS.map(async (frecuencia) => {
      try {
        const salida = await rclone(["lsjson", `${RCLONE_REMOTE}/${frecuencia}/`]);
        resultado[frecuencia] = JSON.parse(salida)
          .map((f) => ({
            nombre: f.Name,
            tamano: (f.Size / 1024).toFixed(1) + " KB",
            fecha: new Date(f.ModTime).toLocaleString("es-PE"),
          }))
          .sort((a, b) => b.nombre.localeCompare(a.nombre));
      } catch (e) {
        resultado[frecuencia] = [];
      }
    })
  );
  return resultado;
}

async function restaurarDesdeNube(pool, frecuencia) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const carpetas = frecuencia ? [frecuencia] : FRECUENCIAS;
  let candidatos = [];
  for (const f of carpetas) {
    try {
      const salida = await rclone(["lsjson", `${RCLONE_REMOTE}/${f}/`]);
      JSON.parse(salida).forEach((item) =>
        candidatos.push({ carpeta: f, nombre: item.Name, modTime: item.ModTime })
      );
    } catch (e) {
      /* carpeta vacía o inexistente */
    }
  }

  if (candidatos.length === 0) {
    throw new Error(
      frecuencia ? `No hay backups en la nube para la frecuencia "${frecuencia}"` : "No hay backups en la nube"
    );
  }

  candidatos.sort((a, b) => new Date(b.modTime) - new Date(a.modTime));
  const elegido = candidatos[0];
  const rutaLocal = path.join(BACKUP_DIR, elegido.nombre);

  await rclone(["copy", `${RCLONE_REMOTE}/${elegido.carpeta}/${elegido.nombre}`, BACKUP_DIR], 120000);

  const filas = JSON.parse(fs.readFileSync(rutaLocal, "utf8"));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      precio NUMERIC(10,2) NOT NULL,
      stock INT NOT NULL
    )
  `);
  await pool.query("TRUNCATE TABLE productos");
  for (const fila of filas) {
    await pool.query("INSERT INTO productos (id, nombre, precio, stock) VALUES ($1, $2, $3, $4)", [
      fila.id, fila.nombre, fila.precio, fila.stock,
    ]);
  }
  // Reajustar el contador de IDs para que el próximo INSERT no choque con los restaurados.
  await pool.query(
    "SELECT setval(pg_get_serial_sequence('productos','id'), COALESCE((SELECT MAX(id) FROM productos), 1))"
  );

  const tamano = (fs.statSync(rutaLocal).size / 1024).toFixed(1) + " KB";
  fs.unlinkSync(rutaLocal);

  return { archivo: elegido.nombre, frecuencia: elegido.carpeta, tamano, filas: filas.length };
}

// "Pérdida total": se elimina la tabla completa (simula perder la estructura y los datos).
async function eliminarBaseDatos(pool) {
  await pool.query("DROP TABLE IF EXISTS productos");
}

// Versión más agresiva: borra y recrea la base de datos "neondb" completa
// (no solo la tabla). Requiere una segunda conexión a la base "postgres" de
// mantenimiento del mismo proyecto, porque Postgres no permite borrar la
// base a la que uno mismo está conectado.
async function eliminarBaseDatosCompleta() {
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, "");

  const urlMantenimiento = new URL(process.env.DATABASE_URL);
  urlMantenimiento.pathname = "/postgres";

  const admin = new Pool({
    connectionString: urlMantenimiento.toString(),
    ssl: { rejectUnauthorized: false },
  });
  admin.on("error", (err) => console.log("[NEON] Error de fondo (ignorado):", err.message));

  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

async function existeBaseDatos(pool) {
  try {
    const r = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'productos'"
    );
    return r.rows.length > 0;
  } catch (e) {
    return false;
  }
}

let backupLock = false;
async function ejecutarBackupSeguro(pool, frecuencia) {
  if (backupLock) return;
  backupLock = true;
  try {
    console.log(`[BACKUP] Ejecutando backup [${frecuencia}]...`);
    const r = await crearBackup(pool, frecuencia);
    console.log(`[BACKUP] Backup [${frecuencia}] completado: ${r.archivo}`);
  } catch (err) {
    console.log(`[BACKUP] Error en backup [${frecuencia}]:`, err.message);
  } finally {
    backupLock = false;
  }
}

let restoreLock = false;
async function verificarYRestaurarSiFalta(pool) {
  if (backupLock || restoreLock) return;
  const existe = await existeBaseDatos(pool);
  if (existe) return;

  restoreLock = true;
  console.log("[AUTO-RESTORE] Tabla no encontrada, restaurando desde la nube...");
  try {
    const r = await restaurarDesdeNube(pool);
    console.log(`[AUTO-RESTORE] Restaurada desde ${r.archivo} (${r.frecuencia})`);
  } catch (err) {
    console.log("[AUTO-RESTORE] Error:", err.message);
  } finally {
    restoreLock = false;
  }
}

function iniciarBackupsAutomaticos(pool) {
  console.log("[BACKUP] Iniciando backups automáticos (5min / 1hour / daily)...");

  setInterval(() => ejecutarBackupSeguro(pool, "5min"), 5 * 60 * 1000);
  setInterval(() => ejecutarBackupSeguro(pool, "1hour"), 60 * 60 * 1000);

  function programarDiario() {
    const ahora = new Date();
    const objetivo = new Date(ahora);
    objetivo.setHours(6, 0, 0, 0);
    if (objetivo <= ahora) objetivo.setDate(objetivo.getDate() + 1);
    const espera = objetivo - ahora;
    setTimeout(() => {
      ejecutarBackupSeguro(pool, "daily");
      setInterval(() => ejecutarBackupSeguro(pool, "daily"), 24 * 60 * 60 * 1000);
    }, espera);
  }
  programarDiario();

  setTimeout(() => ejecutarBackupSeguro(pool, "5min"), 30000);

  console.log("[AUTO-RESTORE] Verificación cada 60 segundos");
  verificarYRestaurarSiFalta(pool);
  setInterval(() => verificarYRestaurarSiFalta(pool), 60 * 1000);
}

module.exports = {
  crearBackup,
  listarBackupsNube,
  restaurarDesdeNube,
  eliminarBaseDatos,
  eliminarBaseDatosCompleta,
  existeBaseDatos,
  iniciarBackupsAutomaticos,
};
