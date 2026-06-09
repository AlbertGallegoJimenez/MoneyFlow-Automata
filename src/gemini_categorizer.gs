/**
 * gemini_categorizer.gs
 * Categoriza automáticamente las filas "Pendiente Categorizar" de la hoja Gastos
 * usando la API de Gemini (Google AI Studio - tier gratuito).
 *
 * Flujo:
 *   1. Lee todas las filas con Categoría = "Pendiente Categorizar"
 *   2. Envía los conceptos originales (col K) a Gemini en un único request
 *   3. Gemini devuelve JSON con categoría + subcategoría para cada uno
 *   4. Se actualizan las celdas C y D correspondientes
 *
 * Se llama automáticamente al final de processFolderCSVs(), pero también
 * puede ejecutarse manualmente desde el menú de Apps Script para resolver
 * pendientes acumulados de ejecuciones anteriores.
 */

// ==========================================
// TAXONOMÍA DE CATEGORÍAS
// ==========================================
// Fuente de verdad para el prompt de Gemini. Si añades/cambias categorías
// en tu hoja, actualiza también este objeto.
const TAXONOMY = {
  ingresos: {
    "Salario":              ["Nómina Mensual"],
    "Recompensas/Cashback": ["Cuenta remunerada TR", "Saveback TR", "Dividendos", "Promoción amigo"]
  },
  gastos: {
    "Vivienda":             ["Alquiler", "Teléfono y fibra óptica", "Electricidad", "Gas", "Agua"],
    "Transporte":           ["Gasolina", "Transporte público", "Seguro coche", "Mantenimiento coche", "Aparcamiento", "Taxi/VTC", "Avión"],
    "Ocio":                 ["Bar (cervezas, cafés, etc.)", "Suscripción streaming", "Cine", "Videojuegos", "Concierto", "Viaje/Vacaciones"],
    "Salud":                ["Farmacia", "Peluquería", "Gimnasio"],
    "Alimentación":         ["Supermercado", "Restaurante", "Suplementación", "Panadería", "Delivery"],
    "Inversión y ahorro":   ["ETFs", "Fondos indexados", "Criptomonedas", "Acciones", "Máster Data Science"],
    "Ropa y calzado":       ["Ropa", "Calzado", "Relojes"],
    "Impuestos y multas":   ["IRPF", "Impuesto circulación"],
    "Regalos y donaciones": ["Cumpleaños", "Boda", "Donación"],
    "Otros":                ["N/A"]
  }
};

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================

/**
 * Busca filas "Pendiente Categorizar" y las categoriza con Gemini.
 * Puede llamarse al final de processFolderCSVs() o manualmente.
 * @returns {{resolved: number, failed: number}}
 */
function categorizePendingWithGemini() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    Logger.log("ℹ️ Gemini: No hay filas en la hoja.");
    return { resolved: 0, failed: 0 };
  }

  // Leemos las columnas B (Tipo), C (Categoría), D (Subcategoría) y K (Concepto Original)
  // Rango: B2:K{lastRow} → 10 columnas
  const dataRange = sheet.getRange(2, 2, lastRow - 1, 10);
  const data = dataRange.getValues();

  // Identificamos las filas pendientes: { rowIndex (1-based en hoja), tipo, concepto }
  const pendingRows = [];
  for (let i = 0; i < data.length; i++) {
    const categoria = data[i][1]; // col C = índice 1 del rango (B=0, C=1)
    if (categoria === "Pendiente Categorizar") {
      pendingRows.push({
        sheetRow: i + 2,          // +2: +1 por header, +1 por base-1
        tipo:     data[i][0],     // col B
        concepto: data[i][9]      // col K = índice 9 del rango
      });
    }
  }

  if (pendingRows.length === 0) {
    Logger.log("✅ Gemini: No hay filas pendientes de categorizar.");
    return { resolved: 0, failed: 0 };
  }

  Logger.log(`🤖 Gemini: ${pendingRows.length} filas pendientes. Enviando a la API...`);

  // Procesamos en lotes de 20 para no superar el límite de tokens del tier gratuito
  const BATCH_SIZE = 20;
  let resolved = 0;
  let failed = 0;

  for (let i = 0; i < pendingRows.length; i += BATCH_SIZE) {
    const batch = pendingRows.slice(i, i + BATCH_SIZE);
    const results = callGeminiForBatch(batch);

    if (!results) {
      Logger.log(`❌ Gemini: Fallo en el lote ${Math.floor(i / BATCH_SIZE) + 1}. Se mantienen como Pendiente.`);
      failed += batch.length;
      continue;
    }

    // Escribimos los resultados en la hoja
    for (let j = 0; j < batch.length; j++) {
      const row   = batch[j];
      const result = results[j];

      if (!result || !result.categoria || result.categoria === "Pendiente Categorizar") {
        Logger.log(`⚠️ Gemini: Sin resultado para fila ${row.sheetRow} ("${row.concepto}")`);
        failed++;
        continue;
      }

      // Validamos que la respuesta de Gemini usa categorías de nuestra taxonomía
      const validated = validateAndFallback(result, row.tipo);
      sheet.getRange(row.sheetRow, 3).setValue(validated.categoria);    // Col C
      sheet.getRange(row.sheetRow, 4).setValue(validated.subcategoria); // Col D
      Logger.log(`✅ Fila ${row.sheetRow}: "${row.concepto}" → ${validated.categoria} / ${validated.subcategoria}${validated.fallback ? " (fallback)" : ""}`);
      resolved++;
    }

    // Pausa entre lotes para respetar el rate limit del tier gratuito (15 RPM)
    if (i + BATCH_SIZE < pendingRows.length) {
      Utilities.sleep(4500);
    }
  }

  Logger.log(`🏁 Gemini: Resueltas ${resolved}/${pendingRows.length} filas. Fallidas: ${failed}.`);
  return { resolved, failed };
}

