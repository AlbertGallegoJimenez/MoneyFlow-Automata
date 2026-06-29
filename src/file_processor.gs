/**
 * file_processor.gs
 * Detecta automáticamente el banco y procesa los datos para MoneyFlow-Automata.
 */

const MY_NAMES = [
  "ALBERT GALLEGO JIMENEZ",
  "Albert Revolut",
  "Albert MyInvestor"
]; 
const SELF_TRANSFER_CONCEPT = "nomina"; 

// ==========================================
// FIRMAS DE BANCOS (#1: Detección robusta)
// ==========================================
// Cada firma es la primera línea del CSV normalizada (sin BOM, sin espacios extra,
// sin comillas, en minúsculas). Añadir un banco nuevo = añadir una entrada aquí.
const BANK_SIGNATURES = {
  "Trade Republic": [
    // Formato nativo 2026 (separado por comas, con comillas)
    "datetime,date,account_type,status,description,type,name,iban,amount,unit,amount,fee,tax,gross_amount,net_amount,fx_rate,fx_currency,description",
    // Fallback por campo distintivo por si cambian alguna columna menor
    "datetime,date,account_type"
  ],
  "Caixabank": [
    "concepte;data;import;saldo"
  ],
  "MyInvestor": [
    "fecha de operación;fecha de valor;concepto;importe;divisa"
  ]
};

/**
 * Detecta el banco a partir de la primera línea del CSV.
 * Normaliza: elimina BOM, comillas, espacios extra y convierte a minúsculas.
 * @param {string} csvContent - Contenido completo del CSV (ya sin BOM externo)
 * @returns {string|null} - Nombre del banco o null si no se reconoce
 */
