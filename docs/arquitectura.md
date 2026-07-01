# Kopia Desk — Arquitectura del proyecto

## Qué hace la aplicación

Kopia Desk es una aplicación de escritorio Windows que realiza copias de seguridad
incrementales de carpetas locales hacia discos externos o USB. Compara el estado actual
de cada carpeta contra un manifiesto guardado en la sesión anterior, copia sólo lo que
cambió, y permite restaurar archivos que falten en el PC.

---

## Estructura de archivos

```
Kopia_Desk_Beta_1/
├── main.js                  ← Proceso principal de Electron (Node.js, acceso total al SO)
├── preload.js               ← Puente seguro entre main y la interfaz
├── package.json             ← Dependencias y configuración del empaquetado
├── assets/
│   └── Kopia_Desk.png       ← Icono de la aplicación
├── renderer/
│   ├── index.html           ← Estructura HTML de la interfaz
│   ├── app.js               ← Lógica de la interfaz (sin acceso a Node)
│   └── styles.css           ← Estilos visuales
└── docs/
    └── arquitectura.md      ← Este archivo
```

---

## Descripción de cada archivo

### `main.js` — Proceso principal

Corre en Node.js con acceso completo al sistema operativo. Es el único que puede
leer/escribir archivos, ejecutar comandos, y abrir ventanas.

**Responsabilidades:**
- Crear la ventana principal de Electron (`BrowserWindow`)
- Detectar discos conectados con `Get-Volume` (PowerShell)
- Resolver las carpetas típicas del usuario (`app.getPath`) para los accesos rápidos
- Escanear carpetas recursivamente, aplicando exclusiones, y recopilar metadatos de archivos
- Calcular hashes (completo y rápido) para verificación de contenido
- Copiar archivos con concurrencia adaptada al tipo de disco destino
- Deduplicar por contenido con hardlinks y comprimir versiones anteriores con gzip
- Guardar/cargar manifiestos JSON con el estado de cada backup
- Ocultar la carpeta de metadatos con atributos del sistema (`attrib +h +s`)
- Registrar un journal por operación de copia para detectar backups interrumpidos
- Guardar registros JSON de cada operación
- Gestionar configuración persistente del usuario
- Proteger rutas contra path traversal (`safePath`)

**Canales IPC expuestos:**

| Canal | Qué hace |
|---|---|
| `drives:list` | Lista discos con espacio disponible |
| `dialog:select-folder` | Abre diálogo para elegir carpeta origen |
| `dialog:select-restore-target` | Abre diálogo para elegir destino de restauración |
| `config:default-excludes` | Devuelve los patrones de exclusión por defecto |
| `fs:scan-directory` | Escanea recursivamente una carpeta, aplicando exclusiones |
| `fs:hash-file` | Calcula SHA-256 completo de un archivo |
| `fs:quick-hash` | Calcula un hash rápido (cabecera+cola de 64 KB) para confirmar cambios reales |
| `fs:copy-file` | Copia un archivo individual |
| `fs:read-text` | Lee un archivo de texto |
| `fs:write-text` | Escribe un archivo de texto |
| `fs:file-exists` | Comprueba si un archivo existe |
| `fs:hide-folder` | Aplica atributos oculto+sistema a una carpeta |
| `manifest:load` | Carga el manifiesto de una carpeta de origen |
| `manifest:save` | Guarda el manifiesto con copia de seguridad de versión anterior |
| `sources:remember` / `sources:known-paths` | Recuerda la ruta local de cada carpeta de origen para restaurar sin volver a preguntar |
| `folders:quick-list` | Devuelve las carpetas típicas del usuario (Imágenes, Documentos, Descargas, Música, Videos, Escritorio) que existan en el equipo |
| `backup:plan-concurrency` | Detecta el tipo de disco (SSD/HDD/USB) y sugiere la concurrencia de copia |
| `backup:copy-files` | Copia lotes de archivos con progreso en tiempo real; soporta deduplicación; registra un journal por operación |
| `backup:copy-versions` | Guarda versiones anteriores comprimidas con gzip |
| `journal:check` | Detecta un backup interrumpido en el destino y limpia los archivos parciales |
| `log:save` | Guarda un registro JSON de la operación |
| `restore:scan` | Compara manifiesto vs estado actual del PC (pestaña "Comparar") |
| `restore:full-list` | Lista TODO el contenido de una carpeta del backup, sin comparar contra nada (pestaña "Restaurar") |
| `restore:copy-files` | Restaura archivos del backup al PC |
| `restore:list-sources` | Lista carpetas disponibles en el backup |
| `settings:load` | Carga configuración del usuario |
| `settings:save` | Guarda configuración del usuario |

