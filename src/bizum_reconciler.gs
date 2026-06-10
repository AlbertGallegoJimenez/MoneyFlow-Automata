/**
 * bizum_reconciler.gs
 * Reconcilia automáticamente los Bizums entrantes contra gastos compartidos.
 *
 * Flujo:
 *   1. Localiza filas marcadas como "__BIZUM_PENDIENTE__" en col C
 *   2. Agrupa los Bizums por ventana temporal (CONFIG.BIZUM_TIME_SPAN_DAYS)
 *   3. Para cada grupo, busca un gasto susceptible cercano que cuadre numéricamente
 *   4a. Si hay match: ajusta el valor del gasto, elimina las filas de Bizum
 *   4b. Si no hay match: convierte el Bizum en ingreso real (Otros / Bizum)
 *
 * Se llama desde processFolderCSVs() después de insertar todas las filas
 * y antes de finalizeLogger().
 */

// ==========================================
// CATEGORÍAS SUSCEPTIBLES DE GASTO COMPARTIDO
// ==========================================
const SHAREABLE_CATEGORIES = [
  { categoria: "Alimentación",  subcategoria: "Restaurante" },
  { categoria: "Alimentación",  subcategoria: "Delivery"    },
  { categoria: "Ocio",          subcategoria: "Bar (cervezas, cafés, etc.)" },
  { categoria: "Ocio",          subcategoria: "Concierto"   },
  { categoria: "Transporte",    subcategoria: "Taxi/VTC"    },
  { categoria: "Transporte",    subcategoria: "Gasolina"    }
];

// Margen de matching: el total de Bizums debe representar entre el 20% y el 95% del gasto
const BIZUM_MATCH_MIN_RATIO = 0.20;
const BIZUM_MATCH_MAX_RATIO = 0.95;

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================

/**
 * Ejecuta la reconciliación completa de Bizums pendientes.
 * @returns {{ adjusted: number, converted: number, bizumRowsRemoved: number }}
 */
