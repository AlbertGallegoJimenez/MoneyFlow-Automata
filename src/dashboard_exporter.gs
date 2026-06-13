/**
 * dashboard_exporter.gs
 * Sirve el dashboard como una Web App privada directamente desde Google Sheets.
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('MoneyFlow — Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Procesa los datos de la hoja de cálculo.
 * Ahora devuelve un objeto nativo, no un string.
 */
function getDashboardData() {
  // Intentamos usar el nombre de la hoja configurado en tu config.gs, si no, usamos "Gastos" por defecto
  let sheetName = "Gastos";
  try {
    if (typeof CONFIG !== 'undefined' && CONFIG.SHEET_NAME) {
      sheetName = CONFIG.SHEET_NAME;
    }
  } catch(e) {
    // Falla de forma silenciosa si no existe config.gs, y se mantiene con "Gastos"
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  
  if (!sheet) {
    throw new Error("No se encontró la pestaña llamada: " + sheetName);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { last_updated: new Date().toISOString(), total_transactions: 0, transactions: [] };
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  const transactions = [];

  for (const row of data) {
    const fecha      = row[0];
    const tipo       = row[1] ? String(row[1]).trim() : "";
    const categoria  = row[2] ? String(row[2]).trim() : "";
    const subcat     = row[3] ? String(row[3]).trim() : "";
    const valor      = parseFloat(row[5]) || 0;
    const metodoPago = row[6] ? String(row[6]).trim() : "";

    if (!tipo || !categoria || categoria === "__BIZUM_PENDIENTE__") continue;

    let fechaStr = "";
    if (fecha instanceof Date) {
      fechaStr = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else if (fecha) {
      fechaStr = String(fecha).trim();
    }
    if (!fechaStr) continue;

    transactions.push({
      fecha:        fechaStr,
      tipo:         tipo,
      categoria:    categoria,
      subcategoria: subcat,
      descripcion:  (row[4] ? String(row[4]).trim() : subcat),
      valor:        valor,
      metodo_pago:  metodoPago,
      banco:        _extractBank(metodoPago)
    });
  }

  return {
    last_updated: new Date().toISOString(),
    total_transactions: transactions.length,
    transactions: transactions
  };
}

function _extractBank(metodoPago) {
  const m = metodoPago.toLowerCase();
  if (m.includes("trade republic")) return "Trade Republic";
  if (m.includes("caixabank") || m.includes("cuenta principal")) return "Caixabank";
  if (m.includes("myinvestor")) return "MyInvestor";
  return "Otro";
}