---

### `preload.js` — Puente seguro (contextBridge)

Corre en un contexto intermedio con acceso limitado. Expone `window.kopiaAPI` a la
interfaz usando `contextBridge.exposeInMainWorld`, que es el mecanismo oficial de
Electron para comunicación segura.

La interfaz sólo puede llamar a las funciones que este archivo expone explícitamente.
No tiene acceso a Node.js ni al sistema de archivos directamente.

---

### `renderer/index.html` — Estructura HTML

Define la estructura visual de la aplicación: barra superior con contadores, barra
lateral de controles, panel principal con pestañas (Backup / Restaurar), barra de
progreso y panel de registro.

Incluye un `<template>` reutilizable para las tarjetas de carpeta que se insertan
dinámicamente por `app.js`.

---

### `renderer/app.js` — Lógica de la interfaz

Corre en el renderer de Electron, sin acceso a Node.js. Se comunica con el proceso
principal exclusivamente a través de `window.kopiaAPI`.

**Responsabilidades:**
- Gestionar el estado de la aplicación en memoria (`state`)
- Mostrar y actualizar los elementos del DOM
- Orquestar el flujo de backup:
  1. Escanear carpetas origen
  2. Cargar manifiestos anteriores
  3. Calcular hashes si está activada la opción
  4. Comparar con manifiestos para detectar nuevos/cambiados/eliminados
  5. Enviar tareas de copia al proceso principal
  6. Actualizar manifiestos y guardar registro
- Orquestar el flujo de restauración
- Persistir configuración entre sesiones

**Estado principal (`state`):**

| Campo | Tipo | Descripción |
|---|---|---|
| `sources` | `{name, path}[]` | Carpetas de origen (agregadas por diálogo o accesos rápidos) |
| `destination` | `object \| null` | Disco destino con `root`/`free`/`total`/`label` |
| `comparisons` | `object[]` | Resultado del último escaneo por carpeta (nuevos/cambiados/eliminados) |
| `copied` | `number` | Total de archivos copiados en la última corrida |
| `busy` | `boolean` | Si hay una operación en curso (deshabilita botones) |

---

### `renderer/styles.css` — Estilos

Hoja de estilos CSS vanilla. Define una paleta de variables de color, componentes
reutilizables (botones, tarjetas, badges, barra de progreso con animación shimmer),
layout de dos columnas con sidebar, y breakpoints para pantallas pequeñas.

**Variables de color principales** (definidas en `:root`, con una versión oscura
en `:root[data-theme="dark"]` que sobreescribe los mismos nombres):

| Variable | Claro | Uso |
|---|---|---|
| `--blue` | `#0f6fbd` | Acciones primarias, contador de carpetas |
| `--green` | `#1f8a59` | Éxito, archivos copiados, botón de backup activo |
| `--amber` | `#b7791f` | Cambios detectados |
| `--red` | `#b4232b` | Archivos eliminados |
| `--muted` | `#64717f` | Texto secundario |
| `--panel` / `--panel-alt` | blancos | Fondos de tarjetas / barra lateral |
| `--overlay` | blanco translúcido | Fondo de topbar, workspace y panel de registro |

**Tema claro/oscuro**: `app.js` alterna el atributo `data-theme` en `<html>`
(`initTheme()` / botón `#themeToggle`) y guarda la preferencia en
`localStorage` (no pasa por `main.js`, es puramente visual). Todo el resto de
la hoja de estilos usa estas variables en vez de colores fijos, así que el
cambio de tema no requiere tocar ninguna otra regla.

---

### `package.json` — Configuración del proyecto

Define las dependencias (`electron`, `electron-builder`) y los scripts:

| Script | Qué hace |
|---|---|
| `npm start` | Lanza la app en modo desarrollo |
| `npm run build` | Empaqueta como instalador NSIS para Windows |

La configuración de `electron-builder` especifica el icono, el `appId`
(`com.kopiadesk.app`), y el target `nsis` que genera un instalador estándar de Windows.

---

## Flujo de backup paso a paso

```
Usuario elige carpetas origen + disco destino
         ↓
[app.js] Escanea cada carpeta origen (IPC → main.js)
         ↓
[main.js] scanDirectoryRecursive → devuelve mapa { relativePath → {size, mtime, hash} }
         ↓
[app.js] Carga manifiesto anterior de cada carpeta (IPC → main.js)
         ↓
[app.js] Compara escaneo vs manifiesto:
         - Archivo en escaneo pero no en manifiesto → NUEVO
         - Archivo en ambos con mtime/size diferente → CAMBIADO
         - Archivo en manifiesto pero no en escaneo → ELIMINADO
         ↓
[app.js] Muestra resultados, usuario acepta/omite categorías por carpeta
         ↓
[app.js] Construye lista de tareas de copia y las envía en lote (IPC → main.js)
         ↓
[main.js] Copia archivos con concurrencia 3, emite progreso por cada archivo
         ↓
[app.js] Actualiza manifiesto con el nuevo estado (IPC → main.js)
         ↓
[main.js] Guarda manifiesto JSON + oculta carpeta de metadatos
         ↓
[app.js] Guarda registro JSON de la operación
```

---

## Estructura del backup en disco destino

```
D:\KopiaDesk_Backup\
├── Fotos\              ← archivos copiados (estructura original preservada)
├── Documentos\         ← archivos copiados
└── .kopia-data\        ← oculta (atributo +h +s)
    ├── manifests\
    │   ├── Fotos.json         ← estado actual
    │   ├── Fotos.prev.json    ← estado anterior (1 versión atrás)
    │   └── Documentos.json
    ├── versions\       ← versiones anteriores de archivos cambiados
    └── logs\           ← registros JSON por operación
```

---

## Seguridad

- **Aislamiento de contexto**: `contextIsolation: true`, `nodeIntegration: false`.
  La interfaz no tiene acceso a Node.js; todo pasa por `preload.js`.
- **Path traversal**: `safePath()` resuelve y valida que el destino esté dentro
  del disco destino antes de cualquier operación de escritura.
- **Tamaño de manifiesto**: se rechaza si supera 50 MB (protección contra corrupción).
- **Validación de entradas**: las rutas se verifican antes de pasar a `execFileSync`.
- **Sin cifrado propio**: se probó un cifrado AES-256-GCM por archivo y se quitó
  porque no aportaba suficiente frente a cifrar el disco USB completo (BitLocker
  u otra herramienta a nivel de disco) — queda como posible mejora futura si se
  aborda ese enfoque en vez de cifrar archivo por archivo.
- **Deduplicación**: usa hardlinks de NTFS (`fs.link`) sobre un índice de
  contenido (`.kopia-data/content-index.json`, hash → ruta). Si el sistema de
  archivos no soporta el enlace, se recurre automáticamente a una copia normal.
- **Journal de operaciones**: antes de copiar, se escribe
  `.kopia-data/journal/<fecha>.json` con el estado de cada archivo (pendiente/
  hecho). Si la app se cierra abruptamente o el disco se desconecta a mitad de
  copia, la próxima vez que se seleccione ese destino (`journal:check`) se
  eliminan los archivos que quedaron a medio escribir, evitando que un backup
  parcial se confunda con uno completo.

---

## Notas de desarrollo

- Para construir el instalador en Windows, electron-builder necesita el paquete
  `winCodeSign` en su caché. Si falla con error de symlinks, copiar el directorio
  extraído manualmente a:
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`
- Ejecutar `npm start` desde **cmd como administrador** si hay problemas de permisos
  con la detección de discos o el atributo de carpetas ocultas.
- Variable de entorno para build sin firma de código:
  `set CSC_IDENTITY_AUTO_DISCOVERY=false && npm run build`
