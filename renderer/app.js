"use strict";

const BACKUP_ROOT = "KopiaDesk_Backup";
const MAX_RENDERED_FILES = 50;
const SPACE_SAFETY_MARGIN = 1.05; // exige 5% extra de espacio libre sobre lo calculado
const THEME_STORAGE_KEY = "kopiaDeskTheme";

const state = {
  sources: [],
  destination: null,
  comparisons: [],
  copied: 0,
  busy: false,
  excludePatterns: [],
  compareSources: [],
  compareSelection: {},
};

const els = {
  addSourceBtn: document.querySelector("#addSourceBtn"),
  quickFolders: document.querySelector("#quickFolders"),
  destinationSelect: document.querySelector("#destinationSelect"),
  refreshDrivesBtn: document.querySelector("#refreshDrivesBtn"),
  scanBtn: document.querySelector("#scanBtn"),
  backupBtn: document.querySelector("#backupBtn"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  sourcesList: document.querySelector("#sourcesList"),
  destinationLabel: document.querySelector("#destinationLabel"),
  changesView: document.querySelector("#changesView"),
  sourceCount: document.querySelector("#sourceCount"),
  changeCount: document.querySelector("#changeCount"),
  copiedCount: document.querySelector("#copiedCount"),
  logList: document.querySelector("#logList"),
  spaceInfo: document.querySelector("#spaceInfo"),
  driveInfo: document.querySelector("#driveInfo"),
  spaceWarning: document.querySelector("#spaceWarning"),
  folderTemplate: document.querySelector("#folderTemplate"),
  versioningToggle: document.querySelector("#versioningToggle"),
  hashToggle: document.querySelector("#hashToggle"),
  dedupToggle: document.querySelector("#dedupToggle"),
  themeToggle: document.querySelector("#themeToggle"),
  progressContainer: document.querySelector("#progressContainer"),
  progressPhase: document.querySelector("#progressPhase"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBar: document.querySelector("#progressBar"),
  progressDetail: document.querySelector("#progressDetail"),
  tabBackup: document.querySelector("#tabBackup"),
  tabCompare: document.querySelector("#tabCompare"),
  tabRestoreFull: document.querySelector("#tabRestoreFull"),
  backupView: document.querySelector("#backupView"),
  compareView: document.querySelector("#compareView"),
  restoreFullView: document.querySelector("#restoreFullView"),
  comparePreview: document.querySelector("#comparePreview"),
  compareBtn: document.querySelector("#compareBtn"),
  compareResults: document.querySelector("#compareResults"),
  restoreFullList: document.querySelector("#restoreFullList"),
};

function log(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.appendChild(time);
  item.appendChild(document.createTextNode(" — " + message));
  els.logList.prepend(item);
}

function showProgress(phase, current, total, file) {
  els.progressContainer.hidden = false;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  els.progressPhase.textContent = phase;
  els.progressPercent.textContent = percent + "%";
  els.progressBar.style.width = percent + "%";
  els.progressDetail.textContent = file
    ? current + "/" + total + " — " + file
    : current + "/" + total;
}

function hideProgress() {
  els.progressContainer.hidden = true;
  els.progressBar.style.width = "0%";
}

window.kopiaAPI.onProgress((data) => {
  const labels = {
    backup: "Copiando archivos...",
    "restore-scan": "Comparando backup vs PC...",
    restore: "Restaurando archivos...",
  };
  showProgress(labels[data.phase] || data.phase, data.current, data.total, data.file);
});

function setBusy(busy) {
  state.busy = busy;
  els.scanBtn.disabled = busy;
  els.backupBtn.disabled = busy || !state.destination || totalChanges() === 0;
  els.addSourceBtn.disabled = busy;
  updateCompareBtn();
}

function totalChanges() {
  return state.comparisons.reduce(
    (t, c) => t + c.newFiles.length + c.changedFiles.length + c.missingFiles.length,
    0
  );
}

function updateCounts() {
  els.sourceCount.textContent = state.sources.length;
  els.changeCount.textContent = totalChanges();
  els.copiedCount.textContent = state.copied;
  els.backupBtn.disabled = state.busy || !state.destination || totalChanges() === 0;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1) + " " + units[index];
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "carpeta";
}

function getExcludePatterns() {
  return state.excludePatterns;
}

// --- Tema claro/oscuro ------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  els.themeToggle.textContent = theme === "dark" ? "Tema claro" : "Tema oscuro";
  els.themeToggle.setAttribute("aria-label", "Cambiar a tema " + (theme === "dark" ? "claro" : "oscuro"));
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

els.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
});

function switchTab(tab) {
  els.tabBackup.classList.toggle("active", tab === "backup");
  els.tabCompare.classList.toggle("active", tab === "compare");
  els.tabRestoreFull.classList.toggle("active", tab === "restore-full");
  els.backupView.hidden = tab !== "backup";
  els.compareView.hidden = tab !== "compare";
  els.restoreFullView.hidden = tab !== "restore-full";
  if (tab === "compare") loadComparePreview().catch((e) => log(e.message));
  if (tab === "restore-full") loadFullRestoreList().catch((e) => log(e.message));
}

// --- Pestaña "Comparar": elegir qué carpetas revisar contra una carpeta local ---

