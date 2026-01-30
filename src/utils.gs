/**
 * Funciones auxiliares y lógica de procesamiento
 */

function isDuplicate(transactionId, existingIds) {
  return existingIds.includes(transactionId);
}

function getExistingTransactionIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Columna ID (Columna I = 9)
  return sheet.getRange(2, 9, lastRow - 1, 1).getValues().flat();
}

/**
 * Lógica de procesamiento de transacciones
 * params: trn (objeto datos), trnId (string), sourceBank (string: "Trade Republic" | "Banco Principal")
 */
function processTransactionLogic(trn, trnId, sourceBank) {
  const amount = Math.abs(parseFloat(trn.amount));
  const isTRSpecial = (trn.isSpecial && trn.isSpecial !== "no"); 
  
  // Definimos el método de pago según el origen
  let paymentMethod = "Tarjeta/Transferencia";
  if (sourceBank === "Trade Republic") paymentMethod = "Tarjeta Débito - Trade Republic";
  if (sourceBank === "Banco Principal") paymentMethod = "Cuenta/Tarjeta Principal";

  const rowsToInsert = [];

  if (isTRSpecial) {
    // --- CASO ESPECIAL: SAVEBACK / ROUND UP (DOBLE REGISTRO) ---
    
    // FILA 1: El Ingreso (Dinero nuevo "fantasma" que genera TR)
    rowsToInsert.push([
      trn.bookingDate,                              // Campo Fecha
      "Ingreso",                                    // Campo Tipo de Transacción
      "Recompensas/Cashback",                       // Campo Categoría Principal
      "Saveback+Round up TR",                       // Campo Subcategoría
      "TR Reward (" + trn.isSpecial + ")",          // Campo Descripción
      amount,                                       // Campo Valor (€)
      "Cuenta Efectivo",                            // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      trnId + "_INC",                               // Campo ID Transacción
      trn.title                                     // Metadata extra
    ]);
    
    // FILA 2: La Inversión (Salida automática al plan de inversión/ETF)
    rowsToInsert.push([
      trn.bookingDate,                              // Campo Fecha
      "Gasto",                                      // Campo Tipo de Transacción
      "Inversión y ahorro",                         // Campo Categoría Principal
      "ETFs",                                       // Campo Subcategoría
      "Inversión auto (" + trn.isSpecial + ")",     // Campo Descripción
      amount,                                       // Campo Valor (€)
      "Cuenta Efectivo",                            // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      trnId + "_INV",                               // Campo ID Transacción
      trn.title                                     // Metadata extra
    ]);

  } else {
    // --- TRANSACCIÓN ESTÁNDAR (Para ambos bancos) ---
    
const tipo = parseFloat(trn.amount) < 0 ? "Gasto" : "Ingreso";
    
    rowsToInsert.push([
      trn.bookingDate,                              // Campo Fecha
      tipo,                                         // Campo Tipo de Transacción
      "Pendiente Categorizar",                      // Campo Categoría Principal
      "Pendiente Categorizar",                      // Campo Subcategoría
      trn.title,                                    // Campo Descripción
      amount,                                       // Campo Valor (€)
      paymentMethod,                                // Campo Método de Pago (Dinámico)
      "False",                                      // Campo ¿Gasto fijo?
      trnId,                                        // Campo ID Transacción
      trn.title                                     // Metadata extra
    ]);
  }
  
  return rowsToInsert;
}