function detectBank(csvContent) {
  // Guarda defensiva: csvContent puede ser undefined si getDataAsString() falla
  // (archivo vacío, encoding no soportado, o blob corrupto)
  if (!csvContent || typeof csvContent !== 'string' || csvContent.trim().length === 0) {
    Logger.log("⚠️ detectBank: csvContent vacío o inválido.");
    return null;
  }

  const firstLine = csvContent.split('\n')[0]
    .replace(/\r/g, '')    // saltos de línea Windows
    .replace(/"/g, '')      // comillas
    .replace(/\s+/g, ' ')  // espacios múltiples
    .trim()
    .toLowerCase();

  if (!firstLine) {
    Logger.log("⚠️ detectBank: primera línea vacía tras normalizar.");
    return null;
  }

  for (const [bankName, signatures] of Object.entries(BANK_SIGNATURES)) {
    for (const sig of signatures) {
      if (firstLine.startsWith(sig.toLowerCase())) {
        return bankName;
      }
    }
  }
  return null;
}

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================
function processFolderCSVs() {
  // --- INICIO DE LOG (#8) ---
  initLogger();

  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const processedFolder = DriveApp.getFolderById(CONFIG.PROCESSED_FOLDER_ID);
  const files = folder.getFilesByType(MimeType.CSV);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CASH_FLOW_SHEET_NAME);
  const existingHashes = getExistingHashes(sheet);
  let nextSequenceNum = getNextTrnNumber(sheet);

  while (files.hasNext()) {
    const file = files.next();

    // getDataAsString puede fallar con archivos corruptos o encodings no soportados,
    // o devolver cadena vacía sin lanzar excepción (archivo vacío o ilegible)
    let csvContent;
    try {
      csvContent = file.getBlob().getDataAsString('UTF-8').replace(/^\ufeff/, "");

      // Si UTF-8 devuelve vacío, reintentamos con ISO-8859-1 antes de rendirse
      if (!csvContent || csvContent.trim().length === 0) {
        logEvent("INFO", `Archivo "${file.getName()}" vacío en UTF-8, reintentando con ISO-8859-1...`);
        csvContent = file.getBlob().getDataAsString('ISO-8859-1').replace(/^\ufeff/, "");
      }
    } catch (e) {
      // Fallback explícito a ISO-8859-1 si UTF-8 lanza excepción
      try {
        csvContent = file.getBlob().getDataAsString('ISO-8859-1').replace(/^\ufeff/, "");
        logEvent("INFO", `Archivo "${file.getName()}" leído con encoding ISO-8859-1 (fallback por excepción)`);
      } catch (e2) {
        logError(`Lectura de archivo "${file.getName()}"`, e2.toString());
        logSkippedFile(file.getName(), "(no se pudo leer el contenido)");
        continue;
      }
    }

    if (!csvContent || csvContent.trim().length === 0) {
      logSkippedFile(file.getName(), "(archivo vacío tras intentar UTF-8 e ISO-8859-1)");
      continue;
    }

    // --- DETECTOR DE BANCOS (#1) ---
    logEvent("INFO", `Procesando archivo: "${file.getName()}" | Tamaño: ${file.getSize()} bytes | Primeros 80 chars: ${csvContent.substring(0, 80).replace(/\n/g, "↵")}`);
    const detectedBank = detectBank(csvContent);
    if (!detectedBank) {
      logSkippedFile(file.getName(), csvContent.split('\n')[0]);
      continue;
    }
    logEvent("INFO", `Detectado formato: ${detectedBank} | Archivo: ${file.getName()}`);

    let parsedTransactions = [];
    try {
      if (detectedBank === "Trade Republic") {
        parsedTransactions = parseTradeRepublicCSV(csvContent);
      } else if (detectedBank === "Caixabank") {
        parsedTransactions = parseCaixabankCSV(csvContent);
      } else if (detectedBank === "MyInvestor") {
        parsedTransactions = parseMyInvestorCSV(csvContent);
      }
    } catch (e) {
      logError(`Parser ${detectedBank}`, e.toString());
      continue;
    }

    // --- ORDENAMIENTO CRONOLÓGICO ---
    parsedTransactions.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));

    // --- PROCESADO E INSERCIÓN ---
    let fileRows = [];
    parsedTransactions.forEach(trn => {
      if (!isDuplicate(trn.id, existingHashes)) {
        const newRows = processTransactionLogic(trn, trn.id, trn.sourceBank, nextSequenceNum, sheet);
        fileRows = fileRows.concat(newRows);
        nextSequenceNum += (trn.isSpecial === "Saveback" ? 2 : 1);
      }
    });

    if (fileRows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, fileRows.length, fileRows[0].length).setValues(fileRows);
    }

    logFileProcessed(file.getName(), detectedBank, fileRows.length);
    file.moveTo(processedFolder);
  }

  // --- RECONCILIACIÓN DE BIZUMS ---
  // Debe ejecutarse antes de Gemini para que los Bizums convertidos a ingreso
  // pasen también por la categorización automática si quedan como "Otros/Bizum"
  const bizumResult = reconcileBizums();
  logEvent("INFO",
    `Bizums: ${bizumResult.adjusted} gasto(s) ajustado(s), ` +
    `${bizumResult.converted} convertido(s) a ingreso, ` +
    `${bizumResult.bizumRowsRemoved} fila(s) eliminada(s).`
  );

  // --- PENDIENTES: recogemos las filas sin categoría para incluirlas en el email ---
  const stillPending = getStillPendingRows(sheet);
  logGeminiResult(0, stillPending.length, stillPending);

  // --- EXPORTACIÓN AL DASHBOARD ---
  // Solo exportamos si hubo cambios reales en la hoja
  //if (_logSession && _logSession.newRowsTotal > 0) {
  //  exportDashboardData();
  //}

  // --- CIERRE: LOG + EMAIL (#8 + #10) ---
  resetHistoryCache();
  finalizeLogger(CONFIG.NOTIFICATION_EMAIL);
}

// ==========================================
// HELPER: DETECCIÓN DE DELIMITADOR
// ==========================================

