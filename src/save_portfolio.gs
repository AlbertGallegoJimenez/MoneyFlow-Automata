/**
 * portfolio_history.gs
 * Script completo para hacer una "foto" de la pestaña Portfolio, 
 * guardando el nombre del bróker en texto y su URL de logo en una columna separada.
 */

function guardarFotoPortfolio() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaPortfolio = ss.getSheetByName("Portfolio");
  
  if (!hojaPortfolio) {
    throw new Error("No se ha encontrado la pestaña 'Portfolio'. Revisa el nombre.");
  }
  
  let hojaHistorico = ss.getSheetByName(CONFIG.PORTFOLIO_SHEET_NAME);
  
  // 1. Creación de hoja y cabeceras si no existe
  if (!hojaHistorico) {
    hojaHistorico = ss.insertSheet(CONFIG.PORTFOLIO_SHEET_NAME);
    const cabecerasOriginales = hojaPortfolio.getRange(1, 1, 1, 9).getValues()[0];
    
    // Inserción de nuevas cabeceras
    const nuevasCabeceras = ["Fecha de Captura"].concat(cabecerasOriginales).concat(["URL Logo"]);
    hojaHistorico.appendRow(nuevasCabeceras);
  } else {
    hojaHistorico.showSheet();
  }
  
  const ultimaFila = hojaPortfolio.getLastRow();
  if (ultimaFila < 2) return; 
  
  // 2. Extracción directa de valores
  const rangoDatos = hojaPortfolio.getRange(2, 1, ultimaFila - 1, 9);
  const datosBrutos = rangoDatos.getValues();
  
  // 3. Limpieza de datos y mapeo del logo mediante diccionario
  const datosLimpios = [];
  
  for (let i = 0; i < datosBrutos.length; i++) {
    const fila = datosBrutos[i];
    const activo = fila[2]; // Columna C
    
    if (activo !== null && activo !== undefined && String(activo).trim() !== "") {
      
      const broker = String(fila[3] || "").trim(); // Columna D
      const urlLogo = _mapBrokerLogo(broker);
      
      const filaCorregida = [...fila];
      filaCorregida[3] = broker;
      filaCorregida.push(urlLogo);
      
      datosLimpios.push(filaCorregida);
    }
  }
  
  if (datosLimpios.length === 0) {
    Logger.log("No hay datos válidos para guardar.");
    return;
  }

  // 4. Sistema anti-duplicados por firma (Capital_Valor)
  const capitalActual = datosLimpios.reduce((acc, fila) => acc + (Number(fila[4]) || 0), 0);
  const valorActual = datosLimpios.reduce((acc, fila) => acc + (Number(fila[5]) || 0), 0);
  const firmaActual = `${capitalActual.toFixed(2)}_${valorActual.toFixed(2)}`;

  const ultimaFilaHist = hojaHistorico.getLastRow();
  
  if (ultimaFilaHist > 1) {
    const numActivos = datosLimpios.length;
    const filaInicioHist = Math.max(2, ultimaFilaHist - numActivos + 1);
    
    const datosUltimaFoto = hojaHistorico.getRange(filaInicioHist, 2, numActivos, 10).getValues();
    
    const capitalHist = datosUltimaFoto.reduce((acc, fila) => acc + (Number(fila[4]) || 0), 0);
    const valorHist = datosUltimaFoto.reduce((acc, fila) => acc + (Number(fila[5]) || 0), 0);
    const firmaHist = `${capitalHist.toFixed(2)}_${valorHist.toFixed(2)}`;

    if (firmaActual === firmaHist) {
      ss.toast("Los datos son idénticos a la última vez. No se ha guardado ningún duplicado.", "Anti-duplicados", 4);
      return;
    }
  }
  
  const fechaCaptura = new Date();
  
  // 5. Saneamiento de tipos de datos antes del volcado
  const datosParaGuardar = datosLimpios.map(fila => {
    const filaSaneada = fila.map(celda => {
      if (typeof celda === 'number') return isFinite(celda) ? celda : "";
      if (celda instanceof Date) return isNaN(celda.getTime()) ? "" : celda;
      if (typeof celda === 'string' || typeof celda === 'boolean') return celda;
      return String(celda || "");
    });
    return [fechaCaptura].concat(filaSaneada);
  });
  
  // 6. Preparación de filas e inserción masiva
  const primeraFilaVacia = hojaHistorico.getLastRow() + 1;
  const filasNecesarias = primeraFilaVacia + datosParaGuardar.length - 1;
  const filasTotales = hojaHistorico.getMaxRows();
  
  if (filasNecesarias > filasTotales) {
    hojaHistorico.insertRowsAfter(filasTotales, (filasNecesarias - filasTotales) + 10);
  }
  
  const rangoDestino = hojaHistorico.getRange(primeraFilaVacia, 1, datosParaGuardar.length, datosParaGuardar[0].length);
  rangoDestino.setValues(datosParaGuardar);
  
  hojaHistorico.getRange(primeraFilaVacia, 1, datosParaGuardar.length, 2).setNumberFormat("dd/MM/yyyy");
  
  ss.toast(`Se han guardado ${datosParaGuardar.length} activos en el histórico.`, "Guardado Exitoso", 4);
}

/**
 * Función auxiliar para asignar el logo directamente desde el nombre en texto de la plataforma
 */
function _mapBrokerLogo(broker_name) {
  const broker = String(broker_name).trim();
  
  if (broker === "Trade Republic") return "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/trade-republic/default.svg";
  if (broker === "MyInvestor") return "https://cdn.brandfetch.io/idn8tOHll6/w/400/h/400/theme/dark/icon.jpeg?c=1bxid64Mup7aczewSAYMX&t=1743680844760";
  if (broker === "Caixabank") return "https://companieslogo.com/img/orig/CABK.MC-581477ce.png?t=1720244491";
  if (broker === "Indexa Capital") return "https://cdn.brandfetch.io/idFrtHnS3B/w/256/h/256/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B";
  if (broker === "Binance") return "https://images.seeklogo.com/logo-png/59/1/binance-icon-logo-png_seeklogo-598330.png";
  if (broker === "Banco Santander") return "https://companieslogo.com/img/orig/SAN-8a4d0f73.png?t=1720244493";
  if (broker === "BBVA") return "https://companieslogo.com/img/orig/BBVA-55b94247.png?t=1720244490";
  if (broker === "Banco Sabadell") return "https://companieslogo.com/img/orig/SAB.MC-c833cad0.png?t=1720244493";
  if (broker === "Bankinter") return "https://companieslogo.com/img/orig/BKT.MC-125e2416.png?t=1746968371";
  if (broker === "Revolut") return "https://cdn.brandfetch.io/idkTaHd18D/w/400/h/400/theme/dark/icon.png?c=1dxbfHSJFAPEGdCLU4o5B";
  if (broker === "Freedom 24") return "https://cdn.brandfetch.io/idiZHZSXhU/w/48/h/48/theme/dark/logo.png?c=1dxbfHSJFAPEGdCLU4o5B";
  if (broker === "EToro") return "https://cdn.brandfetch.io/idCL5_YhIb/w/400/h/400/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B";
  if (broker === "Occident") return "https://upload.wikimedia.org/wikipedia/commons/e/eb/Logo_occident.svg";
  
  return ""; 
}