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
  
  let hojaHistorico = ss.getSheetByName("Historico_Portfolio");
  
  // 1. Si no existe, creamos la hoja con la nueva estructura de columnas
  if (!hojaHistorico) {
    hojaHistorico = ss.insertSheet("Historico_Portfolio");
    const cabecerasOriginales = hojaPortfolio.getRange(1, 1, 1, 9).getValues()[0];
    
    // Añadimos Fecha Captura al principio y URL Logo al final
    const nuevasCabeceras = ["Fecha de Captura"].concat(cabecerasOriginales).concat(["URL Logo"]);
    hojaHistorico.appendRow(nuevasCabeceras);
  } else {
    hojaHistorico.showSheet();
  }
  
  const ultimaFila = hojaPortfolio.getLastRow();
  if (ultimaFila < 2) return; 
  
  // 2. Extraer los datos brutos Y LAS FÓRMULAS
  const rangoDatos = hojaPortfolio.getRange(2, 1, ultimaFila - 1, 9);
  const datosBrutos = rangoDatos.getValues();
  const formulasBrutas = rangoDatos.getFormulas();
  
  // 3. FILTRO Y DESDOBLAMIENTO DE IMAGEN A TEXTO + URL
  const datosLimpios = [];
  
  for (let i = 0; i < datosBrutos.length; i++) {
    const fila = datosBrutos[i];
    const activo = fila[2]; // Columna C
    
    if (activo !== null && activo !== undefined && String(activo).trim() !== "") {
      
      let broker = fila[3]; 
      let formulaBroker = formulasBrutas[i][3];
      let urlLogo = "";
      
      if (String(broker) === "CellImage" || (formulaBroker && formulaBroker.toUpperCase().includes("IMAGE"))) {
        // Extraemos la URL de dentro de =IMAGE("url")
        const match = formulaBroker.match(/IMAGE\(\s*["']([^"']+)["']/i);
        if (match && match[1]) {
          urlLogo = match[1];
          broker = _obtenerNombreBroker(urlLogo);
        } else {
          broker = "Bróker desconocido";
        }
      } else {
        // Si ya era un texto manual, lo dejamos como está sin URL
        broker = String(broker).trim();
      }
      
      // Construimos la nueva fila: actualizamos el bróker y añadimos la URL al final
      const filaCorregida = [...fila];
      filaCorregida[3] = broker;
      filaCorregida.push(urlLogo); // Esto se convertirá en la columna K
      
      datosLimpios.push(filaCorregida);
    }
  }
  
  if (datosLimpios.length === 0) {
    Logger.log("No hay datos válidos para guardar.");
    return;
  }

  // --- SISTEMA ANTI-DUPLICADOS ---
  const capitalActual = datosLimpios.reduce((acc, fila) => acc + (Number(fila[4]) || 0), 0);
  const valorActual = datosLimpios.reduce((acc, fila) => acc + (Number(fila[5]) || 0), 0);
  const firmaActual = `${capitalActual.toFixed(2)}_${valorActual.toFixed(2)}`;

  const ultimaFilaHist = hojaHistorico.getLastRow();
  
  if (ultimaFilaHist > 1) {
    const numActivos = datosLimpios.length;
    const filaInicioHist = Math.max(2, ultimaFilaHist - numActivos + 1);
    
    // Ahora leemos 10 columnas de ancho (de la B a la K) para cuadrar con la nueva estructura
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
  
  // 4. SANEAMIENTO EXTREMO
  const datosParaGuardar = datosLimpios.map(fila => {
    const filaSaneada = fila.map(celda => {
      if (typeof celda === 'number') return isFinite(celda) ? celda : "";
      if (celda instanceof Date) return isNaN(celda.getTime()) ? "" : celda;
      if (typeof celda === 'string' || typeof celda === 'boolean') return celda;
      return String(celda || "");
    });
    return [fechaCaptura].concat(filaSaneada);
  });
  
  // 5. PREPARAR EL TERRENO PARA PEGAR
  const primeraFilaVacia = hojaHistorico.getLastRow() + 1;
  const filasNecesarias = primeraFilaVacia + datosParaGuardar.length - 1;
  const filasTotales = hojaHistorico.getMaxRows();
  
  if (filasNecesarias > filasTotales) {
    hojaHistorico.insertRowsAfter(filasTotales, (filasNecesarias - filasTotales) + 10);
  }
  
  // 6. PEGAR LOS DATOS
  const rangoDestino = hojaHistorico.getRange(primeraFilaVacia, 1, datosParaGuardar.length, datosParaGuardar[0].length);
  rangoDestino.setValues(datosParaGuardar);
  
  // Forzar el formato visual Día/Mes/Año en la columna A y B
  hojaHistorico.getRange(primeraFilaVacia, 1, datosParaGuardar.length, 2).setNumberFormat("dd/MM/yyyy");
  
  ss.toast(`Se han guardado ${datosParaGuardar.length} activos en el histórico.`, "Guardado Exitoso", 4);
}

/**
 * Función auxiliar para extraer el nombre del bróker a partir de la URL de la imagen
 */
function _obtenerNombreBroker(url) {
  const u = url.toLowerCase();
  if (u.includes("trade_republic")) return "Trade Republic";
  if (u.includes("myinvestor")) return "MyInvestor";
  if (u.includes("caixabank")) return "Caixabank";
  if (u.includes("indexa")) return "Indexa Capital";
  if (u.includes("occident")) return "Occident";
  if (u.includes("binance")) return "Binance";
  
  // Si no lo reconoce, devuelve la propia URL como nombre provisional
  return url;
}