/**
 * Detecta el delimitador real de un CSV analizando la primera línea.
 * Cuenta ocurrencias de cada candidato y devuelve el más frecuente.
 * @param {string} csvContent
 * @returns {string} - ',' | ';' | '\t'
 */
function detectDelimiter(csvContent) {
  const firstLine = csvContent.split('\n')[0].replace(/\r/g, '');
  const candidates = [';', ',', '\t'];
  let best = ';'; // fallback por defecto para Caixabank/MyInvestor
  let bestCount = 0;
  for (const delim of candidates) {
    const count = firstLine.split(delim).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = delim;
    }
  }
  Logger.log(`🔍 Delimitador detectado: "${best === '\t' ? 'TAB' : best}" (${bestCount} ocurrencias en primera línea)`);
  return best;
}

// ==========================================
// PARSER 1: TRADE REPUBLIC (HEADER 2026 — 23 columnas)
// datetime,date,account_type,category,type,asset_class,name,symbol,
// shares,price,amount,fee,tax,currency,original_amount,original_currency,
// fx_rate,description,transaction_id,counterparty_name,counterparty_iban,
// payment_reference,mcc_code
// ==========================================
function parseTradeRepublicCSV(csvString) {
  const csvData = Utilities.parseCsv(csvString, ',');
  if (csvData.length < 2) return [];

  // Construimos el mapa de columnas por nombre (igual que Caixabank y MyInvestor)
  const headerRow = csvData[0].map(h => h.trim().toLowerCase());
  const col = {
    date:             headerRow.indexOf("date"),
    type:             headerRow.indexOf("type"),
    name:             headerRow.indexOf("name"),
    amount:           headerRow.indexOf("amount"),
    fee:              headerRow.indexOf("fee"),
    tax:              headerRow.indexOf("tax"),
    description:      headerRow.indexOf("description"),
    counterpartyName: headerRow.indexOf("counterparty_name"),
    counterpartyIban: headerRow.indexOf("counterparty_iban")
  };

  // Validación de columnas esenciales
  const essential = ["date", "type", "amount"];
  const missing = essential.filter(k => col[k] === -1);
  if (missing.length > 0) {
    Logger.log("❌ TR: Columnas no encontradas: " + missing.join(", ")
      + ". Headers: " + headerRow.join(" | "));
    return [];
  }

  const rawTransactions = [];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 10) continue;

    const date            = (row[col.date]             || "").trim();
    const type            = (row[col.type]             || "").trim();
    const name            = (row[col.name]             || "").trim();
    const amount          = parseFloat(row[col.amount]) || 0;
    const fee             = parseFloat(row[col.fee])    || 0;
    const tax             = parseFloat(row[col.tax])    || 0;
    const description     = (row[col.description]      || "").replace(/null$/i, "").trim();
    const counterpartyName = col.counterpartyName !== -1 ? (row[col.counterpartyName] || "").trim() : "";

    // Filtro de transferencias propias
    if (MY_NAMES.some(n => description.includes(n) || counterpartyName.includes(n))) continue;

    // Flujo de caja neto
    const netAmount = amount + fee + tax;
    if (Math.abs(netAmount) < 0.01 && type !== "CARD_ORDERING_FEE") continue;

    const typeUpper = type.toUpperCase();
    const descUpper = description.toUpperCase();

    let specialFlag = "no";
    let finalTitle  = name || description;

    // --- BIZUM ENTRANTE ---
    if (typeUpper === "TRANSFER_INSTANT_INBOUND") {
      specialFlag = "BizumInbound";
      finalTitle  = counterpartyName || name || "Bizum entrante";

    // --- BIZUM SALIENTE ---
    } else if (typeUpper === "TRANSFER_INSTANT_OUTBOUND") {
      specialFlag = "BizumOutbound";
      finalTitle  = counterpartyName || name || "Bizum saliente";

    // --- SAVEBACK (doble asiento) ---
    } else if (typeUpper.includes("SAVEBACK") || descUpper.includes("SAVEBACK")) {
      if (netAmount > 0) {
        specialFlag = "Saveback";
        finalTitle  = "Saveback TR";
      } else {
        continue; // La línea negativa la generamos nosotros
      }

    // --- ROUND UP ---
    } else if (descUpper.includes("ROUND UP")) {
      finalTitle = "Round Up TR";
    }

    rawTransactions.push({
      bookingDate:       date,
      title:             finalTitle,
      amount:            netAmount,
      isSpecial:         specialFlag,
      sourceBank:        "Trade Republic",
      originalAmountStr: netAmount.toFixed(4),
      counterpartyName:  counterpartyName  // Guardamos para el reconciliador de Bizums
    });
  }

  const finalTransactions = filterPreAuthPairs(rawTransactions);
  return finalTransactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "TR");
    return t;
  });
}

