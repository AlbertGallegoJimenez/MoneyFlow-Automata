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
  const firstLine = csvContent.split('\n')[0]
    .replace(/\r/g, '')       // saltos de línea Windows
    .replace(/"/g, '')        // comillas
    .replace(/\s+/g, ' ')     // espacios múltiples
    .trim()
    .toLowerCase();

  for (const [bankName, signatures] of Object.entries(BANK_SIGNATURES)) {
    for (const sig of signatures) {
      // Comprobamos si la primera línea EMPIEZA por la firma (tolerante a columnas extra al final)
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
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const processedFolder = DriveApp.getFolderById(CONFIG.PROCESSED_FOLDER_ID);
  const files = folder.getFilesByType(MimeType.CSV);
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const existingHashes = getExistingHashes(sheet);
  let nextSequenceNum = getNextTrnNumber(sheet);
  let totalNewRows = 0;

  while (files.hasNext()) {
    const file = files.next();
    // replace(/^\ufeff/, "") limpia el carácter invisible BOM que traen los CSV de TR
    const csvContent = file.getBlob().getDataAsString().replace(/^\ufeff/, "");

    // --- DETECTOR DE BANCOS (#1) ---
    const detectedBank = detectBank(csvContent);
    if (!detectedBank) {
      Logger.log("❌ Formato desconocido en archivo: " + file.getName());
      Logger.log("   Primera línea: " + csvContent.split('\n')[0].substring(0, 120));
      continue;
    }
    Logger.log("✅ Detectado formato: " + detectedBank + " | Archivo: " + file.getName());

    let parsedTransactions = [];
    if (detectedBank === "Trade Republic") {
      parsedTransactions = parseTradeRepublicCSV(csvContent);
    } else if (detectedBank === "Caixabank") {
      parsedTransactions = parseCaixabankCSV(csvContent);
    } else if (detectedBank === "MyInvestor") {
      parsedTransactions = parseMyInvestorCSV(csvContent);
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
      totalNewRows += fileRows.length;
    }

    file.moveTo(processedFolder);
  }

  Logger.log("✅ Proceso finalizado. Filas nuevas: " + totalNewRows);
}

// ==========================================
// PARSER 1: TRADE REPUBLIC (NATIVO 2026)
// ==========================================
function parseTradeRepublicCSV(csvString) {
  const csvData = Utilities.parseCsv(csvString, ',');
  const rawTransactions = [];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 18) continue;

    const date = row[1];            // Columna 'date'
    const type = row[4];            // Columna 'type' (antes era row[5], ahora row[4] según header)
    const name = row[6];            // Columna 'name'
    const amount = parseFloat(row[10]) || 0; // 'amount'
    const fee = parseFloat(row[11]) || 0;    // 'fee'
    const tax = parseFloat(row[12]) || 0;    // 'tax'
    const description = row[17].replace(/null$/i, '').trim(); // 'description'

    // Filtro de transferencias propias
    if (MY_NAMES.some(n => description.includes(n))) continue;

    // Cálculo del Flujo de Caja Real Neto
    const netAmount = amount + fee + tax;
    if (Math.abs(netAmount) < 0.01 && type !== "CARD_ORDERING_FEE") continue;

    const descUpper = description.toUpperCase();
    const typeUpper = (type || "").toUpperCase();
    
    let specialFlag = "no";
    let finalTitle = name || description;

    // LÓGICA DE DETECCIÓN PARA EL DOBLE ASIENTO
    if (typeUpper.includes("SAVEBACK") || descUpper.includes("SAVEBACK")) {
      if (netAmount > 0) {
        specialFlag = "Saveback";
        finalTitle = "Saveback TR";
      } else {
        // Saltamos la línea de gasto negativa que TR trae por defecto para el Saveback
        // porque la generaremos nosotros artificialmente para tener control total
        continue; 
      }
    } else if (descUpper.includes("ROUND UP")) {
      finalTitle = "Round Up TR";
    }

    rawTransactions.push({
      bookingDate: date,
      title: finalTitle,
      amount: netAmount,
      isSpecial: specialFlag,
      sourceBank: "Trade Republic",
      originalAmountStr: netAmount.toFixed(4)
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
  const delimiter = rawString.indexOf('\t') !== -1 ? '\t' : ';';
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
  const delimiter = rawString.indexOf('\t') !== -1 ? '\t' : ';';
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