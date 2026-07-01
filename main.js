"use strict";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const BACKUP_ROOT = "KopiaDesk_Backup";
const METADATA_DIR = ".kopia-data";
const BACKUP_CONCURRENCY = 3;
const DEFAULT_EXCLUDES = [
  "Thumbs.db",
  "desktop.ini",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".git",
  "node_modules",
  "*.tmp",
  "~$*",
];

const QUICK_FOLDERS = [
  { key: "pictures", name: "Imágenes" },
  { key: "documents", name: "Documentos" },
  { key: "downloads", name: "Descargas" },
  { key: "music", name: "Música" },
  { key: "videos", name: "Videos" },
  { key: "desktop", name: "Escritorio" },
];

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Kopia Desk",
    icon: path.join(__dirname, "assets", "Kopia_Desk.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

function safePath(root, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("Ruta no válida.");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Ruta contiene caracteres nulos.");
  }
  const resolved = path.resolve(root, relativePath);
  let normalizedRoot = path.resolve(root);
  if (!normalizedRoot.endsWith(path.sep)) normalizedRoot += path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error("Ruta fuera del disco destino.");
  }
  return resolved;
}

function listDrives() {
  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, FileSystemLabel, SizeRemaining, Size | ConvertTo-Json -Compress"],
      { encoding: "utf-8", timeout: 10000 }
    );
    const volumes = JSON.parse(raw);
    const list = Array.isArray(volumes) ? volumes : [volumes];
    const systemDrive = (process.env.SystemDrive || "C:").toUpperCase();
    return list
      .filter((v) => v.DriveLetter)
      .map((v) => ({
        root: v.DriveLetter + ":\\",
        label: v.FileSystemLabel || "",
        free: v.SizeRemaining || 0,
        total: v.Size || 0,
        isSystemDrive: (v.DriveLetter + ":").toUpperCase() === systemDrive,
      }));
  } catch {
    return [];
  }
}

ipcMain.handle("drives:list", () => listDrives());

ipcMain.handle("dialog:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Seleccionar carpeta de origen",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:select-restore-target", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Seleccionar carpeta destino para restaurar",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Carpetas típicas del usuario (Imágenes, Documentos, Descargas, Música, Videos,
// Escritorio) para agregarlas con un clic en vez de navegar con el diálogo.
// Sólo se devuelven las que realmente existen en este equipo.
ipcMain.handle("folders:quick-list", () => {
  const result = [];
  for (const candidate of QUICK_FOLDERS) {
    try {
      const folderPath = app.getPath(candidate.key);
      if (folderPath && fs.existsSync(folderPath)) {
        result.push({ name: candidate.name, path: folderPath });
      }
    } catch {
      // no disponible en este sistema/perfil de usuario
    }
  }
  return result;
});

// --- Filtros de exclusión ---------------------------------------------

function compileExcludePatterns(patterns) {
  return patterns
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => {
      const escaped = p
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp("^" + escaped + "$", "i");
    });
}

function isExcluded(name, compiledPatterns) {
  return compiledPatterns.some((re) => re.test(name));
}

ipcMain.handle("config:default-excludes", () => DEFAULT_EXCLUDES);

function scanDirectoryRecursive(dirPath, basePath, compiledExcludes) {
  const files = {};
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === "EACCES") return files;
    throw err;
  }

  for (const entry of entries) {
    if (isExcluded(entry.name, compiledExcludes)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = basePath ? basePath + "/" + entry.name : entry.name;

    if (entry.isDirectory()) {
      Object.assign(files, scanDirectoryRecursive(fullPath, relativePath, compiledExcludes));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        files[relativePath] = {
          name: entry.name,
          path: relativePath,
          fullPath,
          size: stat.size,
          lastModified: stat.mtimeMs,
          hash: null,
        };
      } catch {
        // skip inaccessible files
      }
    }
  }
  return files;
}

ipcMain.handle("fs:scan-directory", (event, dirPath, excludePatterns) => {
  if (!fs.existsSync(dirPath)) throw new Error("La carpeta no existe: " + dirPath);
  const patterns = Array.isArray(excludePatterns) && excludePatterns.length ? excludePatterns : DEFAULT_EXCLUDES;
  return scanDirectoryRecursive(dirPath, "", compileExcludePatterns(patterns));
});

