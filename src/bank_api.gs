/**
 * Gestión de la conexión con la API de GoCardless (Nordigen)
 */

function getAccessToken() {
  const url = "https://bankaccountdata.gocardless.com/api/v2/token/new/";
  const payload = {
    "secret_id": CONFIG.SECRET_ID,
    "secret_key": CONFIG.SECRET_KEY
  };
  
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error("Error de autenticación: " + response.getContentText());
  }
  
  return JSON.parse(response.getContentText()).access;
}

function fetchTransactions(token) {
  const url = `https://bankaccountdata.gocardless.com/api/v2/accounts/${CONFIG.ACCOUNT_ID}/transactions/`;
  const options = {
    method: "get",
    headers: { "Authorization": `Bearer ${token}` },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());
  
  // Retornamos las transacciones "booked" (confirmadas)
  return data.transactions.booked || [];
}