// Lista las carpetas que hay en el backup para que el usuario elija manualmente
// cuáles comparar y contra qué carpeta local — nada se compara automáticamente,
// hay que marcarlas y apretar "Comparar seleccionados".
async function loadComparePreview() {
  els.comparePreview.textContent = "";
  state.compareSources = [];
  state.compareSelection = {};
  updateCompareBtn();

  if (!state.destination) {
    els.comparePreview.classList.add("empty");
    els.comparePreview.textContent = "Selecciona un disco con backup.";
    return;
  }

  try {
    const sources = await window.kopiaAPI.restoreListSources(state.destination.root);
    if (!sources.length) {
      els.comparePreview.classList.add("empty");
      els.comparePreview.textContent = "No se encontraron backups en " + state.destination.root;
      return;
    }

    const knownPaths = await window.kopiaAPI.knownSourcePaths(state.destination.root).catch(() => ({}));
    state.compareSources = sources;
    sources.forEach((sourceName) => {
      state.compareSelection[sourceName] = { checked: false, localPath: knownPaths[sourceName] || null };
    });

    els.comparePreview.classList.remove("empty");
    renderCompareSelectionList();
  } catch (error) {
    els.comparePreview.classList.add("empty");
    els.comparePreview.textContent = "Error al leer el backup: " + error.message;
  }
}

function updateCompareBtn() {
  const anySelected = state.compareSources.some((name) => {
    const sel = state.compareSelection[name];
    return sel && sel.checked && sel.localPath;
  });
  els.compareBtn.disabled = state.busy || !anySelected;
}

function renderCompareSelectionList() {
  els.comparePreview.textContent = "";

  state.compareSources.forEach((sourceName) => {
    const sel = state.compareSelection[sourceName];
    const row = document.createElement("div");
    row.className = "source-pill selectable";

    const checkLabel = document.createElement("label");
    checkLabel.className = "pill-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sel.checked;
    const label = document.createElement("strong");
    label.textContent = sourceName;
    checkLabel.appendChild(cb);
    checkLabel.appendChild(label);
    row.appendChild(checkLabel);

    const pathSpan = document.createElement("span");
    pathSpan.style.fontSize = "0.78rem";
    pathSpan.style.color = "var(--muted)";
    pathSpan.style.overflow = "hidden";
    pathSpan.style.textOverflow = "ellipsis";
    pathSpan.textContent = sel.localPath || "Sin carpeta local elegida";
    row.appendChild(pathSpan);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "ghost";
    pickBtn.textContent = sel.localPath ? "Cambiar" : "Elegir carpeta";
    row.appendChild(pickBtn);

    cb.addEventListener("change", () => {
      sel.checked = cb.checked;
      updateCompareBtn();
    });

    pickBtn.addEventListener("click", async () => {
      const picked = await window.kopiaAPI.selectFolder();
      if (!picked) return;
      sel.localPath = picked;
      sel.checked = true;
      cb.checked = true;
      pathSpan.textContent = picked;
      pickBtn.textContent = "Cambiar";
      updateCompareBtn();
    });

    els.comparePreview.appendChild(row);
  });

  updateCompareBtn();
}

els.tabBackup.addEventListener("click", () => switchTab("backup"));
els.tabCompare.addEventListener("click", () => switchTab("compare"));
els.tabRestoreFull.addEventListener("click", () => switchTab("restore-full"));

function renderSources() {
  els.sourcesList.textContent = "";
  els.sourcesList.classList.toggle("empty", state.sources.length === 0);
  if (!state.sources.length) {
    els.sourcesList.textContent = "Sin carpetas seleccionadas";
    updateCounts();
    return;
  }

  state.sources.forEach((source, index) => {
    const row = document.createElement("div");
    row.className = "source-pill";

    const label = document.createElement("strong");
    label.textContent = source.name;
    row.appendChild(label);

    const pathSpan = document.createElement("span");
    pathSpan.style.fontSize = "0.78rem";
    pathSpan.style.color = "var(--muted)";
    pathSpan.style.overflow = "hidden";
    pathSpan.style.textOverflow = "ellipsis";
    pathSpan.textContent = source.path;
    row.appendChild(pathSpan);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Quitar carpeta";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.sources.splice(index, 1);
      state.comparisons = state.comparisons.filter((c) => c.sourceName !== source.name);
      renderSources();
      renderComparisons();
      log("Carpeta quitada: " + source.name);
      saveState();
    });
    row.appendChild(remove);
    els.sourcesList.appendChild(row);
  });
  updateCounts();
}

// Dos carpetas de origen distintas que terminan en el mismo nombre (p. ej.
// "C:\ProyectoA\Backup" y "D:\ProyectoB\Backup") sanearían al mismo nombre de
// manifiesto/carpeta de destino y mezclarían sus historiales de backup entre
// sí. Se detecta por safeName (la misma sanitización que usa main.js) y se
// desambigua automáticamente en vez de dejar que colisionen en silencio.
function uniqueSourceName(candidateName, folderPath) {
  const collidesWith = (n) =>
    state.sources.some((s) => s.path !== folderPath && safeName(s.name) === safeName(n));

  if (!collidesWith(candidateName)) return candidateName;

  const parts = folderPath.split(/[\\/]/).filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  if (parent) {
    const withParent = parent + " - " + candidateName;
    if (!collidesWith(withParent)) return withParent;
  }

  let n = 2;
  let attempt = candidateName + " (" + n + ")";
  while (collidesWith(attempt)) {
    n++;
    attempt = candidateName + " (" + n + ")";
  }
  return attempt;
}

