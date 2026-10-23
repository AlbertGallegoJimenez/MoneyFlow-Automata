const CONFIG = {
  // ============================================================
  // REQUIRED — every user must fill these in
  // ============================================================
  MY_NAMES: [
    "YOUR FULL NAME",
    "Your Bank Alias",
    "Your Investment Platform Alias"
  ],
  SELF_TRANSFER_CONCEPT: [
    "your transfer concept"
  ],
  DROPZONE_FOLDER_ID: 'YOUR_GOOGLE_DRIVE_FOLDER_ID',
  PROCESSED_FOLDER_ID: 'YOUR_PROCESSED_FOLDER_ID',
  CASH_FLOW_SHEET_NAME: 'Gastos', // HISTORICAL SHEET
  PORTFOLIO_SHEET_NAME: 'Historico_Portfolio', // HISTORICAL SHEET
  BUDGET_SHEET_NAME: 'Presupuesto', // HISTORICAL SHEET
  CURRENCY: 'EUR',
  NOTIFICATION_EMAIL: 'YOUR_EMAIL_ADDRESS', // left as is (or empty) => the summary goes to your own account
  BIZUM_TIME_SPAN_DAYS: 3,

  // ============================================================
  // OPTIONAL — delete any line you do not need (defaults are used)
  // ============================================================

  // Bank where your Bizum is linked. Its incoming Bizums are matched against shared expenses.
  //   "Trade Republic" | "Caixabank" | "MyInvestor" | ""  (empty = no Bizum reconciliation)
  // For Caixabank and MyInvestor the Bizum is detected by the word "bizum" in the concept.
  BIZUM_BANK: "Trade Republic",

  // Name of the live portfolio tab that guardarFotoPortfolio() copies into PORTFOLIO_SHEET_NAME.
  PORTFOLIO_SOURCE_SHEET_NAME: "Portfolio",

  // Logos for brokers that are not built in (broker name must match the sheet exactly).
  BROKER_LOGOS: {
    // "My Broker": "https://example.com/logo.png"
  },

  // Dashboard settings
  DASHBOARD: {
    // Savings goal (card in Patrimonio). It is hidden while AMOUNT is 0.
    GOAL: { ENABLED: true, NAME: "Entrada Vivienda", EMOJI: "🏡", AMOUNT: 0 },

    // 50/30/20 rule. Only list what differs from the defaults: category maps are merged
    // with the built-in ones. Savings ("Inversión y ahorro") always count as "Ahorro".
    RULE_5030: {
      TARGETS: { Necesidades: 50, Deseos: 30, Ahorro: 20 },
      // CATEGORY_MAP: { "Mascotas": "Necesidades" },
      // SUBCATEGORY_OVERRIDES: { "Transporte|Taxi/VTC": "Deseos" }
    },

    // NO_RETURN_CLASSES: ["Efectivo"],   // asset classes that never show a return
    // LOCALE: "es-ES",                   // number and date format
    // PREVISTO_BASIS: "monthly"          // "annual" if `previsto` in the budget sheet is a yearly amount
  }
};
