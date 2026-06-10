/**
 * utils.gs
 * Funciones de apoyo y lógica de categorización para MoneyFlow-Automata.
 */

// ==========================================
// FUNCIONES DE ACCESO A LA HOJA
// ==========================================

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

// ==========================================
// CACHÉ DEL HISTORIAL (#5)
// ==========================================
// Cargamos el historial UNA sola vez por ejecución y lo guardamos aquí.
// Estructura: array de {conceptoOriginal, categoria, subcategoria}
// Solo se puebla la primera vez que se llama a getHistoryCache().
let _historyCache = null;

/**
 * Carga y cachea el historial de transacciones de la hoja Gastos.
 * Lee las columnas K (Concepto Original), C (Categoría) y D (Subcategoría).
 * Excluye filas con categoría "Pendiente Categorizar" porque no aportan información útil.
 */
function getHistoryCache(sheet) {
  if (_historyCache !== null) return _historyCache;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    _historyCache = [];
    return _historyCache;
  }

  // Leemos C, D y K en una sola llamada (más eficiente que tres llamadas separadas)
  // Columna C=3, D=4, K=11 → leemos de C a K (9 columnas) y nos quedamos con las que nos interesan
  const data = sheet.getRange(2, 3, lastRow - 1, 9).getValues(); // cols C..K

  _historyCache = [];
  for (const row of data) {
    const categoria    = row[0]; // col C (índice 0 del rango)
    const subcategoria = row[1]; // col D
    const concepto     = row[8]; // col K (índice 8 del rango, C+8=K)

    if (!concepto || !categoria || categoria === "Pendiente Categorizar") continue;

    _historyCache.push({
      conceptoOriginal: concepto.toString().toLowerCase().trim(),
      categoria:        categoria.toString().trim(),
      subcategoria:     subcategoria.toString().trim()
    });
  }

  Logger.log(`📚 Historial cargado: ${_historyCache.length} entradas categorizadas.`);
  return _historyCache;
}

/**
 * Resetea la caché. Llamar al inicio de processFolderCSVs() para que
 * cada ejecución parta del historial real en ese momento.
 */
function resetHistoryCache() {
  _historyCache = null;
}

// ==========================================
// EXTRACCIÓN DE PALABRAS SIGNIFICATIVAS (#5)
// ==========================================
// Palabras que aparecen mucho en conceptos bancarios pero no aportan
// información de categorización. Las filtramos antes de la búsqueda parcial.
const STOP_WORDS = new Set([
  "de", "la", "el", "en", "a", "con", "por", "para", "del", "los", "las",
  "un", "una", "al", "es", "se", "pago", "pagament", "cargo", "abono",
  "transferencia", "transferencia.", "traspaso", "compra", "tarjeta",
  "operacion", "operació", "recibo", "domiciliacion", "domiciliació",
  "sl", "sa", "slu", "scp", "sp", "bcn", "barcelona", "madrid", "españa",
  "s.l", "s.a", "s.l.", "s.a."
]);

/**
 * Extrae palabras significativas de un concepto bancario.
 * Filtra stop words, números solos, y tokens de menos de 3 caracteres.
 * @param {string} concept
 * @returns {string[]}
 */
function extractSignificantWords(concept) {
  return concept
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]/gi, ' ') // dejamos solo letras y espacios
    .split(/\s+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
}

// ==========================================
// NÚCLEO DE CATEGORIZACIÓN (#5)
// ==========================================

/**
 * Busca la categoría de un concepto consultando primero el historial,
 * luego el diccionario de keywords, y finalmente devuelve "Pendiente".
 *
 * Prioridad:
 *   1. Coincidencia exacta en historial (concepto K idéntico)
 *   2. Coincidencia parcial en historial (palabras significativas comunes)
 *      → desempate por categoría+subcategoría más frecuente
 *   3. Diccionario de keywords hardcodeados (legado, último recurso)
 *   4. "Pendiente Categorizar"
 *
 * @param {string} concept - Concepto original del banco
 * @param {object[][]} sheet - Hoja Gastos (para cargar caché si aún no está cargada)
 * @returns {{categoria: string, subcategoria: string, source: string}}
 */