function addFolderToSources(folderPath, displayName) {
  if (state.sources.some((s) => s.path === folderPath)) {
    log("La carpeta " + (displayName || folderPath) + " ya estaba seleccionada.");
    return;
  }

  const requestedName = displayName || folderPath.split(/[\\/]/).pop();
  const name = uniqueSourceName(requestedName, folderPath);
  if (name !== requestedName) {
    log(
      "Ya había una carpeta llamada '" + requestedName + "'; ésta se agregó como '" + name +
        "' para no mezclar sus backups."
    );
  }

  state.sources.push({ name, path: folderPath });
  renderSources();
  log("Carpeta añadida: " + name);
  saveState();
}

async function addSource() {
  if (state.busy) return;
  const folderPath = await window.kopiaAPI.selectFolder();
  if (!folderPath) return;
  addFolderToSources(folderPath);
}

async function loadQuickFolders() {
  els.quickFolders.textContent = "";
  try {
    const folders = await window.kopiaAPI.quickFolders();
    folders.forEach((folder) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-folder-chip";
      btn.textContent = folder.name;
      btn.title = folder.path;
      btn.addEventListener("click", () => {
        if (state.busy) return;
        addFolderToSources(folder.path, folder.name);
      });
      els.quickFolders.appendChild(btn);
    });
  } catch {
    // no crítico: sencillamente no se muestran accesos rápidos
  }
}

async function loadDrives() {
  els.destinationSelect.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Buscando discos...";
  els.destinationSelect.appendChild(placeholder);
  state.destination = null;
  updateCounts();

  try {
    const drives = await window.kopiaAPI.listDrives();

    els.destinationSelect.textContent = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Selecciona un disco";
    els.destinationSelect.appendChild(defaultOpt);

    drives.forEach((drive) => {
      const option = document.createElement("option");
      option.value = drive.root;
      option.textContent =
        drive.root +
        (drive.label ? " - " + drive.label : "") +
        " (" +
        formatBytes(drive.free) +
        " libres)" +
        (drive.isSystemDrive ? " — disco del sistema, no recomendado" : "");
      option.dataset.free = drive.free;
      option.dataset.total = drive.total;
      option.dataset.label = drive.label || "";
      option.dataset.isSystemDrive = drive.isSystemDrive ? "1" : "";
      els.destinationSelect.appendChild(option);
    });

    if (!drives.length) {
      els.destinationSelect.textContent = "";
      const noDisks = document.createElement("option");
      noDisks.value = "";
      noDisks.textContent = "No hay discos disponibles";
      els.destinationSelect.appendChild(noDisks);
      els.destinationLabel.textContent = "Conecta un disco o USB";
    } else {
      els.destinationLabel.textContent = "Selecciona donde guardar";
    }
    log("Discos detectados: " + drives.length + ".");
  } catch (error) {
    els.destinationSelect.textContent = "";
    const errOpt = document.createElement("option");
    errOpt.value = "";
    errOpt.textContent = "Error detectando discos";
    els.destinationSelect.appendChild(errOpt);
    log("Error al leer discos: " + error.message);
  }
}

function refreshActiveExtraTab() {
  if (els.tabCompare.classList.contains("active")) {
    loadComparePreview().catch((e) => log(e.message));
  } else if (els.tabRestoreFull.classList.contains("active")) {
    loadFullRestoreList().catch((e) => log(e.message));
  }
}

async function selectDestination() {
  const option = els.destinationSelect.selectedOptions[0];

  if (!option || !option.value) {
    state.destination = null;
    els.destinationLabel.textContent = "Selecciona donde guardar";
    els.spaceInfo.textContent = "";
    els.driveInfo.textContent = "";
    updateCounts();
    refreshActiveExtraTab();
    return;
  }

  state.destination = {
    root: option.value,
    label: option.dataset.label || "",
    free: Number(option.dataset.free || 0),
    total: Number(option.dataset.total || 0),
    isSystemDrive: option.dataset.isSystemDrive === "1",
  };
  els.destinationLabel.textContent =
    state.destination.root + " seleccionado — " + formatBytes(state.destination.free) + " libres" +
    (state.destination.isSystemDrive ? " (disco del sistema)" : "");

  const usedPct =
    state.destination.total > 0
      ? Math.round(((state.destination.total - state.destination.free) / state.destination.total) * 100)
      : 0;
  const freeText = formatBytes(state.destination.free) + " libres de " + formatBytes(state.destination.total);
  els.spaceInfo.textContent = "Disco: " + freeText + " (" + usedPct + "% usado)";

  log("Destino elegido: " + state.destination.root);
  if (state.destination.isSystemDrive) {
    log(
      "Atención: " + state.destination.root + " es el disco donde está instalado Windows. " +
        "No se recomienda usarlo como destino de backup — elegí un disco externo o USB."
    );
  }

  // Concurrencia/tipo de disco orientativos (se recalcula con datos reales al copiar)
  window.kopiaAPI
    .planConcurrency(state.destination.root, 1024 * 1024)
    .then((plan) => {
      els.driveInfo.textContent =
        "Disco " + (plan.driveInfo.mediaType || "desconocido") +
        " (" + (plan.driveInfo.busType || "?") + ") — concurrencia sugerida: " + plan.concurrency;
    })
    .catch(() => {
      els.driveInfo.textContent = "";
    });

  // Journal: detecta y limpia restos de un backup interrumpido anteriormente
  window.kopiaAPI
    .journalCheck(state.destination.root)
    .then((result) => {
      if (result.found > 0) {
        log(
          "Se detectó un backup interrumpido (" +
            (result.lastInterruptedAt ? new Date(result.lastInterruptedAt).toLocaleString() : "fecha desconocida") +
            "). Se limpiaron " + result.filesCleaned + " archivo(s) parcial(es)."
        );
      }
    })
    .catch(() => {});

  refreshActiveExtraTab();

  updateCounts();
  saveState();
}

