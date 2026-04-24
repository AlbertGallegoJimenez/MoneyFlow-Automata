/**
 * utils.gs
 * Funciones de apoyo y lógica de categorización para MoneyFlow-Automata.
 */

function getExistingHashes(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 10, lastRow - 1, 1).getValues().flat();
}

function isDuplicate(hash, existingHashes) {
  return existingHashes.includes(hash);
}

function getNextTrnNumber(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const ids = sheet.getRange(2, 9, lastRow - 1, 1).getValues().flat();
  let maxNum = 0;
  const regex = /TRN0*(\d+)/; 

  ids.forEach(id => {
    if (id) {
      const match = id.toString().match(regex);
      if (match && match[1]) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  });
  return maxNum + 1;
}

function formatTrnId(num) {
  return "TRN" + num.toString().padStart(5, '0');
}

/**
 * PROCESAMIENTO DE FILAS
 */
function processTransactionLogic(trn, trnHash, sourceBank, currentSequenceNum) {
  const amount = Math.abs(parseFloat(trn.amount));
  let paymentMethod = "Tarjeta/Transferencia";
  
  if (sourceBank === "Trade Republic") paymentMethod = "Tarjeta Débito - Trade Republic";
  if (sourceBank === "Caixabank") paymentMethod = "Cuenta Principal";

  const rowsToInsert = [];
  const visualId1 = formatTrnId(currentSequenceNum);

  // --- LÓGICA ESPECIAL: SAVEBACK (Doble Asiento) ---
  if (trn.isSpecial === "Saveback") {
    const visualId2 = formatTrnId(currentSequenceNum + 1);
    
    // Fila 1: El REGALO del banco (Ingreso)
    rowsToInsert.push([
      trn.bookingDate,          // A. Fecha
      "Ingreso",                // B. Tipo
      "Recompensas/Cashback",   // C. Categoría Principal
      "Saveback TR",            // D. Subcategoría
      "Saveback TR (Ingreso)",  // E. Descripción
      amount,                   // F. Valor (€)
      paymentMethod,            // G. Método de Pago
      "False",                  // H. Gasto Fijo
      visualId1,                // I. ID Visual
      trnHash + "_INC",         // J. Hash Único para el ingreso
      trn.title                 // K. Concepto Original
    ]);
    
    // Fila 2: La INVERSIÓN automática (Gasto)
    rowsToInsert.push([
      trn.bookingDate,          // A. Fecha
      "Gasto",                  // B. Tipo
      "Inversión y ahorro",     // C. Categoría Principal
      "ETFs",                   // D. Subcategoría
      "Saveback TR (Inversión)",// E. Descripción
      amount,                   // F. Valor (€)
      paymentMethod,            // G. Método de Pago
      "False",                  // H. Gasto Fijo
      visualId2,                // I. ID Visual
      trnHash + "_INV",         // J. Hash Único para el gasto
      trn.title                 // K. Concepto Original
    ]);

  } else {
    // --- CASO NORMAL: Planes de Inversión, Round Up, Compras ---
    const tipo = parseFloat(trn.amount) < 0 ? "Gasto" : "Ingreso";
    const mapped = mapConceptToCategory(trn.title);

    rowsToInsert.push([
      trn.bookingDate,          // A. Fecha
      tipo,                     // B. Tipo
      mapped.categoria,         // C. Categoría Principal
      mapped.subcategoria,      // D. Subcategoría
      trn.title,                // E. Descripción
      amount,                   // F. Valor (€)
      paymentMethod,            // G. Método de Pago
      "False",                  // H. Gasto Fijo
      visualId1,                // I. ID Visual
      trnHash,                  // J. Hash
      trn.title                 // K. Concepto Original
    ]);
  }
  
  return rowsToInsert;
}

/**
 * Mapea el concepto bancario a categoría y subcategoría
 * Busca coincidencias parciales (case-insensitive) en el texto del concepto
 * @param {string} concept - El concepto/descripción de la transacción
 * @returns {object} - {categoria: string, subcategoria: string}
 */
function mapConceptToCategory(concept) {
  const conceptLower = concept.toLowerCase();

  // Diccionario de palabras clave y sus categorías correspondientes
  // Formato: ["Palabra Clave", "Categoría Principal", "Subcategoría"]
  const mappings = [
    // --- 1. NUEVA LÓGICA TRADE REPUBLIC (Nativo 2026) ---
    // Importante: Estos nombres vienen forzados por nuestro nuevo Parser
    ["saveback tr (ingreso)",    "Recompensas/Cashback", "Saveback TR"],
    ["saveback tr (inversión)",  "Inversión y ahorro",   "ETFs"],
    ["intereses tr",             "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["inversión",                "Inversión y ahorro",   "ETFs"],
    ["comisión tarjeta tr",      "Otros",                "Comisiones bancarias"],
    ["dividendos",               "Inversión y ahorro",   "Dividendos"],

    // Alimentación
    ["condis", "Alimentación", "Supermercado"],
    ["dia", "Alimentación", "Supermercado"],
    ["mercadona", "Alimentación", "Supermercado"],
    ["carrefour", "Alimentación", "Supermercado"],
    ["caprabo", "Alimentación", "Supermercado"],
    ["lidl", "Alimentación", "Supermercado"],
    ["alcampo", "Alimentación", "Supermercado"],
    ["supermerc", "Alimentación", "Supermercado"],
    ["just eat", "Alimentación", "Delivery"],
    ["sushi", "Alimentación", "Restaurante"],
    ["hsn", "Alimentación", "Suplementación"],
    
    // Transporte
    ["repsol", "Transporte", "Gasolina"],
    ["cepsa", "Transporte", "Gasolina"],
    ["gm oil", "Transporte", "Gasolina"],
    ["cabify", "Transporte", "Taxi/VTC"],
    ["uber", "Transporte", "Taxi/VTC"],
    ["t-mobilitat", "Transporte", "Transporte público"],
    ["tmb", "Transporte", "Transporte público"],
    ["metro barcelona", "Transporte", "Transporte público"],
    ["residents barcelo", "Transporte", "Aparcamiento"],
    ["itv", "Transporte", "Mantenimiento coche"],
    ["qualitas auto", "Transporte", "Seguro coche"],
    ["renfe", "Transporte", "Transporte público"],

    // Salud
    ["farmacia", "Salud", "Farmacia"],
    ["activ fitness esp", "Salud", "Gimnasio"],
    ["barberia", "Salud", "Peluquería"],

    // Ocio
    ["apple.com/bill", "Ocio", "Suscripción streaming"],
    ["pago traspasos", "Ocio", "Suscripción streaming"], // Transferencia Spotify Mar
    ["pagament traspassos", "Ocio", "Suscripción streaming"], // Transferencia Spotify Mar
    ["cine", "Ocio", "Cine"],
    ["yelmo", "Ocio", "Cine"],
    ["playstation", "Ocio", "Videojuegos"],
    ["vivari", "Ocio", "Bar (cervezas, cafés, etc.)"],
    ["collonut", "Ocio", "Bar (cervezas, cafés, etc.)"],
    ["ticketmaster", "Ocio", "Concierto"],
    
    // Ahorro e Inversión
    ["core s&p 500", "Inversión y ahorro", "ETFs"],
    ["interés", "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["interest", "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["occident", "Inversión y ahorro", "Seguro Unit Linked"],
    ["universitat obert", "Inversión y ahorro", "Matrícula máster"],

    // Vivienda
    ["pago transferencias", "Vivienda", "Alquiler"], // Transferencia ajuda Mama
    ["pagament transf", "Vivienda", "Alquiler"], // Transferencia ajuda Mama

    // Salario
    ["nomina (trf)", "Salario", "Nómina Mensual"],

    // Impuestos y multas
    ["ajunt. de barcelon", "Impuestos y multas", "Impuesto circulación"],
    ["impuesto renta", "Impuestos y multas", "IRPF"],

    // Ropa y calzado
    ["cortefiel", "Ropa y calzado", "Ropa"],
    ["massimo dutti", "Ropa y calzado", "Ropa"],

    // Regalos y donaciones
    ["colvin", "Regalos", "Cumpleaños"],
    ["fundación francisco luzon", "Regalos", "Donación"],

    // MyInvestor - Fondo indexado
    ["ishares",     "Inversión y ahorro", "Fondo indexado"],
    ["sam smart",     "Inversión y ahorro", "Fondo indexado"],
    ["promocion amigo inv", "Recompensas/Cashback", "Promoción amigo"],

    // Otros
    ["bizum", "Otros", "Bizum"]
  ];
  
// Buscamos si el concepto contiene alguna de las palabras clave
  for (let i = 0; i < mappings.length; i++) {
    const [keyword, categoria, subcategoria] = mappings[i];
    if (conceptLower.includes(keyword)) {
      return { 
        categoria: categoria, 
        subcategoria: subcategoria 
      };
    }
  }

  // Si no encuentra nada, devuelve "Pendiente"
  return {
    categoria: "Pendiente Categorizar",
    subcategoria: "Pendiente Categorizar"
  };
}