function reconcileBizums() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return { adjusted: 0, converted: 0, bizumRowsRemoved: 0 };

  // Leemos toda la hoja de una vez para minimizar llamadas a la API de Sheets
  // Columnas: A=fecha, B=tipo, C=categoría, D=subcategoría, E=descripción, F=valor, I=ID, K=concepto
  const allData = sheet.getRange(2, 1, lastRow - 1, 11).getValues();

  // --- PASO 1: Localizar Bizums pendientes y gastos susceptibles ---
  const bizumRows    = [];  // { dataIdx, sheetRow, date, amount, senderName, hash }
  const expenseRows  = [];  // { dataIdx, sheetRow, date, amount, categoria, subcategoria, descripcion }

  for (let i = 0; i < allData.length; i++) {
    const row        = allData[i];
    const sheetRow   = i + 2; // +1 header, +1 base-1
    const fecha      = row[0] ? row[0].toString().trim() : "";
    const tipo       = row[1] ? row[1].toString().trim() : "";
    const categoria  = row[2] ? row[2].toString().trim() : "";
    const subcat     = row[3] ? row[3].toString().trim() : "";
    const desc       = row[4] ? row[4].toString().trim() : "";
    const valor      = parseFloat(row[5]) || 0;
    const hash       = row[9] ? row[9].toString().trim() : "";
    const concepto   = row[10] ? row[10].toString().trim() : "";

    if (categoria === "__BIZUM_PENDIENTE__") {
      bizumRows.push({ dataIdx: i, sheetRow, date: fecha, amount: valor, senderName: concepto, hash });
    } else if (tipo === "Gasto" && _isShareable(categoria, subcat)) {
      expenseRows.push({ dataIdx: i, sheetRow, date: fecha, amount: valor, categoria, subcategoria: subcat, descripcion: desc });
    }
  }

  if (bizumRows.length === 0) {
    logEvent("INFO", "Bizum reconciler: No hay Bizums pendientes.");
    return { adjusted: 0, converted: 0, bizumRowsRemoved: 0 };
  }

  logEvent("INFO", `Bizum reconciler: ${bizumRows.length} Bizum(s) entrante(s) a procesar.`);

  // --- PASO 2: Agrupar Bizums por ventana temporal ---
  const groups = _groupBizumsByTimeWindow(bizumRows);
  logEvent("INFO", `Bizum reconciler: ${groups.length} grupo(s) identificado(s).`);

  // --- PASO 3 + 4: Cruzar cada grupo con gastos y actuar ---
  const rowsToDelete  = new Set(); // sheetRows de Bizums a eliminar
  let adjusted        = 0;
  let converted       = 0;

  for (const group of groups) {
    const totalBizum   = group.reduce((sum, b) => sum + b.amount, 0);
    const groupDates   = group.map(b => b.date);
    const senderNames  = group.map(b => b.senderName).filter(Boolean).join(", ");

    const match = _findBestExpenseMatch(group, totalBizum, expenseRows);

    if (match) {
      // --- CASO A: Hay match — ajustamos el gasto ---
      const originalAmount = match.amount;
      const adjustedAmount = Math.round((originalAmount - totalBizum) * 100) / 100;
      const nPeople        = group.length + 1; // amigos + yo

      // Actualizamos valor (col F) y descripción (col E) del gasto
      sheet.getRange(match.sheetRow, 6).setValue(adjustedAmount);
      const newDesc = `${match.descripcion} [compartido: -${totalBizum.toFixed(2)}€ con ${group.length} persona${group.length > 1 ? "s" : ""}]`;
      sheet.getRange(match.sheetRow, 5).setValue(newDesc);

      // Marcamos las filas de Bizum para eliminar
      group.forEach(b => rowsToDelete.add(b.sheetRow));

      logEvent("INFO",
        `Bizum reconciler ✅ AJUSTE: "${match.descripcion}" ${originalAmount}€ → ${adjustedAmount}€ ` +
        `| Bizums: ${totalBizum.toFixed(2)}€ de [${senderNames}] ` +
        `| Fechas Bizum: ${groupDates.join(", ")} | Fecha gasto: ${match.date}`
      );
      adjusted++;

    } else {
      // --- CASO B: Sin match — convertimos cada Bizum en ingreso real ---
      for (const bizum of group) {
        sheet.getRange(bizum.sheetRow, 3).setValue("Otros");           // col C
        sheet.getRange(bizum.sheetRow, 4).setValue("Bizum");           // col D
        sheet.getRange(bizum.sheetRow, 5).setValue(`Bizum de ${bizum.senderName}`); // col E
        // col B (tipo) ya es "Ingreso" desde processTransactionLogic — no hay que cambiarlo
      }

      logEvent("INFO",
        `Bizum reconciler ℹ️ SIN MATCH: Bizum(s) de [${senderNames}] (${totalBizum.toFixed(2)}€) ` +
        `convertido(s) a ingreso. Revisar manualmente si procede.`
      );
      converted += group.length;
    }
  }

  // --- PASO 5: Eliminar filas de Bizum absorbidas (de abajo a arriba para no desplazar índices) ---
  const sortedRowsToDelete = Array.from(rowsToDelete).sort((a, b) => b - a);
  for (const sheetRow of sortedRowsToDelete) {
    sheet.deleteRow(sheetRow);
  }

  logEvent("INFO",
    `Bizum reconciler 🏁: ${adjusted} gasto(s) ajustado(s), ` +
    `${converted} Bizum(s) convertido(s) a ingreso, ` +
    `${sortedRowsToDelete.length} fila(s) eliminada(s).`
  );

  return { adjusted, converted, bizumRowsRemoved: sortedRowsToDelete.length };
}

// ==========================================
// AGRUPACIÓN POR VENTANA TEMPORAL
// ==========================================

/**
 * Agrupa Bizums que probablemente corresponden al mismo evento.
 * Criterio: Bizums dentro de CONFIG.BIZUM_TIME_SPAN_DAYS días entre sí.
 * Algoritmo greedy: cada Bizum se añade al grupo más reciente si está dentro del span.
 * @param {Array} bizumRows
 * @returns {Array<Array>} - Array de grupos, cada grupo es un array de bizumRows
 */