function compareManifests(current, previous) {
  return (async () => {
    const newFiles = [];
    const changedFiles = [];
    const missingFiles = [];

    for (const [filePath, file] of Object.entries(current)) {
      const old = previous[filePath];

      if (!old) {
        try {
          file.quickHash = await window.kopiaAPI.quickHashFile(file.fullPath, file.size);
        } catch {
          // no crítico: si no se puede leer ahora, se reintentará en el próximo escaneo
        }
        newFiles.push(file);
        continue;
      }

      let changed = old.size !== file.size;
      if (!changed && old.lastModified !== file.lastModified) {
        // Mismo tamaño, distinta fecha: confirmar con hash rápido (cabecera+cola)
        // para no recopiar archivos que sólo fueron "tocados" sin cambiar contenido.
        try {
          const quick = await window.kopiaAPI.quickHashFile(file.fullPath, file.size);
          file.quickHash = quick;
          changed = !old.quickHash || old.quickHash !== quick;
        } catch {
          changed = true;
        }
      } else if (!changed) {
        file.quickHash = old.quickHash;
      }

      if (changed) changedFiles.push({ ...file, previous: old });
    }

    for (const [filePath, file] of Object.entries(previous)) {
      if (!current[filePath]) missingFiles.push(file);
    }

    return { newFiles, changedFiles, missingFiles };
  })();
}

async function scanAll() {
  if (state.busy || !state.sources.length) {
    if (!state.sources.length) log("Añade al menos una carpeta antes de escanear.");
    return;
  }

  setBusy(true);
  state.comparisons = [];
  const excludePatterns = getExcludePatterns();

  const emptyMsg = document.createElement("div");
  emptyMsg.className = "changes-view empty-state";
  const h = document.createElement("h3");
  h.textContent = "Escaneando...";
  const p = document.createElement("p");
  p.textContent = "Esto puede tardar si hay muchas subcarpetas.";
  emptyMsg.appendChild(h);
  emptyMsg.appendChild(p);
  els.changesView.textContent = "";
  els.changesView.className = "changes-view empty-state";
  els.changesView.appendChild(h);
  els.changesView.appendChild(p);

  // Cada carpeta se escanea en su propio try/catch: si una falla (p. ej. un
  // origen desconectado), las demás igual se muestran en vez de perderse todas
  // porque una excepción cortaba el loop antes de llegar a renderComparisons().
  let failures = 0;
  try {
    for (let i = 0; i < state.sources.length; i++) {
      const source = state.sources[i];
      try {
        log("Escaneando " + source.name + "...");
        showProgress("Escaneando...", i, state.sources.length, source.name);

        const previous = state.destination
          ? await window.kopiaAPI.loadManifest(state.destination.root, source.name)
          : {};

        const current = await window.kopiaAPI.scanDirectory(source.path, excludePatterns);

        const diff = await compareManifests(current, previous);

        if (els.hashToggle.checked) {
          for (const item of diff.changedFiles) {
            try {
              item.hash = await window.kopiaAPI.hashFile(item.fullPath);
            } catch {
              // skip unhashable files
            }
          }
        }

        state.comparisons.push({
          sourceName: source.name,
          sourcePath: source.path,
          manifest: current,
          previousManifest: previous,
          ...diff,
          decisions: { new: true, changed: true, missing: false },
        });
        log(
          source.name +
            ": " +
            diff.newFiles.length +
            " nuevos, " +
            diff.changedFiles.length +
            " cambiados, " +
            diff.missingFiles.length +
            " eliminados."
        );
      } catch (error) {
        failures++;
        log("Error escaneando '" + source.name + "': " + error.message + " — se continúa con las demás carpetas.");
      }
    }
  } finally {
    renderComparisons();
    if (failures) {
      log(failures + " carpeta(s) no se pudieron escanear. Las demás se muestran igual.");
    }
    setBusy(false);
    hideProgress();
  }
}

