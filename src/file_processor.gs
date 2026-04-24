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
    
    let parsedTransactions = [];

    // --- DETECTOR DE BANCOS ---
    if (csvContent.includes('"datetime","date","account_type"') || csvContent.includes('transaction_id')) {
      Logger.log("Detectado formato: Trade Republic (Nativo)");
      parsedTransactions = parseTradeRepublicCSV(csvContent);

    } else if (csvContent.includes("Concept") || csvContent.includes("Saldo") || csvContent.includes("Concepte")) {
      Logger.log("Detectado formato: Caixabank");
      parsedTransactions = parseCaixabankCSV(csvContent);

    } else if (csvContent.includes("Fecha de operación") && csvContent.includes("Fecha de valor")) {
      Logger.log("Detectado formato: MyInvestor");
      parsedTransactions = parseMyInvestorCSV(csvContent);

    } else {
      Logger.log("❌ Formato desconocido en archivo: " + file.getName());
      continue;
    }

    // Procesar transacciones filtrando duplicados
    let fileRows = [];
    parsedTransactions.forEach(trn => {
      const trnHash = trn.id;
      if (!isDuplicate(trnHash, existingHashes)) {
        const newRows = processTransactionLogic(trn, trnHash, trn.sourceBank, nextSequenceNum);
        fileRows = fileRows.concat(newRows);
        
        // Si es Saveback, sumamos 2 al contador de IDs porque genera 2 filas
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
    const type = row[4];            // Columna 'type'
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
// PARSER 2: CAIXABANK
// ==========================================
function parseCaixabankCSV(csvString) {
  const csvData = Utilities.parseCsv(csvString, ';');
  const transactions = [];
  
  for (let i = 4; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 3 || !row[0]) continue;
    
    const amount = parseFloat(row[2].replace(/\./g, '').replace(',', '.'));
    if (amount === 0) continue;

    transactions.push({
      bookingDate: row[0].split('/').reverse().join('-'),
      title: row[1].trim(),
      amount: amount,
      isSpecial: "no",
      sourceBank: "Caixabank",
      originalAmountStr: amount.toFixed(2)
    });
  }
  
  const finalTransactions = filterPreAuthPairs(transactions);
  return finalTransactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "CAIXA");
    return t;
  });
}

// ==========================================
// PARSER 3: MYINVESTOR
// ==========================================
function parseMyInvestorCSV(csvString) {
  const csvData = Utilities.parseCsv(csvString, ';');
  const transactions = [];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 5) continue;

    const amount = parseFloat(row[4].replace(/\./g, '').replace(',', '.'));
    transactions.push({
      bookingDate: row[0].split('/').reverse().join('-'),
      title: row[2].trim(),
      amount: amount,
      isSpecial: "no",
      sourceBank: "MyInvestor",
      originalAmountStr: amount.toFixed(2)
    });
  }

  return transactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "MYINV");
    return t;
  });
}

/**
 * Elimina transacciones que se anulan mutuamente en el mismo día
 * Soporta dos casos:
 * 1. Mismo concepto + importes inversos
 * 2. Concepto "DEVOLUCIO COMPRA" + importes inversos (sin importar el concepto original)
 */
function filterPreAuthPairs(transactions) {
  const indicesToSkip = new Set();
  
  // Palabras clave para detectar devoluciones (case-insensitive)
  const refundKeywords = ["devolucio compra", "devolucion compra", "devolución"];
  
  for (let i = 0; i < transactions.length; i++) {
    if (indicesToSkip.has(i)) continue;

    for (let j = i + 1; j < transactions.length; j++) {
      if (indicesToSkip.has(j)) continue;

      const t1 = transactions[i];
      const t2 = transactions[j];

      // Verificar si los importes se cancelan (suma 0)
      const amountsCancel = Math.abs(t1.amount + t2.amount) < 0.01;
      
      // Verificar si están en la misma fecha
      const sameDate = t1.bookingDate === t2.bookingDate;
      
      if (!sameDate || !amountsCancel) continue;

      // CASO 1: Mismo concepto (Trade Republic y otros)
      const sameConcept = t1.title === t2.title;
      
      // CASO 2: Uno de los conceptos contiene palabra clave de devolución (Caixabank)
      const t1IsRefund = refundKeywords.some(keyword => 
        t1.title.toLowerCase().includes(keyword)
      );
      const t2IsRefund = refundKeywords.some(keyword => 
        t2.title.toLowerCase().includes(keyword)
      );
      const hasRefund = t1IsRefund || t2IsRefund;
      
      // Si cumple alguno de los dos casos, marcar como par a eliminar
      if (sameConcept || hasRefund) {
        Logger.log(`Detectado par pre-autorización (Ignorando): "${t1.title}" ${t1.amount} / "${t2.title}" ${t2.amount}`);
        indicesToSkip.add(i);
        indicesToSkip.add(j);
        break; // Ya encontramos su pareja, dejamos de buscar para este 'i'
      }
    }
  }

  return transactions.filter((_, index) => !indicesToSkip.has(index));
}