function mapConceptToCategory(concept, sheet) {
  const conceptLower = concept.toLowerCase().trim();

  // --- NIVEL 1: Coincidencia exacta en historial ---
  if (sheet) {
    const history = getHistoryCache(sheet);

    const exactMatch = history.find(h => h.conceptoOriginal === conceptLower);
    if (exactMatch) {
      Logger.log(`🟢 [Exacto] "${concept}" → ${exactMatch.categoria} / ${exactMatch.subcategoria}`);
      return {
        categoria:    exactMatch.categoria,
        subcategoria: exactMatch.subcategoria,
        source:       "historial_exacto"
      };
    }

    // --- NIVEL 2: Coincidencia parcial en historial ---
    const significantWords = extractSignificantWords(conceptLower);

    if (significantWords.length > 0) {
      // Contamos votos: por cada entrada del historial que comparte al menos
      // una palabra significativa, sumamos un voto a su categoría+subcategoría
      const votes = {};

      for (const entry of history) {
        const entryWords = extractSignificantWords(entry.conceptoOriginal);
        const hasCommonWord = significantWords.some(w => entryWords.includes(w));

        if (hasCommonWord) {
          const key = `${entry.categoria}|||${entry.subcategoria}`;
          votes[key] = (votes[key] || 0) + 1;
        }
      }

      if (Object.keys(votes).length > 0) {
        // Ganador = la combinación categoría+subcategoría con más votos
        const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
        const [winnerCat, winnerSub] = winner[0].split("|||");
        Logger.log(`🟡 [Parcial] "${concept}" → ${winnerCat} / ${winnerSub} (${winner[1]} votos)`);
        return {
          categoria:    winnerCat,
          subcategoria: winnerSub,
          source:       "historial_parcial"
        };
      }
    }
  }

  // --- NIVEL 3: Diccionario de keywords (legado) ---
  const keywordResult = mapConceptToKeyword(conceptLower);
  if (keywordResult) {
    Logger.log(`🔵 [Keyword] "${concept}" → ${keywordResult.categoria} / ${keywordResult.subcategoria}`);
    return { ...keywordResult, source: "keyword" };
  }

  // --- NIVEL 4: Sin categoría ---
  Logger.log(`🔴 [Pendiente] "${concept}" → sin coincidencia`);
  return {
    categoria:    "Pendiente Categorizar",
    subcategoria: "Pendiente Categorizar",
    source:       "pendiente"
  };
}

// ==========================================
// DICCIONARIO DE KEYWORDS (legado, nivel 3)
// ==========================================
/**
 * Busca el concepto en el diccionario hardcodeado de keywords.
 * Separado de mapConceptToCategory para mantener el código limpio.
 * @param {string} conceptLower - Concepto ya en minúsculas
 * @returns {{categoria: string, subcategoria: string}|null}
 */