// --- Hashing -------------------------------------------------------------

function hashFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

ipcMain.handle("fs:hash-file", async (_event, filePath) => hashFileAsync(filePath));

// Hash "rápido": sólo lee los primeros y últimos 64 KB en vez del archivo completo.
// Sirve para confirmar si un archivo realmente cambió cuando coincide el tamaño
// pero difiere la fecha de modificación (p. ej. un antivirus o sincronizador que
// sólo "toca" el archivo), sin pagar el costo de un SHA-256 completo.
function quickHashFile(fullPath, size) {
  const CHUNK = 65536;
  const fd = fs.openSync(fullPath, "r");
  try {
    const hash = crypto.createHash("sha256");
    hash.update(String(size));
    if (size > 0) {
      const headBuf = Buffer.alloc(Math.min(CHUNK, size));
      const headBytes = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      hash.update(headBuf.subarray(0, headBytes));

      if (size > CHUNK) {
        const tailSize = Math.min(CHUNK, size);
        const tailBuf = Buffer.alloc(tailSize);
        const tailBytes = fs.readSync(fd, tailBuf, 0, tailSize, size - tailSize);
        hash.update(tailBuf.subarray(0, tailBytes));
      }
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

ipcMain.handle("fs:quick-hash", (_event, filePath, size) => quickHashFile(filePath, size));

ipcMain.handle("fs:copy-file", async (_event, srcPath, destRoot, relativeDest) => {
  const target = safePath(destRoot, relativeDest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(srcPath, target);
  return { ok: true, path: target };
});

ipcMain.handle("fs:read-text", async (_event, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
});

ipcMain.handle("fs:write-text", async (_event, destRoot, relativePath, content) => {
  const target = safePath(destRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return { ok: true, path: target };
});

ipcMain.handle("fs:file-exists", async (_event, filePath) => {
  return fs.existsSync(filePath);
});

function hideFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return false;
  try {
    execFileSync("attrib", ["+h", "+s", folderPath], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle("fs:hide-folder", async (_event, folderPath) => {
  return hideFolder(folderPath);
});

function manifestDir(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "manifests");
}

function manifestFilePath(destRoot, sourceName) {
  return path.join(manifestDir(destRoot), safeName(sourceName) + ".json");
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "carpeta";
}

ipcMain.handle("manifest:load", async (_event, destRoot, sourceName) => {
  const fp = manifestFilePath(destRoot, sourceName);
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return {};
  }
});

ipcMain.handle("manifest:save", async (_event, destRoot, sourceName, manifest) => {
  const fp = manifestFilePath(destRoot, sourceName);
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(fp)) {
    const prevPath = fp.replace(/\.json$/, ".prev.json");
    fs.copyFileSync(fp, prevPath);
  }

  fs.writeFileSync(fp, JSON.stringify(manifest, null, 2), "utf-8");
  hideFolder(path.join(destRoot, BACKUP_ROOT, METADATA_DIR));
  return { ok: true };
});

// --- Origen recordado por carpeta (para restaurar sin volver a preguntar) ---

function sourcesMapPath(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "sources.json");
}

ipcMain.handle("sources:remember", async (_event, destRoot, sourceName, sourcePath) => {
  const fp = sourcesMapPath(destRoot);
  let map = {};
  if (fs.existsSync(fp)) {
    try {
      map = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      map = {};
    }
  }
  map[sourceName] = sourcePath;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(map, null, 2), "utf-8");
  return { ok: true };
});

ipcMain.handle("sources:known-paths", async (_event, destRoot) => {
  const fp = sourcesMapPath(destRoot);
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return {};
  }
});

// --- Deduplicación por contenido (hardlinks) -------------------------------

function contentIndexPath(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "content-index.json");
}

function loadContentIndex(destRoot) {
  const fp = contentIndexPath(destRoot);
  if (!fs.existsSync(fp)) return new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveContentIndex(destRoot, indexMap) {
  const fp = contentIndexPath(destRoot);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(Object.fromEntries(indexMap), null, 2), "utf-8");
}