// ==========================================
// PARSER 2: CAIXABANK (#3: Por nombre de header, no posición)
// ==========================================
function parseCaixabankCSV(rawString) {
  const delimiter = detectDelimiter(rawString);
  const csvData = Utilities.parseCsv(rawString, delimiter);

  if (csvData.length < 2) {
    Logger.log("⚠️ Caixabank: CSV vacío o sin datos.");
    return [];
  }

  // --- Construcción del mapa de columnas por nombre de header (#3) ---
  const headerRow = csvData[0].map(h => h.trim().toLowerCase());
  const colIndex = {
    concept: headerRow.indexOf("concepte"),
    date:    headerRow.indexOf("data"),
    amount:  headerRow.indexOf("import"),
    balance: headerRow.indexOf("saldo")
  };

  // Validación: si falta alguna columna esencial, abortamos con mensaje claro
  const missingCols = Object.entries(colIndex)
    .filter(([key, idx]) => key !== "balance" && idx === -1) // saldo no es esencial
    .map(([key]) => key);
  if (missingCols.length > 0) {
    Logger.log("❌ Caixabank: No se encontraron columnas: " + missingCols.join(", ") 
      + ". Headers detectados: " + headerRow.join(" | "));
    return [];
  }

  let rawTransactions = [];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 3) continue;

    const rawConcept = row[colIndex.concept] || "";
    const rawDate    = row[colIndex.date]    || "";
    const rawAmount  = row[colIndex.amount]  || "";

    if (!rawConcept.trim() || !rawDate.trim() || !rawAmount.trim()) continue;

    // Limpieza de Fecha (DD/MM/YYYY -> YYYY-MM-DD)
    const dateParts = rawDate.trim().split('/');
    if (dateParts.length !== 3) {
      Logger.log("⚠️ Caixabank: Fecha con formato inesperado en fila " + i + ": " + rawDate);
      continue;
    }
    const cleanDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;

    // Limpieza de Importe: quitar "EUR", puntos de mil, cambiar coma decimal por punto
    let cleanAmountStr = rawAmount.replace("EUR", "").replace(/\./g, "").replace(",", ".").trim();
    let amountFloat = parseFloat(cleanAmountStr);
    if (isNaN(amountFloat)) {
      Logger.log("⚠️ Caixabank: Importe no parseable en fila " + i + ": " + rawAmount);
      continue;
    }

    // FILTRO: Transferencia a mí mismo (salida de nómina)
    if (rawConcept.trim() === SELF_TRANSFER_CONCEPT && amountFloat < 0) {
      Logger.log("Saltando transferencia propia (nomina salida): " + rawAmount);
      continue;
    }

    rawTransactions.push({
      bookingDate:       cleanDate,
      title:             rawConcept.trim(),
      amount:            amountFloat,
      isSpecial:         "no",
      sourceBank:        "Caixabank",
      originalAmountStr: cleanAmountStr
    });
  }

  const finalTransactions = filterPreAuthPairs(rawTransactions);

  return finalTransactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "CB");
    return t;
  });
}

