/**
 * Funciones auxiliares y lógica de procesamiento
 */

function isDuplicate(transactionId, existingIds) {
  return existingIds.includes(transactionId);
}

function getExistingTransactionIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Asumimos que el ID está en la columna H (columna 8)
  return sheet.getRange(2, 8, lastRow - 1, 1).getValues().flat();
}

/**
 * Lógica especial para Saveback y Round-ups
 * Retorna un array de filas para insertar
 */
function processTransactionLogic(trn) {
  const desc = trn.remittanceInformationUnstructured || "Sin descripción";
  const amount = Math.abs(parseFloat(trn.transactionAmount.amount));
  const date = trn.bookingDate;
  const trnId = trn.transactionId || "MANUAL_" + new Date().getTime();
  
  const rowsToInsert = [];

  if (desc.includes("Saveback") || desc.includes("Round up")) {
    // FILA 1: El Ingreso (Dinero nuevo "fantasma")
    rowsToInsert.push([
      date,                                         // Campo Fecha
      "Ingreso",                                    // Campo Tipo de Transacción
      "Recompensas/Cashback",                       // Campo Categoría Principal
      "Saveback+Round up TR",                       // Campo Subcategoría
      "Saveback y Round up agrupados por mes",      // Campo Descripción
      amount,                                       // Campo Valor (€)
      "Domiciliación",                              // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      trnId + "_INC",                               // Campo ID Transacción
      desc
    ]);
    
    // FILA 2: La Inversión (Salida automática al activo)
    rowsToInsert.push([
      date,                                         // Campo Fecha
      "Gasto",                                      // Campo Tipo de Transacción
      "Inversión y ahorro",                         // Campo Categoría Principal
      "ETFs",                                       // Campo Subcategoría
      "Saveback y Round up agrupados por mes",      // Campo Descripción
      amount,                                       // Campo Valor (€)
      "Domiciliación",                              // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      trnId + "_INV",                               // Campo ID Transacción
      desc
    ]);
  } else {
    // Transacción estándar
    const tipo = parseFloat(trn.transactionAmount.amount) < 0 ? "Gasto" : "Ingreso";
    rowsToInsert.push([
      date, tipo, "General", "Pendiente Categorizar", 
      amount, "API Sync", "False", trnId, desc
    ]);
  }
  
  return rowsToInsert;
}