async function linkTo(existingAbsolute, target) {
  if (!fs.existsSync(existingAbsolute)) return false;
  try {
    await fs.promises.unlink(target).catch(() => {});
    await fs.promises.link(existingAbsolute, target);
    return true;
  } catch {
    return false; // p. ej. límite de hardlinks: se copia normal como respaldo
  }
}

async function copyOneTask(task, dedupIndex, pendingWrites) {
  const target = safePath(task.destRoot, task.relativeDest);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  let contentHash = null;
  let resolvePending = null;
  if (task.dedup) {
    contentHash = await hashFileAsync(task.srcPath);

    const existingRelative = dedupIndex.get(contentHash);
    if (existingRelative && (await linkTo(path.join(task.destRoot, existingRelative), target))) {
      return { dedup: true };
    }

    // Sección crítica síncrona (sin await entre get/set): si dos tareas de este
    // mismo lote comparten contenido, sólo la primera copia de verdad; la(s)
    // siguiente(s) esperan su resultado y enlazan, en vez de copiar ambas a la vez.
    const pending = pendingWrites.get(contentHash);
    if (pending) {
      const firstRelative = await pending;
      if (firstRelative && (await linkTo(path.join(task.destRoot, firstRelative), target))) {
        return { dedup: true };
      }
    } else {
      let resolveFirst;
      pendingWrites.set(contentHash, new Promise((resolve) => (resolveFirst = resolve)));
      resolvePending = resolveFirst;
    }
  }

  try {
    await fs.promises.copyFile(task.srcPath, target);
  } catch (err) {
    // Si la copia "titular" falla, se libera a quienes esperaban enlazarse a
    // ella (null = "no hay nada que enlazar"), para que copien por su cuenta
    // en vez de quedarse esperando una promesa que nunca se resolvería.
    if (resolvePending) resolvePending(null);
    throw err;
  }

  if (task.dedup && contentHash) {
    const relative = path.relative(task.destRoot, target);
    if (!dedupIndex.has(contentHash)) dedupIndex.set(contentHash, relative);
    if (resolvePending) resolvePending(relative);
  }
  return { dedup: false };
}

// --- Journal de operaciones (detecta/limpia backups interrumpidos) ---------

function journalDir(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "journal");
}

function startJournal(destRoot, tasks) {
  if (!tasks.length) return null;
  const dir = journalDir(destRoot);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "backup_" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  const entries = tasks.map((t) => ({ relativeDest: t.relativeDest, status: "pending" }));
  fs.writeFileSync(fp, JSON.stringify({ startedAt: new Date().toISOString(), entries }, null, 2));
  return fp;
}

function flushJournal(fp, entries, startedAt) {
  try {
    fs.writeFileSync(fp, JSON.stringify({ startedAt, entries }, null, 2));
  } catch {
    // no crítico
  }
}

ipcMain.handle("journal:check", async (_event, destRoot) => {
  const dir = journalDir(destRoot);
  if (!fs.existsSync(dir)) return { found: 0, filesCleaned: 0, lastInterruptedAt: null };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let filesCleaned = 0;
  let lastInterruptedAt = null;

  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      lastInterruptedAt = data.startedAt;
      for (const entry of data.entries) {
        if (entry.status === "done") continue;
        try {
          const target = safePath(destRoot, entry.relativeDest);
          if (fs.existsSync(target)) {
            fs.unlinkSync(target);
            filesCleaned++;
          }
        } catch {
          // ruta inválida o ya no existe: se ignora
        }
      }
    } catch {
      // journal corrupto, se descarta igual
    }
    try {
      fs.unlinkSync(fp);
    } catch {
      // ya no existe
    }
  }

  return { found: files.length, filesCleaned, lastInterruptedAt };
});

// --- Detección de tipo de disco (para concurrencia adaptativa) ------------

