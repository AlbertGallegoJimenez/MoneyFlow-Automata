/**
 * dashboard_exporter.gs
 * Exporta la hoja "Gastos" a un archivo data/gastos.json en el repo de GitHub.
 * Se llama automáticamente al final de processFolderCSVs() si hay filas nuevas,
 * y también puede ejecutarse manualmente desde el editor de Apps Script.
 *
 * Requisitos en config.gs:
 *   GITHUB_TOKEN      → Personal Access Token con permiso contents:write
 *   GITHUB_REPO_OWNER → Tu usuario de GitHub (ej. "albertgallego")
 *   GITHUB_REPO_NAME  → Nombre del repo (ej. "moneyflow-automata")
 *   GITHUB_BRANCH     → Rama destino (normalmente "main")
 */

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================

/**
 * Lee la hoja Gastos, genera el JSON y hace push al repo de GitHub.
 * @returns {boolean} true si el push fue exitoso
 */
function exportDashboardData() {
  logEvent("INFO", "Dashboard exporter: Iniciando exportación...");

  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    logEvent("INFO", "Dashboard exporter: Hoja vacía, nada que exportar.");
    return false;
  }

  // --- PASO 1: Leer datos de la hoja ---
  // Columnas: A=Fecha, B=Tipo, C=Categoría, D=Subcategoría, E=Descripción,
  //           F=Valor, G=Método de Pago, H=¿Gasto fijo?, I=ID, J=Hash, K=Concepto
  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // Solo A..G

  // --- PASO 2: Transformar a array de objetos ---
  const transactions = [];

  for (const row of data) {
    const fecha      = row[0];
    const tipo       = row[1] ? row[1].toString().trim() : "";
    const categoria  = row[2] ? row[2].toString().trim() : "";
    const subcat     = row[3] ? row[3].toString().trim() : "";
    const valor      = parseFloat(row[5]) || 0;
    const metodoPago = row[6] ? row[6].toString().trim() : "";

    // Saltamos filas vacías o con categorías internas (marcadores del reconciliador)
    if (!tipo || !categoria || categoria === "__BIZUM_PENDIENTE__") continue;

    // Formateamos la fecha como YYYY-MM-DD
    let fechaStr = "";
    if (fecha instanceof Date) {
      fechaStr = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else if (fecha) {
      fechaStr = fecha.toString().trim();
    }
    if (!fechaStr) continue;

    transactions.push({
      fecha:        fechaStr,
      tipo:         tipo,
      categoria:    categoria,
      subcategoria: subcat,
      descripcion:  (row[4] ? row[4].toString().trim() : subcat), // col E, fallback a subcategoría
      valor:        valor,
      metodo_pago:  metodoPago,
      banco:        _extractBank(metodoPago)
    });
  }

  logEvent("INFO", `Dashboard exporter: ${transactions.length} transacciones preparadas.`);

  // --- PASO 3: Construir el JSON final ---
  const payload = {
    last_updated: new Date().toISOString(),
    total_transactions: transactions.length,
    transactions: transactions
  };

  const jsonString = JSON.stringify(payload, null, 2);

  // --- PASO 4: Push a GitHub ---
  const success = _pushToGitHub(jsonString);

  if (success) {
    logEvent("INFO", "Dashboard exporter: Push a GitHub completado correctamente.");
  } else {
    logError("Dashboard exporter", "Fallo al hacer push a GitHub. Revisa el log para más detalles.");
  }

  return success;
}

// ==========================================
// PUSH A GITHUB VIA API REST
// ==========================================

/**
 * Sube el contenido JSON al archivo data/gastos.json del repo via GitHub API.
 * Si el archivo ya existe, obtiene su SHA actual para poder actualizarlo (requisito de la API).
 * @param {string} jsonContent - Contenido del JSON como string
 * @returns {boolean}
 */
function _pushToGitHub(jsonContent) {
  const token     = CONFIG.GITHUB_TOKEN;
  const owner     = CONFIG.GITHUB_REPO_OWNER;
  const repo      = CONFIG.GITHUB_REPO_NAME;
  const branch    = CONFIG.GITHUB_BRANCH || "main";
  const filePath  = "data/gastos.json";
  const apiUrl    = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept":        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type":  "application/json"
  };

  // --- Paso A: Obtener SHA del archivo actual (necesario para actualizarlo) ---
  let currentSha = null;
  try {
    const getResponse = UrlFetchApp.fetch(apiUrl + `?ref=${branch}`, {
      method: "GET",
      headers: headers,
      muteHttpExceptions: true
    });

    if (getResponse.getResponseCode() === 200) {
      const fileInfo = JSON.parse(getResponse.getContentText());
      currentSha = fileInfo.sha;
      logEvent("INFO", `Dashboard exporter: SHA actual del archivo: ${currentSha.substring(0, 8)}...`);
    } else if (getResponse.getResponseCode() === 404) {
      logEvent("INFO", "Dashboard exporter: El archivo no existe aún, se creará.");
    } else {
      logEvent("WARN", `Dashboard exporter: Respuesta inesperada al obtener SHA: ${getResponse.getResponseCode()}`);
    }
  } catch (e) {
    logError("Dashboard exporter / GET SHA", e.toString());
    return false;
  }

  // --- Paso B: Push del archivo (create o update según si existe) ---
  const commitMessage = `chore: actualizar gastos.json [${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")}]`;

  const putBody = {
    message: commitMessage,
    content: Utilities.base64Encode(jsonContent),
    branch:  branch
  };

  // Si el archivo ya existe, incluimos el SHA para que GitHub sepa que es un update
  if (currentSha) {
    putBody.sha = currentSha;
  }

  try {
    const putResponse = UrlFetchApp.fetch(apiUrl, {
      method: "PUT",
      headers: headers,
      payload: JSON.stringify(putBody),
      muteHttpExceptions: true
    });

    const responseCode = putResponse.getResponseCode();

    if (responseCode === 200 || responseCode === 201) {
      const result     = JSON.parse(putResponse.getContentText());
      const commitSha  = result?.commit?.sha?.substring(0, 8) || "?";
      logEvent("INFO", `Dashboard exporter: ✅ Commit ${commitSha} — "${commitMessage}"`);
      return true;
    } else {
      logError("Dashboard exporter / PUT",
        `HTTP ${responseCode}: ${putResponse.getContentText().substring(0, 300)}`);
      return false;
    }
  } catch (e) {
    logError("Dashboard exporter / PUT", e.toString());
    return false;
  }
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Extrae el nombre del banco a partir del campo Método de Pago.
 * Evita añadir una columna extra en la hoja Gastos.
 */
function _extractBank(metodoPago) {
  const m = metodoPago.toLowerCase();
  if (m.includes("trade republic")) return "Trade Republic";
  if (m.includes("caixabank") || m.includes("cuenta principal")) return "Caixabank";
  if (m.includes("myinvestor")) return "MyInvestor";
  return "Otro";
}