// ==========================================
// PARSER 3: MYINVESTOR
// ==========================================
function parseMyInvestorCSV(rawString) {
  const delimiter = detectDelimiter(rawString);
  const csvData = Utilities.parseCsv(rawString, delimiter);

  if (csvData.length < 2) {
    Logger.log("⚠️ MyInvestor: CSV vacío o sin datos.");
    return [];
  }

  // Mapa de headers por nombre (consistente con la mejora de Caixabank)
  const headerRow = csvData[0].map(h => h.trim().toLowerCase());
  const colIndex = {
    date:    headerRow.indexOf("fecha de operación"),
    concept: headerRow.indexOf("concepto"),
    amount:  headerRow.indexOf("importe")
  };

  const missingCols = Object.entries(colIndex)
    .filter(([, idx]) => idx === -1)
    .map(([key]) => key);
  if (missingCols.length > 0) {
    Logger.log("❌ MyInvestor: No se encontraron columnas: " + missingCols.join(", ")
      + ". Headers detectados: " + headerRow.join(" | "));
    return [];
  }

  if (csvData.length > 1) Logger.log("MyInvestor - segunda fila (datos): " + JSON.stringify(csvData[1]));

  const rawTransactions = [];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 4) continue;

    const rawDate    = (row[colIndex.date]    || "").trim();
    const rawConcept = (row[colIndex.concept] || "").trim();
    const rawAmount  = (row[colIndex.amount]  || "").trim();

    if (!rawDate || !rawConcept || !rawAmount) continue;

    // Fecha: DD/MM/YYYY -> YYYY-MM-DD
    const dateParts = rawDate.split('/');
    if (dateParts.length !== 3) {
      Logger.log("⚠️ MyInvestor: Fecha con formato inesperado en fila " + i + ": " + rawDate);
      continue;
    }
    const cleanDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;

    const cleanAmountStr = rawAmount.replace(',', '.');
    const amountFloat = parseFloat(cleanAmountStr);
    if (isNaN(amountFloat)) {
      Logger.log("⚠️ MyInvestor: Importe no parseable en fila " + i + ": " + rawAmount);
      continue;
    }

    rawTransactions.push({
      bookingDate:       cleanDate,
      title:             rawConcept,
      amount:            amountFloat,
      isSpecial:         "no",
      sourceBank:        "MyInvestor",
      originalAmountStr: cleanAmountStr
    });
  }

  const finalTransactions = filterPreAuthPairs(rawTransactions);

  return finalTransactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "MI");
    return t;
  });
}

/**
 * Elimina transacciones que se anulan mutuamente en el mismo día.
 * Soporta dos casos:
 * 1. Mismo concepto + importes inversos
 * 2. Concepto "DEVOLUCIO COMPRA" + importes inversos (sin importar el concepto original)
 */
function filterPreAuthPairs(transactions) {
  const indicesToSkip = new Set();
  const refundKeywords = ["devolucio compra", "devolucion compra", "devolución"];
  
  for (let i = 0; i < transactions.length; i++) {
    if (indicesToSkip.has(i)) continue;

    for (let j = i + 1; j < transactions.length; j++) {
      if (indicesToSkip.has(j)) continue;

      const t1 = transactions[i];
      const t2 = transactions[j];

      const amountsCancel = Math.abs(t1.amount + t2.amount) < 0.01;
      const sameDate = t1.bookingDate === t2.bookingDate;
      
      if (!sameDate || !amountsCancel) continue;

      const sameConcept = t1.title === t2.title;
      const t1IsRefund = refundKeywords.some(kw => t1.title.toLowerCase().includes(kw));
      const t2IsRefund = refundKeywords.some(kw => t2.title.toLowerCase().includes(kw));

      if (sameConcept || t1IsRefund || t2IsRefund) {
        Logger.log(`Detectado par pre-autorización (Ignorando): "${t1.title}" ${t1.amount} / "${t2.title}" ${t2.amount}`);
        indicesToSkip.add(i);
        indicesToSkip.add(j);
        break;
      }
    }
  }

  return transactions.filter((_, index) => !indicesToSkip.has(index));
}