function detectDriveType(driveRoot) {
  const letterMatch = /^([A-Za-z])/.exec(String(driveRoot || ""));
  if (!letterMatch) return { mediaType: "Unknown", busType: "Unknown" };
  const letter = letterMatch[1];

  try {
    const script =
      "$ErrorActionPreference='Stop'; " +
      `$part = Get-Partition -DriveLetter '${letter}'; ` +
      "$disk = Get-Disk -Number $part.DiskNumber; " +
      "$phys = Get-PhysicalDisk -DeviceNumber $disk.Number; " +
      "[PSCustomObject]@{ MediaType = [string]$phys.MediaType; BusType = [string]$phys.BusType } | ConvertTo-Json -Compress";
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 8000,
    });
    const info = JSON.parse(raw);
    return { mediaType: info.MediaType || "Unknown", busType: info.BusType || "Unknown" };
  } catch {
    return { mediaType: "Unknown", busType: "Unknown" };
  }
}

function pickConcurrency(driveInfo, avgFileSize) {
  const manySmallFiles = avgFileSize > 0 && avgFileSize < 2 * 1024 * 1024;
  const isSpinning = driveInfo.mediaType === "HDD";
  const isSSD = driveInfo.mediaType === "SSD" || driveInfo.busType === "NVMe";

  if (isSpinning) return manySmallFiles ? 2 : 1;
  if (isSSD) return manySmallFiles ? 8 : 4;
  return manySmallFiles ? 4 : 2;
}

ipcMain.handle("backup:plan-concurrency", (_event, driveRoot, avgFileSize) => {
  const driveInfo = detectDriveType(driveRoot);
  return { concurrency: pickConcurrency(driveInfo, avgFileSize), driveInfo };
});

// --- Copia de backup --------------------------------------------------------

ipcMain.handle("backup:copy-files", async (event, tasks, options = {}) => {
  const total = tasks.length;
  let copied = 0;
  let deduped = 0;
  const errors = [];

  const destRoot = tasks.length ? tasks[0].destRoot : null;
  const dedupIndex = options.dedup && destRoot ? loadContentIndex(destRoot) : null;
  const pendingWrites = options.dedup ? new Map() : null;
  const concurrency = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;

  const journalEntries = tasks.map((t) => ({ relativeDest: t.relativeDest, status: "pending" }));
  const journalPath = destRoot ? startJournal(destRoot, tasks) : null;
  const journalStartedAt = new Date().toISOString();
  let lastFlush = Date.now();

  async function copyOne(task, index) {
    try {
      const result = await copyOneTask({ ...task, dedup: options.dedup }, dedupIndex, pendingWrites);
      if (result.dedup) deduped++;
      copied++;
      journalEntries[index].status = "done";
      if (journalPath && (copied % 25 === 0 || Date.now() - lastFlush > 1500)) {
        flushJournal(journalPath, journalEntries, journalStartedAt);
        lastFlush = Date.now();
      }
      event.sender.send("progress", {
        phase: "backup",
        current: copied,
        total,
        file: task.relativeDest,
        percent: Math.round((copied / total) * 100),
      });
    } catch (err) {
      let message = err.message;
      if (err.code === "ENOSPC") message = "No hay espacio en el disco destino.";
      if (err.code === "EACCES") message = "Sin permiso para escribir: " + task.relativeDest;
      errors.push({ file: task.relativeDest, error: message });
    }
  }

  const inFlight = new Set();
  for (let i = 0; i < tasks.length; i++) {
    const p = copyOne(tasks[i], i);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  if (dedupIndex) saveContentIndex(destRoot, dedupIndex);

  if (journalPath) {
    if (errors.length === 0) {
      try {
        fs.unlinkSync(journalPath);
      } catch {
        // no crítico
      }
    } else {
      flushJournal(journalPath, journalEntries, journalStartedAt);
    }
  }

  return { copied, errors, deduped };
});

// --- Copia de versiones anteriores (comprimidas con gzip) ------------------

function writeVersionStream(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
    } catch (err) {
      return reject(err);
    }
    const gzip = zlib.createGzip();
    const input = fs.createReadStream(srcPath);
    const out = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    input.on("error", fail);
    gzip.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    input.pipe(gzip).pipe(out);
  });
}

