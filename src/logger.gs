/**
 * logger.gs
 * Log persistente en Google Drive + notificación por email al final de cada ejecución.
 *
 * Flujo:
 *   1. initLogger()        → llamar al inicio de processFolderCSVs()
 *   2. logEvent(...)       → llamar a lo largo del proceso para registrar eventos
 *   3. finalizeLogger(...) → llamar al final; escribe el .log en Drive y envía el email
 *
 * El archivo .log se guarda en la misma carpeta raíz del libro de cálculo,
 * con nombre: moneyflow_YYYY-MM-DD_HH-MM.log
 */

// ==========================================
// ESTADO DE LA SESIÓN DE LOG
// ==========================================
let _logSession = null;

/**
 * Inicializa la sesión de log. Llamar al inicio de processFolderCSVs().
 */
function initLogger() {
  _logSession = {
    startTime:        new Date(),
    lines:            [],          // Todas las líneas del log
    filesProcessed:   [],          // Nombres de archivos procesados
    newRowsTotal:     0,           // Total de filas insertadas
    rowsByBank:       {},          // { "Caixabank": 3, "Trade Republic": 5, ... }
    geminiResolved:   0,           // Pendientes resueltos por Gemini
    geminiFailed:     0,           // Pendientes que Gemini no pudo resolver
    pendingRows:      [],          // { sheetRow, concepto } — los que siguen pendientes al final
    errors:           [],          // Errores críticos
    skippedFiles:     []           // Archivos con formato desconocido
  };
  _log("INFO", "=== MoneyFlow-Automata — Inicio de ejecución ===");
}

// ==========================================
// FUNCIONES DE REGISTRO
// ==========================================

/**
 * Registra un evento genérico.
 * @param {"INFO"|"WARN"|"ERROR"|"GEMINI"|"SKIP"} level
 * @param {string} message
 */
function logEvent(level, message) {
  if (!_logSession) initLogger(); // Salvaguarda por si se llama sin init
  _log(level, message);
}

/** Registra un archivo procesado correctamente. */
function logFileProcessed(fileName, bank, rowsInserted) {
  if (!_logSession) initLogger();
  _logSession.filesProcessed.push(fileName);
  _logSession.newRowsTotal += rowsInserted;
  _logSession.rowsByBank[bank] = (_logSession.rowsByBank[bank] || 0) + rowsInserted;
  _log("INFO", `Archivo procesado: "${fileName}" [${bank}] → ${rowsInserted} filas nuevas`);
}

/** Registra un archivo con formato no reconocido. */
function logSkippedFile(fileName, firstLine) {
  if (!_logSession) initLogger();
  _logSession.skippedFiles.push(fileName);
  _log("SKIP", `Formato desconocido: "${fileName}" | Primera línea: ${firstLine.substring(0, 100)}`);
}

/** Registra el resultado de Gemini. */
function logGeminiResult(resolved, failed, pendingRows) {
  if (!_logSession) initLogger();
  _logSession.geminiResolved = resolved;
  _logSession.geminiFailed   = failed;
  _logSession.pendingRows    = pendingRows || [];
  _log("GEMINI", `Categorización Gemini: ${resolved} resueltos, ${failed} sin resolver`);
}

/** Registra un error crítico. */
function logError(context, errorMessage) {
  if (!_logSession) initLogger();
  _logSession.errors.push({ context, errorMessage });
  _log("ERROR", `[${context}] ${errorMessage}`);
}

// ==========================================
// FINALIZACIÓN: ESCRIBE LOG + ENVÍA EMAIL
// ==========================================

/**
 * Cierra la sesión: escribe el archivo .log en Drive y envía el email de resumen.
 * Llamar al final de processFolderCSVs(), después de Gemini.
 * @param {string} recipientEmail - Email donde enviar el resumen
 */
