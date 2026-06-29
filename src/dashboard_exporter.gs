/**
 * dashboard_exporter.gs
 * Sirve el dashboard como una Web App privada directamente desde Google Sheets.
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('MoneyFlow — Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getDashboardData() {
  let sheetName = CONFIG.CASH_FLOW_SHEET_NAME;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    throw new Error("No se encontró la pestaña llamada: " + sheetName);
  }

  // ==========================================
  // 1. EXTRACCIÓN DE DATOS DE GASTOS
  // ==========================================
  const lastRow = sheet.getLastRow();
  let transactions = [];
  
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

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
  }

  // ==========================================
  // 2. EXTRACCIÓN DE DATOS DEL PORTFOLIO
  // ==========================================
  const sheetPort = ss.getSheetByName(CONFIG.PORTFOLIO_SHEET_NAME);
  const dataPort = [];
  
  if (sheetPort) {
    const lastRowP = sheetPort.getLastRow();
    if (lastRowP >= 2) {
      // Forzamos leer hasta la columna 11 (K) para asegurar que cogemos el Logo
      const rawP = sheetPort.getRange(2, 1, lastRowP - 1, 11).getValues();
      
      for (const row of rawP) {
        if (!row[0] || !row[3]) continue; // Filtro de seguridad
        
        let fechaCap = "";
        if (row[0] instanceof Date) {
          fechaCap = Utilities.formatDate(row[0], Session.getScriptTimeZone(), "yyyy-MM-dd");
        } else {
          fechaCap = String(row[0]).trim();
        }
        
        // Conversor seguro de números (evita que un texto o coma rompa la gráfica)
        const parseNum = (val) => {
          const n = parseFloat(String(val).replace(/,/g, ''));
          return isNaN(n) ? 0 : n;
        };

        dataPort.push({
          fecha_captura: fechaCap,
          clase:   String(row[2] || "").trim(),
          activo:  String(row[3] || "").trim(),
          broker:  String(row[4] || "").trim(),
          capital: parseNum(row[5]),
          valor:   parseNum(row[6]),
          logo:    String(row[10] || "").trim() // Columna K
        });
      }
    }
  }

  // --- HOJA PRESUPUESTO ---
  const sheetPresupuesto = ss.getSheetByName(CONFIG.BUDGET_SHEET_NAME);
  const dataPresupuesto = [];
  if (sheetPresupuesto) {
    const lastRowPres = sheetPresupuesto.getLastRow();
    if (lastRowPres >= 2) {
      const rawPres = sheetPresupuesto.getRange(2, 1, lastRowPres - 1, 7).getValues();
      for (const row of rawPres) {

        // Conversor seguro de números (evita que un texto o coma rompa la gráfica)
        const parseNum = (val) => {
          const n = parseFloat(String(val).replace(/,/g, '').replace(/€/g, '').replace(/,/g, ''));
          return isNaN(n) ? 0 : n;
        };

        const anyo      = row[0] ? row[0].toString().trim() : "";
        const tipo      = row[1] ? row[1].toString().trim() : "";
        const categoria = row[2] ? row[2].toString().trim() : "";
        const subcat    = row[3] ? row[3].toString().trim() : "";
        const previsto  = parseNum(row[4]);
        const real      = parseNum(row[5]);
        const diferencia = parseNum(row[6]);

        if (!categoria || !subcat) continue;

        dataPresupuesto.push({ anyo, tipo, categoria, subcategoria: subcat, previsto, real, diferencia });
      }
    }
  }

  return {
    last_updated: new Date().toISOString(),
    total_transactions: transactions.length,
    transactions: transactions,
    portfolio_records: dataPort,
    presupuesto: dataPresupuesto
  };
}

function _extractBank(metodoPago) {
  const m = metodoPago.toLowerCase();
  if (m.includes("trade republic")) return "Trade Republic";
  if (m.includes("caixabank") || m.includes("cuenta principal")) return "Caixabank";
  if (m.includes("myinvestor")) return "MyInvestor";
  if (m.includes("binance")) return "Binance";
  if (m.includes("occident")) return "Occident";
  return "Otro";
}