function renderComparisons() {
  updateCounts();
  els.changesView.textContent = "";

  if (!state.comparisons.length) {
    els.changesView.className = "changes-view empty-state";
    const h = document.createElement("h3");
    h.textContent = "Listo para escanear";
    const p = document.createElement("p");
    p.textContent = "Agrega carpetas, elige destino y ejecuta el escaneo.";
    els.changesView.appendChild(h);
    els.changesView.appendChild(p);
    return;
  }

  els.changesView.className = "changes-view";

  state.comparisons.forEach((comparison) => {
    const node = els.folderTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = comparison.sourceName;
    node.querySelector("p").textContent =
      Object.keys(comparison.manifest).length + " archivos revisados";

    const stats = node.querySelector(".folder-stats");
    stats.textContent = "";
    const badges = [
      { cls: "new", text: comparison.newFiles.length + " nuevos" },
      { cls: "changed", text: comparison.changedFiles.length + " cambiados" },
      { cls: "missing", text: comparison.missingFiles.length + " faltantes" },
    ];
    badges.forEach((b) => {
      const span = document.createElement("span");
      span.className = "badge " + b.cls;
      span.textContent = b.text;
      stats.appendChild(span);
    });

    node.querySelectorAll(".decision-row input").forEach((input) => {
      input.checked = comparison.decisions[input.dataset.kind];
      input.addEventListener("change", () => {
        comparison.decisions[input.dataset.kind] = input.checked;
        updateCounts();
      });
    });

    const groups = node.querySelector(".file-groups");
    groups.appendChild(
      fileGroup("Nuevos", comparison.newFiles, "Aparecen en el origen y no estaban en el historial.")
    );
    groups.appendChild(
      fileGroup("Cambiados", comparison.changedFiles, "Mismo nombre, distinto tamaño, fecha o hash.")
    );
    groups.appendChild(
      fileGroup(
        "Eliminados del origen",
        comparison.missingFiles,
        "Se registran, pero no se borran del backup."
      )
    );
    els.changesView.appendChild(node);
  });
}

function fileGroup(title, files, hint) {
  const details = document.createElement("details");
  details.className = "file-group";
  details.open = files.length > 0 && files.length <= 8;

  const summary = document.createElement("summary");
  const titleSpan = document.createElement("span");
  titleSpan.textContent = title;
  const countSpan = document.createElement("span");
  countSpan.textContent = files.length;
  summary.appendChild(titleSpan);
  summary.appendChild(countSpan);
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "file-list";

  if (!files.length) {
    const row = document.createElement("div");
    row.className = "file-row";
    const strong = document.createElement("strong");
    strong.textContent = "Sin archivos";
    const empty = document.createElement("span");
    const hintSpan = document.createElement("span");
    hintSpan.textContent = hint;
    row.appendChild(strong);
    row.appendChild(empty);
    row.appendChild(hintSpan);
    list.appendChild(row);
  } else {
    files.slice(0, MAX_RENDERED_FILES).forEach((file) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const nameEl = document.createElement("strong");
      nameEl.textContent = file.path;
      nameEl.title = file.path;
      const sizeEl = document.createElement("span");
      sizeEl.textContent = formatBytes(file.size);
      const dateEl = document.createElement("span");
      dateEl.textContent = new Date(file.lastModified).toLocaleString();
      row.appendChild(nameEl);
      row.appendChild(sizeEl);
      row.appendChild(dateEl);
      list.appendChild(row);
    });
    if (files.length > MAX_RENDERED_FILES) {
      const row = document.createElement("div");
      row.className = "file-row";
      const more = document.createElement("strong");
      more.textContent = "+ " + (files.length - MAX_RENDERED_FILES) + " más";
      const empty = document.createElement("span");
      const note = document.createElement("span");
      note.textContent = "Se copiarán aunque no se listen aquí.";
      row.appendChild(more);
      row.appendChild(empty);
      row.appendChild(note);
      list.appendChild(row);
    }
  }

  details.appendChild(list);
  return details;
}

function computePlannedBytes() {
  let bytes = 0;
  for (const comparison of state.comparisons) {
    if (comparison.decisions.new) {
      bytes += comparison.newFiles.reduce((t, f) => t + f.size, 0);
    }
    if (comparison.decisions.changed) {
      const changedBytes = comparison.changedFiles.reduce((t, f) => t + f.size, 0);
      bytes += changedBytes;
      if (els.versioningToggle.checked) bytes += changedBytes; // copia adicional de versión
    }
  }
  return bytes;
}

