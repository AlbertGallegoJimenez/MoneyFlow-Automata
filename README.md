# 💰 MoneyFlow-Automata: Smart Personal Finance

Sistema automatizado de gestión financiera personal que conecta bancos reales (vía API PSD2) con **Google Sheets** y **Power BI**. 

Este proyecto elimina la fricción del registro manual de gastos, aplicando lógica avanzada para inversiones, ahorros y proyecciones presupuestarias.

## 🌟 Características Principales

- **Automatización Total:** Sincronización diaria con entidades bancarias (incl. Trade Republic) mediante la API de GoCardless.
- **Lógica de Doble Asiento:** Gestión automática de *Round-ups* y *Savebacks* (registrados simultáneamente como ingreso y gasto/inversión).
- **Dashboard en Power BI:** Visualización avanzada con medidores de tasa de inversión y semáforos de salud presupuestaria.
- **Proyecciones Inteligentes:** Cálculo de gasto proyectado a fin de mes basado en media diaria ($Gasto \times 30$).

## 🛠️ Stack Tecnológico

- **Backend:** [Google Apps Script](https://developers.google.com/apps-script) (JavaScript).
- **Data Source:** [Google Sheets](https://www.google.com/sheets/about/).
- **BI & Analytics:** [Power BI Desktop](https://powerbi.microsoft.com/).
- **API:** [GoCardless Bank Account Data](https://gocardless.com/bank-account-data/) (ex-Nordigen).

## 📁 Estructura del Proyecto

- `/src`: Contiene los scripts encargados de la llamada a la API y el parseo de transacciones.
- `/powerbi`: Incluye el reporte interactivo y los modelos de datos.
- `/docs`: Documentación técnica para la renovación del consentimiento bancario (PSD2).

## 🔧 Instalación y Setup

1. **API Keys:** Crea una cuenta en el portal de desarrolladores de GoCardless y obtén tus credenciales.
2. **Google Apps Script:** Copia el contenido de `/src` en el editor de scripts de tu Google Sheet.
3. **Power BI:** Abre el archivo `.pbix` y vincula el origen de datos a tu URL de Google Sheets.
4. **Triggers:** Configura un activador (reloj) en Apps Script para ejecutarse cada 24 horas.

---
*Nota: Este repositorio no almacena credenciales bancarias reales por motivos de seguridad. Asegúrate de usar un archivo de configuración local o variables de entorno.*
