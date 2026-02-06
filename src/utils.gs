/**
 * Funciones auxiliares y lógica de procesamiento
 */

// 1. Detección de duplicados mirando la COLUMNA J (Huella Digital)
function getExistingHashes(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Leemos la Columna 10 (J) que es la oculta con el Hash
  return sheet.getRange(2, 10, lastRow - 1, 1).getValues().flat();
}

function isDuplicate(hash, existingHashes) {
  return existingHashes.includes(hash);
}

// 2. Generador de IDs secuenciales (TRNxxx) mirando la COLUMNA I
function getNextTrnNumber(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1; // Si está vacía, empezamos por 1

  // Leemos todos los IDs visuales de la columna I (9)
  const ids = sheet.getRange(2, 9, lastRow - 1, 1).getValues().flat();
  
  let maxNum = 0;
  // Regex para extraer el número limpio de "TRN00123"
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

  return maxNum + 1; // Devolvemos el siguiente número disponible
}

// 3. Formateador visual: Convierte 5 -> "TRN0005"
function formatTrnId(num) {
  return "TRN" + num.toString().padStart(4, '0');
}

/**
 * Lógica de procesamiento de transacciones
 * params: trn (objeto), trnHash (string), sourceBank (string), currentSequenceNum (int)
 */
function processTransactionLogic(trn, trnHash, sourceBank, currentSequenceNum) {
  const amount = Math.abs(parseFloat(trn.amount));
  const isTRSpecial = (trn.isSpecial && trn.isSpecial !== "no"); 
  
  let paymentMethod = "Tarjeta/Transferencia";
  if (sourceBank === "Trade Republic") paymentMethod = "Tarjeta Débito - Trade Republic";
  if (sourceBank === "Banco Principal") paymentMethod = "Cuenta/Tarjeta Principal";

  const rowsToInsert = [];
  
  // Preparamos los IDs visuales necesarios
  const visualId1 = formatTrnId(currentSequenceNum);     // Para la 1ª fila
  const visualId2 = formatTrnId(currentSequenceNum + 1); // Para la 2ª fila (si hay doble asiento)

  if (isTRSpecial) {
    // --- DOBLE ASIENTO (Saveback / Round Up) ---
    
    // FILA 1: El Ingreso (Reward)
    rowsToInsert.push([
      trn.bookingDate,                              // Campo Fecha
      "Ingreso",                                    // Campo Tipo de Transacción
      "Recompensas/Cashback",                       // Campo Categoría Principal
      "Saveback+Round up TR",                       // Campo Subcategoría
      "TR Reward (" + trn.isSpecial + ")",          // Campo Descripción
      amount,                                       // Campo Valor (€)
      "Cuenta Efectivo",                            // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      visualId1,                                    // Campo ID Transacción (Visual: TRNxxxx)
      trnHash + "_INC",                             // Campo Huella Digital (Oculto: Hash)
      ""                                            // Campo Concepto Original Banco
    ]);
    
    // FILA 2: La Inversión (Salida)
    rowsToInsert.push([
      trn.bookingDate,                              // Campo Fecha
      "Gasto",                                      // Campo Tipo de Transacción
      "Inversión y ahorro",                         // Campo Categoría Principal
      "ETFs",                                       // Campo Subcategoría
      "Inversión auto (" + trn.isSpecial + ")",     // Campo Descripción
      amount,                                       // Campo Valor (€)
      "Cuenta Efectivo",                            // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      visualId2,                                    // Campo ID Transacción (Visual: TRNxxxx+1)
      trnHash + "_INV",                             // Campo Huella Digital (Oculto: Hash)
      ""                                            // Campo Concepto Original Banco
    ]);

  } else {
    // --- TRANSACCIÓN ESTÁNDAR ---
    
    const tipo = parseFloat(trn.amount) < 0 ? "Gasto" : "Ingreso";
    
    // Intentar mapear el concepto a una categoría conocida
    const mappedCategory = mapConceptToCategory(trn.title);
    
    rowsToInsert.push([
      trn.bookingDate,                              // Campo Fecha
      tipo,                                         // Campo Tipo de Transacción
      mappedCategory.categoria,                     // Campo Categoría Principal
      mappedCategory.subcategoria,                  // Campo Subcategoría
      "",                                           // Campo Descripción
      amount,                                       // Campo Valor (€)
      paymentMethod,                                // Campo Método de Pago
      "False",                                      // Campo ¿Gasto fijo?
      visualId1,                                    // Campo ID Transacción (Visual: TRNxxxx)
      trnHash,                                      // Campo Huella Digital (Oculto: Hash)
      trn.title                                     // Campo Concepto Original Banco
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
  // Convertir a minúsculas para comparación insensible a mayúsculas
  const conceptLower = concept.toLowerCase();
  
  // --- DICCIONARIO DE MAPEO ---
  // Formato: ["palabra clave", "Categoría Principal", "Subcategoría"]
  const mappings = [
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
    
    // Transporte
    ["repsol", "Transporte", "Gasolina"],
    ["cepsa", "Transporte", "Gasolina"],
    ["gm oil", "Transporte", "Gasolina"],
    ["cabify", "Transporte", "Taxi/Cabify/Uber"],
    ["uber", "Transporte", "Taxi/Cabify/Uber"],
    ["tmb", "Transporte", "Transporte público"],
    ["metro barcelona", "Transporte", "Transporte público"],
    ["residents barcelo", "Transporte", "Aparcamiento"],
    ["itv", "Transporte", "Mantenimiento coche"],
    ["renfe", "Transporte", "Transporte público"],

    // Salud
    ["farmacia", "Salud", "Farmacia"],
    ["activ fitness esp", "Salud", "Gimnasio"],
    ["barberia", "Salud", "Peluquería"],

    // Ocio
    ["apple.com/bill", "Ocio", "Suscripción streaming"],
    ["pago traspasos", "Ocio", "Suscripción streaming"], // Transferencia Spotify Mar
    ["cine", "Ocio", "Cine"],
    ["yelmo", "Ocio", "Cine"],
    ["playstation", "Ocio", "Videojuegos"],
    ["vivari", "Ocio", "Bar (cervezas, cafés, etc.)"],
    ["ticketmaster", "Ocio", "Concierto"],
    
    // Ahorro e Inversión
    ["core s&p 500", "Inversión y ahorro", "ETFs"],
    ["interés", "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["occident", "Inversión y ahorro", "Seguro Unit Linked"],
    ["universitat obert", "Inversión y ahorro", "Matrícula máster"],

    // Vivienda
    ["pago transferencias", "Vivienda", "Alquiler"], // Transferencia ajuda Mama
    ["pagament transf", "Vivienda", "Alquiler"], // Transferencia ajuda Mama

    // Salario
    ["nomina (trf)", "Salario", "Nomina Mensual"],

    // Impuestos y multas
    ["ajunt. de barcelon", "Impuestos y multas", "Impuesto circulación"],
    ["impuesto renta", "Impuestos y multas", "IRPF"],

    // Ropa y calzado
    ["cortefiel", "Ropa y calzado", "Ropa"],
    ["massimo dutti", "Ropa y calzado", "Ropa"],

    // Regalos
    ["colvin", "Regalos", "Cumpleaños"],

    // Otros
    ["bizum", "Otros", "Bizum"]
  ];
  
  // Buscar coincidencia en el concepto
  for (let i = 0; i < mappings.length; i++) {
    const [keyword, categoria, subcategoria] = mappings[i];
    
    if (conceptLower.includes(keyword)) {
      return {
        categoria: categoria,
        subcategoria: subcategoria
      };
    }
  }
  
  // Si no hay coincidencia, devolver categoría por defecto
  return {
    categoria: "Pendiente Categorizar",
    subcategoria: "Pendiente Categorizar"
  };
}