async function backupAll() {
  if (state.busy || !state.destination) {
    if (!state.destination) log("Elige un destino antes de copiar.");
    return;
  }

  const plannedBytes = computePlannedBytes();
  els.spaceWarning.hidden = true;
  if (plannedBytes > 0 && plannedBytes * SPACE_SAFETY_MARGIN > state.destination.free) {
    els.spaceWarning.hidden = false;
    els.spaceWarning.textContent =
      "Espacio insuficiente: se necesitan aprox. " + formatBytes(plannedBytes) +
      " y el disco tiene " + formatBytes(state.destination.free) + " libres. Libera espacio o reduce lo seleccionado.";
    log("Backup cancelado: espacio insuficiente en el destino.");
    return;
  }

  setBusy(true);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let totalCopied = 0;
  let totalDeduped = 0;

  const dedup = els.dedupToggle.checked;

  try {
    for (const comparison of state.comparisons) {
      const selected = [
        ...(comparison.decisions.new ? comparison.newFiles : []),
        ...(comparison.decisions.changed ? comparison.changedFiles : []),
      ];
      const removingMissing = comparison.decisions.missing && comparison.missingFiles.length > 0;

      // Aunque no haya nada para copiar, si el usuario aceptó "eliminados" hay
      // que seguir para actualizar el manifiesto (si no, esos archivos seguirían
      // marcándose como faltantes en cada escaneo aunque el usuario ya lo aceptó).
      if (!selected.length && !removingMissing) continue;

      const tasks = [];
      const versionTasks = [];
      for (const item of selected) {
        const destRelative = BACKUP_ROOT + "/" + safeName(comparison.sourceName) + "/" + item.path;
        tasks.push({
          srcPath: item.fullPath,
          destRoot: state.destination.root,
          relativeDest: destRelative,
        });

        if (els.versioningToggle.checked && item.previous) {
          const versionRelative =
            BACKUP_ROOT +
            "/.kopia-data/versions/" +
            stamp +
            "/" +
            safeName(comparison.sourceName) +
            "/" +
            item.path;
          versionTasks.push({
            srcPath: item.fullPath,
            destRoot: state.destination.root,
            relativeDest: versionRelative,
          });
        }
      }

      if (tasks.length) {
        const totalBytes = selected.reduce((t, f) => t + f.size, 0);
        const avgSize = selected.length ? totalBytes / selected.length : 0;
        let concurrency = 3;
        try {
          const plan = await window.kopiaAPI.planConcurrency(state.destination.root, avgSize);
          concurrency = plan.concurrency;
          els.driveInfo.textContent =
            "Disco " + (plan.driveInfo.mediaType || "desconocido") +
            " (" + (plan.driveInfo.busType || "?") + ") — concurrencia: " + plan.concurrency;
        } catch {
          // se usa el valor por defecto
        }

        const result = await window.kopiaAPI.backupCopyFiles(tasks, { dedup, concurrency });
        totalCopied += result.copied;
        totalDeduped += result.deduped || 0;

        if (result.errors.length) {
          result.errors.forEach((e) => log("Error: " + e.file + " — " + e.error));
        }

        if (versionTasks.length) {
          const versionResult = await window.kopiaAPI.backupCopyVersions(versionTasks);
          if (versionResult.errors.length) {
            versionResult.errors.forEach((e) => log("Error al guardar versión: " + e.file + " — " + e.error));
          }
        }
      }

      const nextManifest = { ...comparison.previousManifest };
      selected.forEach((item) => {
        const entry = { ...comparison.manifest[item.path] };
        delete entry.fullPath;
        nextManifest[item.path] = entry;
      });
      if (comparison.decisions.missing) {
        comparison.missingFiles.forEach((item) => delete nextManifest[item.path]);
      }

      await window.kopiaAPI.saveManifest(state.destination.root, comparison.sourceName, nextManifest);
      await window.kopiaAPI
        .rememberSourcePath(state.destination.root, comparison.sourceName, comparison.sourcePath)
        .catch(() => {});

      const report = {
        date: new Date().toISOString(),
        source: comparison.sourceName,
        copied: selected.length,
        skippedNew: comparison.decisions.new ? 0 : comparison.newFiles.length,
        skippedChanged: comparison.decisions.changed ? 0 : comparison.changedFiles.length,
        missingRegistered: comparison.decisions.missing
          ? comparison.missingFiles.map((f) => f.path)
          : [],
      };
      await window.kopiaAPI.logSave(state.destination.root, comparison.sourceName, report);
      log(
        comparison.sourceName + ": " + selected.length + " archivos copiados." +
          (removingMissing ? " Eliminados registrados: " + comparison.missingFiles.length + "." : "")
      );
    }

    state.copied = totalCopied;
    updateCounts();
    let summary = "Copia finalizada: " + totalCopied + " archivos.";
    if (totalDeduped > 0) summary += " (" + totalDeduped + " deduplicados sin copiar bytes nuevos)";
    log(summary);
  } catch (error) {
    log("Error en backup: " + error.message);
  } finally {
    setBusy(false);
    hideProgress();
  }
}

// --- Pestaña "Comparar": ejecutar la comparación de lo marcado -------------

async function compareSelected() {
  if (state.busy || !state.destination) {
    if (!state.destination) log("Selecciona un disco con backup para comparar.");
    return;
  }

  const selected = state.compareSources
    .map((name) => ({ name, sel: state.compareSelection[name] }))
    .filter((x) => x.sel && x.sel.checked);

  if (!selected.length) {
    log("Marca al menos una carpeta para comparar.");
    return;
  }

  const missingLocal = selected.find((x) => !x.sel.localPath);
  if (missingLocal) {
    log("Elige la carpeta local de '" + missingLocal.name + "' antes de comparar.");
    return;
  }

  setBusy(true);
  els.compareResults.textContent = "";
  els.compareResults.className = "changes-view";

  try {
    for (const { name: sourceName, sel } of selected) {
      log("Comparando backup '" + sourceName + "' vs " + sel.localPath + "...");
      showProgress("Comparando...", 0, 1, sourceName);

      const result = await window.kopiaAPI.restoreScan(state.destination.root, sourceName, sel.localPath);
      await window.kopiaAPI.rememberSourcePath(state.destination.root, sourceName, sel.localPath).catch(() => {});

      if (!result.missing.length) {
        log(sourceName + ": todos los archivos están presentes en el PC.");
        const card = document.createElement("div");
        card.className = "restore-card";
        const header = document.createElement("header");
        const info = document.createElement("div");
        const h3 = document.createElement("h3");
        h3.textContent = sourceName;
        const p = document.createElement("p");
        p.textContent =
          result.totalChecked +
          " archivos verificados — todo presente en: " +
          sel.localPath;
        info.appendChild(h3);
        info.appendChild(p);
        header.appendChild(info);
        card.appendChild(header);
        els.compareResults.appendChild(card);
        continue;
      }

      log(
        sourceName +
          ": " +
          result.missing.length +
          " archivos no encontrados en el PC."
      );

      renderMissingFilesCard(sourceName, sel.localPath, result.missing);
    }
  } catch (error) {
    log("Error en comparación: " + error.message);
  } finally {
    setBusy(false);
    hideProgress();
  }
}