function _groupBizumsByTimeWindow(bizumRows) {
  const spanDays  = CONFIG.BIZUM_TIME_SPAN_DAYS || 3;
  const spanMs    = spanDays * 24 * 60 * 60 * 1000;

  // Ordenamos por fecha ascendente para el agrupamiento greedy
  const sorted = [...bizumRows].sort((a, b) => a.date.localeCompare(b.date));

  const groups = [];
  let currentGroup = [];

  for (const bizum of sorted) {
    if (currentGroup.length === 0) {
      currentGroup.push(bizum);
    } else {
      const lastDate    = new Date(currentGroup[currentGroup.length - 1].date);
      const currentDate = new Date(bizum.date);
      const diffMs      = currentDate - lastDate;

      if (diffMs <= spanMs) {
        currentGroup.push(bizum);
      } else {
        groups.push(currentGroup);
        currentGroup = [bizum];
      }
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  return groups;
}

// ==========================================
// MATCHING CON GASTOS SUSCEPTIBLES
// ==========================================

/**
 * Busca el gasto más adecuado para absorber un grupo de Bizums.
 * Condiciones:
 *   - Categoría susceptible
 *   - Dentro del time span respecto al primer/último Bizum del grupo
 *   - Gasto > suma Bizums
 *   - Ratio suma_bizums/gasto entre BIZUM_MATCH_MIN_RATIO y BIZUM_MATCH_MAX_RATIO
 * Desempate: más cercano en días al primer Bizum; si empate, mayor importe.
 * @param {Array}  group        - Grupo de Bizums
 * @param {number} totalBizum   - Suma de importes del grupo
 * @param {Array}  expenseRows  - Todos los gastos susceptibles de la hoja
 * @returns {object|null}
 */
function _findBestExpenseMatch(group, totalBizum, expenseRows) {
  const spanDays = CONFIG.BIZUM_TIME_SPAN_DAYS || 3;
  const spanMs   = spanDays * 24 * 60 * 60 * 1000;

  // Rango de fechas del grupo de Bizums
  const groupDates  = group.map(b => new Date(b.date));
  const firstBizum  = new Date(Math.min(...groupDates));
  const lastBizum   = new Date(Math.max(...groupDates));

  const candidates = [];

  for (const expense of expenseRows) {
    const expenseDate = new Date(expense.date);

    // El gasto puede estar hasta SPAN días antes del primer Bizum
    // o hasta SPAN días después del último (alguien paga tarde)
    const diffFromFirst = expenseDate - firstBizum;
    const diffFromLast  = expenseDate - lastBizum;

    const withinWindow =
      diffFromFirst >= -spanMs &&   // no más de SPAN días antes del primer Bizum
      diffFromLast  <=  spanMs;     // no más de SPAN días después del último Bizum

    if (!withinWindow) continue;

    // El gasto debe ser mayor que la suma de Bizums
    if (expense.amount <= totalBizum) continue;

    // El ratio debe estar dentro del margen configurado
    const ratio = totalBizum / expense.amount;
    if (ratio < BIZUM_MATCH_MIN_RATIO || ratio > BIZUM_MATCH_MAX_RATIO) continue;

    // Calculamos distancia en días al primer Bizum (para desempate)
    const daysDistance = Math.abs(diffFromFirst) / (24 * 60 * 60 * 1000);
    candidates.push({ ...expense, daysDistance });
  }

  if (candidates.length === 0) return null;

  // Desempate: menor distancia en días; si empate, mayor importe
  candidates.sort((a, b) => {
    if (Math.abs(a.daysDistance - b.daysDistance) > 0.01) {
      return a.daysDistance - b.daysDistance;
    }
    return b.amount - a.amount;
  });

  return candidates[0];
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Comprueba si una categoría+subcategoría es susceptible de gasto compartido.
 */
function _isShareable(categoria, subcategoria) {
  return SHAREABLE_CATEGORIES.some(
    s => s.categoria === categoria && s.subcategoria === subcategoria
  );
}