// ==========================================
// LLAMADA A LA API DE GEMINI
// ==========================================

/**
 * Envía un lote de transacciones a Gemini y devuelve el array de resultados.
 * @param {Array<{sheetRow, tipo, concepto}>} batch
 * @returns {Array<{categoria, subcategoria}>|null} - null si hay error de API
 */
function callGeminiForBatch(batch) {
  const apiKey = CONFIG.GOOGLE_API_KEY;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const taxonomyText = buildTaxonomyText();
  const transactionsText = batch
    .map((row, idx) => `${idx + 1}. [${row.tipo}] "${row.concepto}"`)
    .join('\n');

  const prompt = `Eres un asistente de finanzas personales. Tu tarea es categorizar transacciones bancarias.

TAXONOMÍA DE CATEGORÍAS (usa ÚNICAMENTE estas categorías y subcategorías, respetando mayúsculas y acentos):
${taxonomyText}

INSTRUCCIONES:
- Asigna la categoría y subcategoría más apropiada a cada transacción.
- El campo [Tipo] indica si es un Ingreso o un Gasto, úsalo para elegir entre categorías de ingresos/gastos.
- Si no puedes determinar la categoría con suficiente confianza, usa "Otros" / "N/A".
- Responde ÚNICAMENTE con un array JSON válido, sin texto adicional, sin bloques de código markdown.
- El array debe tener exactamente ${batch.length} objetos, uno por transacción, en el mismo orden.
- Cada objeto debe tener exactamente dos campos: "categoria" y "subcategoria".

TRANSACCIONES A CATEGORIZAR:
${transactionsText}

RESPUESTA (solo el array JSON):`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,      // Baja temperatura para respuestas consistentes
      maxOutputTokens: 1024
    }
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      Logger.log(`❌ Gemini API error ${responseCode}: ${response.getContentText().substring(0, 300)}`);
      return null;
    }

    const responseJson = JSON.parse(response.getContentText());
    const rawText = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!rawText) {
      Logger.log("❌ Gemini: Respuesta vacía.");
      return null;
    }

    // Limpiamos posibles bloques ```json ``` que Gemini a veces añade
    const cleanText = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    const parsed = JSON.parse(cleanText);

    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      Logger.log(`❌ Gemini: Respuesta con formato inesperado. Esperado: ${batch.length} items. Recibido: ${JSON.stringify(parsed).substring(0, 200)}`);
      return null;
    }

    return parsed;

  } catch (e) {
    Logger.log("❌ Gemini: Excepción en la llamada: " + e.toString());
    return null;
  }
}

// ==========================================
// VALIDACIÓN DE RESPUESTA DE GEMINI
// ==========================================

/**
 * Valida que la categoría y subcategoría devueltas por Gemini existen en la taxonomía.
 * Si la categoría es válida pero la subcategoría no, usa la primera subcategoría de esa categoría.
 * Si la categoría tampoco es válida, cae a "Otros" / "N/A".
 * @param {{categoria, subcategoria}} result
 * @param {string} tipo - "Ingreso" o "Gasto"
 * @returns {{categoria, subcategoria, fallback: boolean}}
 */
function validateAndFallback(result, tipo) {
  const pool = tipo === "Ingreso" ? TAXONOMY.ingresos : TAXONOMY.gastos;

  // Categoría válida
  if (pool[result.categoria]) {
    const validSubs = pool[result.categoria];
    // Subcategoría válida
    if (validSubs.includes(result.subcategoria)) {
      return { ...result, fallback: false };
    }
    // Subcategoría inválida → primera subcategoría de esa categoría
    Logger.log(`⚠️ Gemini: Subcategoría desconocida "${result.subcategoria}" para "${result.categoria}". Usando "${validSubs[0]}".`);
    return { categoria: result.categoria, subcategoria: validSubs[0], fallback: true };
  }

  // Categoría inválida → Otros / N/A
  Logger.log(`⚠️ Gemini: Categoría desconocida "${result.categoria}". Usando "Otros" / "N/A".`);
  return { categoria: "Otros", subcategoria: "N/A", fallback: true };
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Convierte el objeto TAXONOMY en texto legible para el prompt.
 */
function buildTaxonomyText() {
  let text = "INGRESOS:\n";
  for (const [cat, subs] of Object.entries(TAXONOMY.ingresos)) {
    text += `  - ${cat}: ${subs.join(", ")}\n`;
  }
  text += "GASTOS:\n";
  for (const [cat, subs] of Object.entries(TAXONOMY.gastos)) {
    text += `  - ${cat}: ${subs.join(", ")}\n`;
  }
  return text;
}