function renderMissingFilesCard(sourceName, localPath, missingFiles) {
  const card = document.createElement("div");
  card.className = "restore-card";

  const header = document.createElement("header");
  const info = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = sourceName;
  const p = document.createElement("p");
  p.textContent = missingFiles.length + " archivos no encontrados en: " + localPath;
  info.appendChild(h3);
  info.appendChild(p);
  const badge = document.createElement("span");
  badge.className = "badge missing";
  badge.textContent = missingFiles.length + " faltantes";
  header.appendChild(info);
  header.appendChild(badge);
  card.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "restore-actions";

  const selectAllLabel = document.createElement("label");
  selectAllLabel.className = "restore-select-all";
  const selectAllCb = document.createElement("input");
  selectAllCb.type = "checkbox";
  selectAllCb.checked = true;
  const selectAllText = document.createElement("span");
  selectAllText.textContent = "Seleccionar todos";
  selectAllLabel.appendChild(selectAllCb);
  selectAllLabel.appendChild(selectAllText);

  const restoreSelectedBtn = document.createElement("button");
  restoreSelectedBtn.className = "primary";
  restoreSelectedBtn.textContent = "Restaurar seleccionados";
  restoreSelectedBtn.style.width = "auto";
  restoreSelectedBtn.style.padding = "0 20px";

  actions.appendChild(selectAllLabel);
  actions.appendChild(restoreSelectedBtn);
  card.appendChild(actions);

  const fileList = document.createElement("div");
  fileList.className = "file-list";
  const checkboxes = [];

  missingFiles.slice(0, MAX_RENDERED_FILES).forEach((file) => {
    const row = document.createElement("div");
    row.className = "restore-file-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.path = file.path;
    cb.dataset.backupFullPath = file.backupFullPath;
    checkboxes.push(cb);

    const nameEl = document.createElement("strong");
    nameEl.textContent = file.path;
    nameEl.title = file.path;
    const sizeEl = document.createElement("span");
    sizeEl.textContent = formatBytes(file.size);
    const dateEl = document.createElement("span");
    dateEl.textContent = new Date(file.lastModified).toLocaleString();

    row.appendChild(cb);
    row.appendChild(nameEl);
    row.appendChild(sizeEl);
    row.appendChild(dateEl);
    fileList.appendChild(row);
  });

  if (missingFiles.length > MAX_RENDERED_FILES) {
    const row = document.createElement("div");
    row.className = "restore-file-row";
    const spacer = document.createElement("span");
    const more = document.createElement("strong");
    more.textContent = "+ " + (missingFiles.length - MAX_RENDERED_FILES) + " más";
    row.appendChild(spacer);
    row.appendChild(more);
    fileList.appendChild(row);
  }

  card.appendChild(fileList);
  els.compareResults.appendChild(card);

  selectAllCb.addEventListener("change", () => {
    checkboxes.forEach((cb) => (cb.checked = selectAllCb.checked));
  });

  restoreSelectedBtn.addEventListener("click", async () => {
    const toRestore = checkboxes
      .filter((cb) => cb.checked)
      .map((cb) => ({
        path: cb.dataset.path,
        backupFullPath: cb.dataset.backupFullPath,
      }));

    if (!toRestore.length) {
      log("No hay archivos seleccionados para restaurar.");
      return;
    }

    const targetDir = await window.kopiaAPI.selectRestoreTarget();
    if (!targetDir) return;

    setBusy(true);
    try {
      const avgSize = toRestore.reduce((t, f) => t + (f.size || 0), 0) / toRestore.length;
      let concurrency = 3;
      try {
        const plan = await window.kopiaAPI.planConcurrency(state.destination.root, avgSize);
        concurrency = plan.concurrency;
      } catch {
        // se usa el valor por defecto
      }

      const result = await window.kopiaAPI.restoreCopyFiles(toRestore, targetDir, { concurrency });
      log("Restaurados: " + result.copied + " archivos a " + targetDir);
      if (result.errors.length) {
        result.errors.forEach((e) => log("Error restaurando: " + e.file + " — " + e.error));
      }
    } catch (error) {
      log("Error en restauración: " + error.message);
    } finally {
      setBusy(false);
      hideProgress();
    }
  });
}

// --- Pestaña "Restaurar": traer una carpeta completa del backup a donde sea ---

// No depende de comparar contra una carpeta local: sirve justo cuando esa
// carpeta (o el usuario de Windows) ya no existe, por ejemplo tras formatear.
async function loadFullRestoreList() {
  els.restoreFullList.textContent = "";

  if (!state.destination) {
    els.restoreFullList.classList.add("empty");
    els.restoreFullList.textContent = "Selecciona un disco con backup.";
    return;
  }

  try {
    const sources = await window.kopiaAPI.restoreListSources(state.destination.root);
    if (!sources.length) {
      els.restoreFullList.classList.add("empty");
      els.restoreFullList.textContent = "No se encontraron backups en " + state.destination.root;
      return;
    }

    els.restoreFullList.classList.remove("empty");
    sources.forEach((sourceName) => renderFullRestoreRow(sourceName));
  } catch (error) {
    els.restoreFullList.classList.add("empty");
    els.restoreFullList.textContent = "Error al leer el backup: " + error.message;
  }
}

