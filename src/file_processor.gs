/**
 * file_processor.gs
 * Detecta automáticamente el banco (TR o Caixabank) y procesa los datos.
 */

const MY_NAMES = ["ALBERT GALLEGO JIMENEZ"]; // Filtro para TR
const SELF_TRANSFER_CONCEPT = "nomina";      // Filtro para Caixabank (la salida a TR)

function processFolderCSVs() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const processedFolder = DriveApp.getFolderById(CONFIG.PROCESSED_FOLDER_ID);
  const files = folder.getFilesByType(MimeType.CSV);
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  
  // 1. Obtenemos los Hashes existentes (Columna J) para no duplicar
  const existingHashes = getExistingHashes(sheet);
  
  // 2. Obtenemos el último número de secuencia TRN (Columna I) para seguir contando
  let nextSequenceNum = getNextTrnNumber(sheet);
  
  let totalNewRows = 0;

  while (files.hasNext()) {
    const file = files.next();
    const csvContent = file.getBlob().getDataAsString();
    
    let parsedTransactions = [];

    // --- DETECTOR DE BANCOS ---
    
    if (csvContent.startsWith("date,title,amount") || csvContent.startsWith("date,title")) {
      // 1. TRADE REPUBLIC
      Logger.log("Detectado formato: Trade Republic");
      parsedTransactions = parseTradeRepublicCSV(csvContent);
      
    } else if (csvContent.includes("Concepte") && csvContent.includes("Saldo")) {
      // 2. CAIXABANK (Busca cabeceras típicas aunque el orden varíe)
      Logger.log("Detectado formato: Caixabank");
      parsedTransactions = parseCaixabankCSV(csvContent);
      
    } else {
      Logger.log("Formato desconocido en archivo: " + file.getName());
      continue;
    }

    // --- ORDENAMIENTO CRONOLÓGICO ---
    // Ordenar por fecha (de más antigua a más reciente)
    parsedTransactions.sort((a, b) => {
      return a.bookingDate.localeCompare(b.bookingDate);
    });

    // --- BUCLE DE INSERCIÓN GENÉRICO ---
    parsedTransactions.forEach(trn => {
      // Chequeamos contra el HASH (Col J), no contra el TRN
      if (!isDuplicate(trn.id, existingHashes)) {
        
        // Pasamos el número de secuencia actual a la lógica
        const rowsToInsert = processTransactionLogic(trn, trn.id, trn.sourceBank, nextSequenceNum);
        
        rowsToInsert.forEach(newRow => {
          sheet.appendRow(newRow);
          // Si hemos insertado fila, añadimos el hash a la lista en memoria para evitar
          // duplicados dentro del mismo archivo CSV que se está procesando ahora
          existingHashes.push(newRow[9]); 
          totalNewRows++;
        });

        // Incrementamos el contador de secuencia según cuántas filas hemos insertado (1 o 2)
        nextSequenceNum += rowsToInsert.length;
      }
    });
    
    file.moveTo(processedFolder);
  }
  
  Logger.log("Proceso terminado. Filas añadidas: " + totalNewRows);
}

// ==========================================
// PARSER 1: TRADE REPUBLIC
// ==========================================
function parseTradeRepublicCSV(csvString) {
  const csvData = Utilities.parseCsv(csvString, ',');
  const rawTransactions = [];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    // row[0]=date, row[1]=title, row[2]=amount, row[3]=canceled, row[4]=special
    
    if (row[3] === "yes" || !row[2]) continue;
    if (row[1].includes(MY_NAMES[0])) continue; // Filtro auto-transferencia

    rawTransactions.push({
      bookingDate: row[0], // Ya viene en YYYY-MM-DD
      title: row[1],
      amount: parseFloat(row[2]),
      isSpecial: row[4], 
      sourceBank: "Trade Republic",
      originalAmountStr: row[2]
    });
  }
  
  // Filtro de pares de pre-autorización
  const finalTransactions = filterPreAuthPairs(rawTransactions);
  
  // Generación de IDs
  return finalTransactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "TR");
    return t;
  });
}

// ==========================================
// PARSER 2: CAIXABANK
// ==========================================
function parseCaixabankCSV(rawString) {
  // A veces vienen separados por tabuladores (\t) o punto y coma (;)
  // Detectamos el separador de la primera línea
  const delimiter = rawString.indexOf('\t') !== -1 ? '\t' : ';';
  const csvData = Utilities.parseCsv(rawString, delimiter);
  
  let rawTransactions = [];

  // Paso 1: Lectura Cruda y Limpieza de Formatos
  // Empezamos en i=1 asumiendo cabecera en fila 0
  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (row.length < 3) continue;

    // Mapeo (Asumiendo orden: Concepte(0), Data(1), Import(2), Saldo(3))
    // Si el orden cambia, ajusta los índices.
    const rawConcept = row[0];
    const rawDate = row[1];   // "29/01/2026"
    const rawAmount = row[2]; // "-2.800,00EUR"

    // Limpieza de Fecha (DD/MM/YYYY -> YYYY-MM-DD)
    const dateParts = rawDate.split('/');
    const cleanDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;

    // Limpieza de Importe
    // Quitamos "EUR", quitamos puntos de mil, cambiamos coma decimal por punto
    let cleanAmountStr = rawAmount.replace("EUR", "").replace(/\./g, "").replace(",", ".");
    let amountFloat = parseFloat(cleanAmountStr);

    // FILTRO 1: Transferencia a mí mismo (Concepto "nomina" salida)
    // Si es "nomina" y es negativo (salida de dinero), lo ignoramos.
    if (rawConcept.trim() === SELF_TRANSFER_CONCEPT && amountFloat < 0) {
      Logger.log("Saltando transferencia propia (nomina salida): " + rawAmount);
      continue;
    }

    rawTransactions.push({
      bookingDate: cleanDate,
      title: rawConcept,
      amount: amountFloat, // Guardamos como número para poder comparar
      isSpecial: "no",
      sourceBank: "Banco Principal",
      originalAmountStr: cleanAmountStr // Para generar ID
    });
  }

  // Paso 2: Filtro de Pares de Pre-autorización (Parking/Gasolineras)
  // Elimina movimientos identicos de signo contrario en el mismo día
  const finalTransactions = filterPreAuthPairs(rawTransactions);

  // Paso 3: Generar IDs finales
  return finalTransactions.map(t => {
    t.id = Utilities.base64Encode(t.bookingDate + t.title + t.originalAmountStr + "BP");
    return t;
  });
}

/**
 * Elimina transacciones que se anulan mutuamente en el mismo día (mismo concepto, importe inverso)
 */
function filterPreAuthPairs(transactions) {
  const indicesToSkip = new Set();
  
  for (let i = 0; i < transactions.length; i++) {
    if (indicesToSkip.has(i)) continue;

    for (let j = i + 1; j < transactions.length; j++) {
      if (indicesToSkip.has(j)) continue;

      const t1 = transactions[i];
      const t2 = transactions[j];

      // Condición: Misma fecha, Mismo título exacto, Importe suma 0 (ej: -6.50 y +6.50)
      if (t1.bookingDate === t2.bookingDate && 
          t1.title === t2.title && 
          (Math.abs(t1.amount + t2.amount) < 0.01)) { // Margen error flotante pequeño
        
        Logger.log(`Detectado par pre-autorización (Ignorando): ${t1.title} ${t1.amount} / ${t2.amount}`);
        indicesToSkip.add(i);
        indicesToSkip.add(j);
        break; // Ya encontramos su pareja, dejamos de buscar para este 'i'
      }
    }
  }

  return transactions.filter((_, index) => !indicesToSkip.has(index));
}