ipcMain.handle("backup:copy-versions", async (_event, tasks) => {
  let copied = 0;
  const errors = [];

  for (const task of tasks) {
    try {
      const target = safePath(task.destRoot, task.relativeDest + ".gz");
      await writeVersionStream(task.srcPath, target);
      copied++;
    } catch (err) {
      errors.push({ file: task.relativeDest, error: err.message });
    }
  }
  return { copied, errors };
});

ipcMain.handle("log:save", async (_event, destRoot, sourceName, report) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${safeName(sourceName)}_${stamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify(report, null, 2), "utf-8");
  return logPath;
});

ipcMain.handle("restore:scan", async (event, backupDrive, sourceName, localFolderPath) => {
  const manifestPath = manifestFilePath(backupDrive, sourceName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("No se encontró manifiesto de backup para: " + sourceName);
  }

  const rawManifest = fs.readFileSync(manifestPath, "utf-8");
  if (rawManifest.length > 50 * 1024 * 1024) {
    throw new Error("El manifiesto es demasiado grande (posible corrupción).");
  }
  const manifest = JSON.parse(rawManifest);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Manifiesto con formato inválido.");
  }

  const backupDir = path.join(backupDrive, BACKUP_ROOT, safeName(sourceName));
  const localFiles = scanDirectoryRecursive(localFolderPath, "", compileExcludePatterns(DEFAULT_EXCLUDES));
  const missing = [];
  const total = Object.keys(manifest).length;
  let checked = 0;

  for (const [relativePath, fileInfo] of Object.entries(manifest)) {
    checked++;
    const backupFilePath = path.join(backupDir, relativePath);
    const existsInLocal = localFiles[relativePath] != null;
    const existsInBackup = fs.existsSync(backupFilePath);

    if (!existsInLocal && existsInBackup) {
      missing.push({ ...fileInfo, backupFullPath: backupFilePath });
    }

    if (checked % 50 === 0) {
      event.sender.send("progress", {
        phase: "restore-scan",
        current: checked,
        total,
        file: relativePath,
        percent: Math.round((checked / total) * 100),
      });
    }
  }

  return { missing, totalChecked: total };
});

ipcMain.handle("restore:copy-files", async (event, files, targetDir, options = {}) => {
  const total = files.length;
  let copied = 0;
  const errors = [];

  async function restoreOne(file) {
    try {
      const dest = safePath(targetDir, file.path);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(file.backupFullPath, dest);
      copied++;
      event.sender.send("progress", {
        phase: "restore",
        current: copied,
        total,
        file: file.path,
        percent: Math.round((copied / total) * 100),
      });
    } catch (err) {
      errors.push({ file: file.path, error: err.message });
    }
  }

  const concurrency = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;
  const inFlight = new Set();
  for (const file of files) {
    const p = restoreOne(file);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  return { copied, errors };
});

ipcMain.handle("restore:list-sources", async (_event, backupDrive) => {
  const mDir = manifestDir(backupDrive);
  if (!fs.existsSync(mDir)) return [];
  return fs
    .readdirSync(mDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".prev.json"))
    .map((f) => f.replace(/\.json$/, ""));
});

// Lista TODO el contenido de una carpeta del backup (no sólo lo que falte
// contra una carpeta local), para poder restaurarla completa a cualquier
// destino que el usuario elija — útil cuando la carpeta/usuario original ya
// no existe (PC formateado, perfil de usuario distinto, etc.).
ipcMain.handle("restore:full-list", async (_event, backupDrive, sourceName) => {
  const manifestPath = manifestFilePath(backupDrive, sourceName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("No se encontró manifiesto de backup para: " + sourceName);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const backupDir = path.join(backupDrive, BACKUP_ROOT, safeName(sourceName));
  return Object.entries(manifest).map(([relativePath, fileInfo]) => ({
    ...fileInfo,
    backupFullPath: path.join(backupDir, relativePath),
  }));
});

function settingsPath() {
  return path.join(app.getPath("userData"), "kopia-desk-settings.json");
}

ipcMain.handle("settings:load", async () => {
  const fp = settingsPath();
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return {};
  }
});

ipcMain.handle("settings:save", async (_event, settings) => {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  return { ok: true };
});