function finalizeLogger(recipientEmail) {
  if (!_logSession) return;

  const endTime   = new Date();
  const duration  = Math.round((endTime - _logSession.startTime) / 1000);
  const dateStr   = Utilities.formatDate(_logSession.startTime, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
  const fileLabel = Utilities.formatDate(_logSession.startTime, Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");

  _log("INFO", `=== Fin de ejecución — Duración: ${duration}s ===`);

  // --- 1. ESCRIBIR ARCHIVO .LOG EN DRIVE ---
  try {
    const logContent = _logSession.lines.join('\n');
    const fileName   = `moneyflow_${fileLabel}.log`;

    // Guardamos en la carpeta raíz del libro de cálculo
    const ssFile      = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
    const parentFolder = ssFile.getParents().next();

    parentFolder.createFile(fileName, logContent, MimeType.PLAIN_TEXT);
    Logger.log(`📄 Log guardado: ${fileName}`);
  } catch (e) {
    Logger.log("❌ Error al guardar el archivo de log: " + e.toString());
  }

  // --- 2. ENVIAR EMAIL DE RESUMEN ---
  try {
    const subject = _buildEmailSubject();
    const body    = _buildEmailBody(dateStr, duration);
    GmailApp.sendEmail(recipientEmail, subject, body, { name: "MoneyFlow-Automata" });
    Logger.log(`📧 Email de resumen enviado a ${recipientEmail}`);
  } catch (e) {
    Logger.log("❌ Error al enviar el email: " + e.toString());
  }

  _logSession = null; // Limpiamos para la próxima ejecución
}

// ==========================================
// CONSTRUCCIÓN DEL EMAIL
// ==========================================

function _buildEmailSubject() {
  const s = _logSession;
  if (s.errors.length > 0) {
    return `⚠️ MoneyFlow-Automata — Ejecución con errores (${s.errors.length})`;
  }
  if (s.newRowsTotal === 0 && s.filesProcessed.length === 0) {
    return `MoneyFlow-Automata — Sin novedades`;
  }
  const pendingStr = s.geminiFailed > 0 ? ` · ${s.geminiFailed} pendientes` : "";
  return `✅ MoneyFlow-Automata — ${s.newRowsTotal} transacciones nuevas${pendingStr}`;
}

function _buildEmailBody(dateStr, duration) {
  const s = _logSession;
  let body = "";

  body += `MONEYFLOW-AUTOMATA — RESUMEN DE EJECUCIÓN\n`;
  body += `${"─".repeat(50)}\n`;
  body += `Fecha:    ${dateStr}\n`;
  body += `Duración: ${duration} segundos\n\n`;

  // --- RESUMEN GENERAL ---
  body += `RESUMEN\n${"─".repeat(30)}\n`;
  if (s.filesProcessed.length === 0 && s.skippedFiles.length === 0) {
    body += `No se encontraron archivos CSV nuevos en la dropzone.\n\n`;
  } else {
    body += `Archivos procesados:  ${s.filesProcessed.length}\n`;
    body += `Filas insertadas:     ${s.newRowsTotal}\n`;

    if (Object.keys(s.rowsByBank).length > 0) {
      body += `\nDesglose por banco:\n`;
      for (const [bank, count] of Object.entries(s.rowsByBank)) {
        body += `  · ${bank}: ${count} filas\n`;
      }
    }
    body += "\n";
  }

  // --- CATEGORIZACIÓN GEMINI ---
  if (s.geminiResolved > 0 || s.geminiFailed > 0) {
    body += `CATEGORIZACIÓN AUTOMÁTICA (Gemini)\n${"─".repeat(30)}\n`;
    body += `Resueltos:   ${s.geminiResolved}\n`;
    body += `Sin resolver: ${s.geminiFailed}\n\n`;
  }

  // --- PENDIENTES QUE REQUIEREN ATENCIÓN MANUAL ---
  if (s.pendingRows.length > 0) {
    body += `PENDIENTES — REQUIEREN CATEGORIZACIÓN MANUAL\n${"─".repeat(30)}\n`;
    body += `Las siguientes ${s.pendingRows.length} transacciones no pudieron categorizarse automáticamente.\n`;
    body += `Encuéntralas en la hoja "Gastos" (columna C = "Pendiente Categorizar"):\n\n`;
    s.pendingRows.forEach((row, i) => {
      body += `  ${i + 1}. Fila ${row.sheetRow} — "${row.concepto}"\n`;
    });
    body += "\n";
  }

  // --- ARCHIVOS CON FORMATO DESCONOCIDO ---
  if (s.skippedFiles.length > 0) {
    body += `ARCHIVOS IGNORADOS (formato no reconocido)\n${"─".repeat(30)}\n`;
    s.skippedFiles.forEach(f => body += `  · ${f}\n`);
    body += "\n";
  }

  // --- ERRORES CRÍTICOS ---
  if (s.errors.length > 0) {
    body += `ERRORES\n${"─".repeat(30)}\n`;
    s.errors.forEach(e => body += `  · [${e.context}] ${e.errorMessage}\n`);
    body += "\n";
  }

  // --- ARCHIVOS PROCESADOS ---
  if (s.filesProcessed.length > 0) {
    body += `ARCHIVOS PROCESADOS\n${"─".repeat(30)}\n`;
    s.filesProcessed.forEach(f => body += `  · ${f}\n`);
    body += "\n";
  }

  body += `${"─".repeat(50)}\n`;
  body += `Este email ha sido generado automáticamente por MoneyFlow-Automata.\n`;

  return body;
}

// ==========================================
// HELPER INTERNO
// ==========================================

function _log(level, message) {
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  const line = `[${timestamp}] [${level.padEnd(6)}] ${message}`;
  _logSession.lines.push(line);
  Logger.log(line); // También visible en la consola de Apps Script
}