function mapConceptToKeyword(conceptLower) {
  const mappings = [
    // --- TRADE REPUBLIC ---
    ["saveback tr (ingreso)",    "Recompensas/Cashback", "Saveback TR"],
    ["saveback tr (inversión)",  "Inversión y ahorro",   "ETFs"],
    ["intereses tr",             "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["inversión",                "Inversión y ahorro",   "ETFs"],
    ["comisión tarjeta tr",      "Otros",                "Comisiones bancarias"],
    ["dividendos",               "Inversión y ahorro",   "Dividendos"],

    // Alimentación
    ["condis",      "Alimentación", "Supermercado"],
    ["dia",         "Alimentación", "Supermercado"],
    ["mercadona",   "Alimentación", "Supermercado"],
    ["carrefour",   "Alimentación", "Supermercado"],
    ["caprabo",     "Alimentación", "Supermercado"],
    ["lidl",        "Alimentación", "Supermercado"],
    ["alcampo",     "Alimentación", "Supermercado"],
    ["supermerc",   "Alimentación", "Supermercado"],
    ["just eat",    "Alimentación", "Delivery"],
    ["sushi",       "Alimentación", "Restaurante"],
    ["hsn",         "Alimentación", "Suplementación"],

    // Transporte
    ["repsol",            "Transporte", "Gasolina"],
    ["cepsa",             "Transporte", "Gasolina"],
    ["gm oil",            "Transporte", "Gasolina"],
    ["cabify",            "Transporte", "Taxi/VTC"],
    ["uber",              "Transporte", "Taxi/VTC"],
    ["t-mobilitat",       "Transporte", "Transporte público"],
    ["tmb",               "Transporte", "Transporte público"],
    ["metro barcelona",   "Transporte", "Transporte público"],
    ["residents barcelo", "Transporte", "Aparcamiento"],
    ["itv",               "Transporte", "Mantenimiento coche"],
    ["qualitas auto",     "Transporte", "Seguro coche"],
    ["renfe",             "Transporte", "Transporte público"],

    // Salud
    ["farmacia",          "Salud", "Farmacia"],
    ["activ fitness esp", "Salud", "Gimnasio"],
    ["barberia",          "Salud", "Peluquería"],

    // Ocio
    ["apple.com/bill",       "Ocio", "Suscripción streaming"],
    ["pago traspasos",       "Ocio", "Suscripción streaming"],
    ["pagament traspassos",  "Ocio", "Suscripción streaming"],
    ["cine",                 "Ocio", "Cine"],
    ["yelmo",                "Ocio", "Cine"],
    ["playstation",          "Ocio", "Videojuegos"],
    ["vivari",               "Ocio", "Bar (cervezas, cafés, etc.)"],
    ["collonut",             "Ocio", "Bar (cervezas, cafés, etc.)"],
    ["ticketmaster",         "Ocio", "Concierto"],

    // Inversión y ahorro
    ["core s&p 500",  "Inversión y ahorro", "ETFs"],
    ["interés",       "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["interest",      "Recompensas/Cashback", "Cuenta remunerada TR"],
    ["occident",      "Inversión y ahorro",   "Seguro Unit Linked"],
    ["universitat obert", "Inversión y ahorro", "Matrícula máster"],

    // Vivienda
    ["pago transferencias", "Vivienda", "Alquiler"],
    ["pagament transf",     "Vivienda", "Alquiler"],

    // Salario
    ["nomina (trf)", "Salario", "Nómina Mensual"],

    // Impuestos y multas
    ["ajunt. de barcelon", "Impuestos y multas", "Impuesto circulación"],
    ["impuesto renta",     "Impuestos y multas", "IRPF"],

    // Ropa y calzado
    ["cortefiel",    "Ropa y calzado", "Ropa"],
    ["massimo dutti","Ropa y calzado", "Ropa"],

    // Regalos y donaciones
    ["colvin",                  "Regalos", "Cumpleaños"],
    ["fundación francisco luzon","Regalos", "Donación"],

    // MyInvestor
    ["ishares",            "Inversión y ahorro", "Fondo indexado"],
    ["sam smart",          "Inversión y ahorro", "Fondo indexado"],
    ["promocion amigo inv","Recompensas/Cashback","Promoción amigo"],

    // Otros
    ["bizum", "Otros", "Bizum"]
  ];

  for (const [keyword, categoria, subcategoria] of mappings) {
    if (conceptLower.includes(keyword)) {
      return { categoria, subcategoria };
    }
  }
  return null;
}

// ==========================================
// PROCESAMIENTO DE FILAS
// ==========================================

/**
 * @param {object} trn            - Transacción parseada
 * @param {string} trnHash        - Hash/ID de la transacción
 * @param {string} sourceBank     - Banco origen
 * @param {number} currentSequenceNum - Número de secuencia actual
 * @param {object} sheet          - Hoja Gastos (para consultar historial)
 */
function processTransactionLogic(trn, trnHash, sourceBank, currentSequenceNum, sheet) {
  const amount = Math.abs(parseFloat(trn.amount));
  let paymentMethod = "Tarjeta/Transferencia";

  if (sourceBank === "Trade Republic") paymentMethod = "Tarjeta Débito - Trade Republic";
  if (sourceBank === "Caixabank")      paymentMethod = "Cuenta Principal";

  const rowsToInsert = [];
  const visualId1 = formatTrnId(currentSequenceNum);

  // --- LÓGICA ESPECIAL: SAVEBACK (Doble Asiento) ---
  if (trn.isSpecial === "Saveback") {
    const visualId2 = formatTrnId(currentSequenceNum + 1);

    rowsToInsert.push([
      trn.bookingDate,
      "Ingreso",
      "Recompensas/Cashback",
      "Saveback TR",
      "Saveback TR (Ingreso)",
      amount,
      paymentMethod,
      "False",
      visualId1,
      trnHash + "_INC",
      trn.title
    ]);

    rowsToInsert.push([
      trn.bookingDate,
      "Gasto",
      "Inversión y ahorro",
      "ETFs",
      "Saveback TR (Inversión)",
      amount,
      paymentMethod,
      "False",
      visualId2,
      trnHash + "_INV",
      trn.title
    ]);

  // --- BIZUM ENTRANTE: se inserta como marcador temporal ---
  // El reconciliador lo procesará después y decidirá si ajusta un gasto
  // o lo convierte en ingreso. Se marca con categoría especial para localizarlo.
  } else if (trn.isSpecial === "BizumInbound") {
    rowsToInsert.push([
      trn.bookingDate,
      "Ingreso",
      "__BIZUM_PENDIENTE__",   // Marcador interno, el reconciliador lo eliminará o reemplazará
      "Bizum entrante",
      `Bizum de ${trn.title}`,
      amount,
      paymentMethod,
      "False",
      visualId1,
      trnHash,
      trn.title
    ]);

  // --- BIZUM SALIENTE: categorización manual ---
  } else if (trn.isSpecial === "BizumOutbound") {
    rowsToInsert.push([
      trn.bookingDate,
      "Gasto",
      "Pendiente Categorizar",
      "Pendiente Categorizar",
      `Bizum a ${trn.title}`,
      amount,
      paymentMethod,
      "False",
      visualId1,
      trnHash,
      trn.title
    ]);

  } else {
    // --- CASO NORMAL ---
    const tipo = parseFloat(trn.amount) < 0 ? "Gasto" : "Ingreso";

    // Categorización: historial → keywords → pendiente (#5)
    const mapped = mapConceptToCategory(trn.title, sheet);

    // Descripción limpia (#7): nombre del comercio capitalizado, sin códigos numéricos
    const cleanDescription = cleanConceptDescription(trn.title);

    rowsToInsert.push([
      trn.bookingDate,
      tipo,
      mapped.categoria,
      mapped.subcategoria,
      cleanDescription,     // E. Descripción (limpia)
      amount,
      paymentMethod,
      "False",
      visualId1,
      trnHash,
      trn.title             // K. Concepto Original (intacto)
    ]);
  }

  return rowsToInsert;
}

// ==========================================
// LIMPIEZA DE DESCRIPCIÓN (#7)
// ==========================================

/**
 * Genera una descripción legible a partir del concepto bancario bruto.
 * Elimina códigos numéricos, sufijos de ciudad/país, y capitaliza correctamente.
 * Ejemplos:
 *   "MERCADONA 0234 BARCELONA" → "Mercadona"
 *   "CABIFY*RIDE ES 2312312"   → "Cabify Ride"
 *   "APPLE.COM/BILL"           → "Apple.com/bill"
 * @param {string} concept
 * @returns {string}
 */
function cleanConceptDescription(concept) {
  let clean = concept
    .replace(/\*/g, ' ')           // asteriscos como separadores (ej. CABIFY*RIDE)
    .replace(/\b\d{4,}\b/g, '')   // elimina secuencias de 4+ dígitos (códigos, fechas)
    .replace(/\b(ES|BCN|MAD|ESP|BARCELONA|MADRID|ESPAÑA|SP|SL|SA|SLU)\b/gi, '') // sufijos irrelevantes
    .replace(/\s{2,}/g, ' ')      // espacios múltiples
    .trim();

  // Capitalizar: primera letra de cada palabra en mayúscula, resto en minúscula
  clean = clean
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());

  // Si tras la limpieza quedara vacío, devolvemos el original
  return clean.length > 0 ? clean : concept;
}

// ==========================================
// HELPER: FILAS QUE SIGUEN PENDIENTES (#8)
// ==========================================

/**
 * Devuelve las filas de la hoja Gastos que siguen con "Pendiente Categorizar"
 * en la columna C, para incluirlas en el email de resumen.
 * @param {object} sheet
 * @returns {Array<{sheetRow: number, concepto: string}>}
 */
function getStillPendingRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // Leemos C (categoría) y K (concepto original) — cols 3 y 11
  const catData = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  const conData  = sheet.getRange(2, 11, lastRow - 1, 1).getValues();

  const pending = [];
  for (let i = 0; i < catData.length; i++) {
    if (catData[i][0] === "Pendiente Categorizar") {
      pending.push({
        sheetRow: i + 2,
        concepto: conData[i][0] || "(sin concepto)"
      });
    }
  }
  return pending;
}