function renderFullRestoreRow(sourceName) {
  const row = document.createElement("div");
  row.className = "source-pill";

  const label = document.createElement("strong");
  label.textContent = sourceName;
  row.appendChild(label);

  const hintSpan = document.createElement("span");
  hintSpan.style.fontSize = "0.78rem";
  hintSpan.style.color = "var(--muted)";
  hintSpan.textContent = "Restaura todo el contenido a la carpeta que elijas";
  row.appendChild(hintSpan);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.style.width = "auto";
  btn.style.padding = "0 16px";
  btn.textContent = "Restaurar a...";
  row.appendChild(btn);

  btn.addEventListener("click", async () => {
    if (state.busy) return;

    const targetDir = await window.kopiaAPI.selectRestoreTarget();
    if (!targetDir) return;

    setBusy(true);
    try {
      const files = await window.kopiaAPI.restoreFullList(state.destination.root, sourceName);
      if (!files.length) {
        log(sourceName + ": el backup no tiene archivos para restaurar.");
        return;
      }
      log(sourceName + ": restaurando " + files.length + " archivo(s) en " + targetDir + "...");

      const avgSize = files.reduce((t, f) => t + (f.size || 0), 0) / files.length;
      let concurrency = 3;
      try {
        const plan = await window.kopiaAPI.planConcurrency(state.destination.root, avgSize);
        concurrency = plan.concurrency;
      } catch {
        // se usa el valor por defecto
      }

      const result = await window.kopiaAPI.restoreCopyFiles(files, targetDir, { concurrency });
      log(sourceName + ": restaurados " + result.copied + " de " + files.length + " archivo(s) en " + targetDir);
      if (result.errors.length) {
        result.errors.forEach((e) => log("Error restaurando: " + e.file + " — " + e.error));
      }
    } catch (error) {
      log("Error al restaurar '" + sourceName + "': " + error.message);
    } finally {
      setBusy(false);
      hideProgress();
    }
  });

  els.restoreFullList.appendChild(row);
}

async function saveState() {
  try {
    await window.kopiaAPI.saveSettings({
      sources: state.sources.map((s) => ({ name: s.name, path: s.path })),
      destinationRoot: state.destination?.root || null,
      versioning: els.versioningToggle.checked,
      hash: els.hashToggle.checked,
      dedup: els.dedupToggle.checked,
    });
  } catch {
    // non-critical
  }
}

async function loadState() {
  try {
    state.excludePatterns = await window.kopiaAPI.defaultExcludePatterns().catch(() => []);

    const settings = await window.kopiaAPI.loadSettings();
    if (!settings) return;

    if (settings.sources && settings.sources.length) {
      for (const s of settings.sources) {
        if (!state.sources.some((x) => x.path === s.path)) {
          const name = uniqueSourceName(s.name, s.path);
          state.sources.push({ name, path: s.path });
        }
      }
      renderSources();
    }

    if (typeof settings.versioning === "boolean") {
      els.versioningToggle.checked = settings.versioning;
    }
    if (typeof settings.hash === "boolean") {
      els.hashToggle.checked = settings.hash;
    }
    if (typeof settings.dedup === "boolean") {
      els.dedupToggle.checked = settings.dedup;
    }

    // Restore destination after drives load
    if (settings.destinationRoot) {
      state._pendingDestination = settings.destinationRoot;
    }
  } catch {
    // non-critical
  }
}

function applyPendingDestination() {
  if (!state._pendingDestination) return;
  const options = els.destinationSelect.options;
  for (let i = 0; i < options.length; i++) {
    if (options[i].value === state._pendingDestination) {
      els.destinationSelect.selectedIndex = i;
      selectDestination();
      break;
    }
  }
  delete state._pendingDestination;
}

function clearHistory() {
  state.comparisons = [];
  renderComparisons();
  log("Vista de cambios borrada. El manifiesto guardado no se modificó, así que el próximo escaneo seguirá siendo incremental.");
}

els.addSourceBtn.addEventListener("click", () => addSource().catch((e) => log(e.message)));
els.destinationSelect.addEventListener("change", () => {
  selectDestination().then(saveState);
});
els.refreshDrivesBtn.addEventListener("click", () =>
  loadDrives()
    .then(applyPendingDestination)
    .catch((e) => log(e.message))
);
els.scanBtn.addEventListener("click", () => scanAll().catch((e) => log(e.message)));
els.backupBtn.addEventListener("click", () => backupAll().catch((e) => log(e.message)));
els.clearHistoryBtn.addEventListener("click", clearHistory);
els.compareBtn.addEventListener("click", () => compareSelected().catch((e) => log(e.message)));
els.versioningToggle.addEventListener("change", saveState);
els.hashToggle.addEventListener("change", saveState);
els.dedupToggle.addEventListener("change", saveState);

initTheme();
renderSources();
renderComparisons();
loadQuickFolders();
loadState().then(() => {
  loadDrives().then(applyPendingDestination).catch((e) => log(e.message));
});
log("Kopia Desk iniciado.");
