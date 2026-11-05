export const GOOGLE_SHEETS_APPS_SCRIPT = String.raw`const WORKENA_SHARED_SECRET = "__WORKENA_SHARED_SECRET__";
const WORKENA_SHEET_NAME = "Workena";
const WORKENA_HEADERS = [
  "_workena_id",
  "Dátum",
  "Meno",
  "Lokalita",
  "Zdroj dopytu",
  "Produkt",
  "CP poslaná dňa",
  "Kontaktné údaje",
  "Približná cena",
  "Stav",
  "_workena_updated_at",
];
const WORKENA_FIELDS = [
  "id",
  "customer_date",
  "full_name",
  "location",
  "lead_source",
  "product",
  "quote_sent_date",
  "contact_details",
  "estimated_price",
  "status",
  "updated_at",
];
const WORKENA_HEADER_ALIASES = {
  id: ["_workena_id"],
  customer_date: ["Dátum", "Date"],
  full_name: ["Meno", "Meno zákazníka", "Zákazník", "Full name"],
  location: ["Lokalita", "Miesto", "Location"],
  lead_source: ["Zdroj dopytu", "Odkiaľ prišiel dopyt", "Odkiaľ prišiel dopyt?"],
  product: ["Produkt", "Produkty"],
  quote_sent_date: ["CP poslaná dňa", "Ponuka poslaná dňa", "Quote sent date"],
  contact_details: ["Kontaktné údaje", "Kontakt", "Contact details"],
  estimated_price: ["Približná cena", "Cca bez DPH", "Cena bez DPH", "Estimated price"],
  status: ["Stav", "Status"],
  approved: ["Schválená", "Schvalena"],
  rejected: ["Zamietnutá", "Zamietnuta"],
  no_response: ["Bez odpovede"],
  updated_at: ["_workena_updated_at"],
};

function normalizedHeader(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function headerMap(headers) {
  const normalized = headers.map(normalizedHeader);
  const find = (aliases) => {
    const aliasSet = aliases.map(normalizedHeader);
    return normalized.findIndex((header) => aliasSet.includes(header));
  };
  const indexes = {};
  Object.keys(WORKENA_HEADER_ALIASES).forEach((field) => {
    indexes[field] = find(WORKENA_HEADER_ALIASES[field]);
  });
  const missing = ["customer_date", "full_name", "location", "lead_source", "product", "quote_sent_date", "contact_details", "estimated_price"]
    .filter((field) => indexes[field] < 0);
  if (indexes.status < 0) {
    ["approved", "rejected", "no_response"].filter((field) => indexes[field] < 0).forEach((field) => missing.push(WORKENA_HEADER_ALIASES[field][0]));
  }
  if (indexes.id < 0) missing.push("_workena_id");
  if (indexes.updated_at < 0) missing.push("_workena_updated_at");
  if (missing.length) throw new Error("V hárku Workena chýbajú potrebné stĺpce: " + missing.join(", "));
  return indexes;
}

function hasCustomerHeaders(headers) {
  const normalized = new Set(headers.map(normalizedHeader));
  const contains = (field) => WORKENA_HEADER_ALIASES[field].some((alias) => normalized.has(normalizedHeader(alias)));
  const required = ["customer_date", "full_name", "location", "lead_source", "product", "quote_sent_date", "contact_details", "estimated_price"];
  return required.every(contains) && (
    contains("status") || (contains("approved") && contains("rejected") && contains("no_response"))
  );
}

function hasCustomerRows(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return false;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  if (!hasCustomerHeaders(headers)) return false;
  const normalized = headers.map(normalizedHeader);
  const nameIndex = normalized.findIndex((header) =>
    WORKENA_HEADER_ALIASES.full_name.some((alias) => normalizedHeader(alias) === header)
  );
  return sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues().some((cells) =>
    String(cells[nameIndex] ?? "").trim() !== ""
  );
}

function isChecked(value) {
  return value === true || String(value).trim().toLowerCase() === "true";
}

function statusFromCells(cells, indexes) {
  if (indexes.status >= 0) {
    const value = String(cells[indexes.status] || "").trim().toLowerCase();
    if (!value) return "";
    if (["approved", "schválená", "schvalena"].includes(value)) return "APPROVED";
    if (["rejected", "zamietnutá", "zamietnuta"].includes(value)) return "REJECTED";
    if (["no_response", "bez odpovede"].includes(value)) return "NO_RESPONSE";
    throw new Error("Neznámy stav zákazníka „" + value + "“. Použite Schválená, Zamietnutá alebo Bez odpovede.");
  }
  const checked = [
    indexes.approved >= 0 && isChecked(cells[indexes.approved]) ? "APPROVED" : "",
    indexes.rejected >= 0 && isChecked(cells[indexes.rejected]) ? "REJECTED" : "",
    indexes.no_response >= 0 && isChecked(cells[indexes.no_response]) ? "NO_RESPONSE" : "",
  ].filter(Boolean);
  if (checked.length > 1) throw new Error("V jednom riadku zaškrtnite iba jeden stav zákazníka.");
  return checked[0] || "";
}

function setupWorkena() {
  const spreadsheet = SpreadsheetApp.getActive();
  if (!spreadsheet) throw new Error("Otvorte tento skript cez Rozšírenia → Apps Script priamo v Google Tabuľke.");
  PropertiesService.getScriptProperties().setProperty("WORKENA_SPREADSHEET_ID", spreadsheet.getId());
  const sheets = spreadsheet.getSheets();
  const activeSheet = spreadsheet.getActiveSheet();
  const matchingSheets = [activeSheet, ...sheets.filter((candidate) => candidate.getSheetId() !== activeSheet.getSheetId())]
    .filter((candidate) => candidate.getLastColumn() > 0
      && hasCustomerHeaders(candidate.getRange(1, 1, 1, candidate.getLastColumn()).getDisplayValues()[0]));
  const sheet = matchingSheets.find(hasCustomerRows)
    || matchingSheets[0]
    || spreadsheet.getSheetByName(WORKENA_SHEET_NAME)
    || activeSheet;
  PropertiesService.getScriptProperties().setProperty("WORKENA_SHEET_ID", String(sheet.getSheetId()));
  const headers = sheet.getLastRow() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
  if (!headers.length || headers.every((value) => !value)) {
    sheet.getRange(1, 1, 1, WORKENA_HEADERS.length).setValues([WORKENA_HEADERS]);
  }
  let currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  if (currentHeaders.findIndex((header) => normalizedHeader(header) === normalizedHeader("_workena_id")) < 0) {
    currentHeaders.push("_workena_id");
    sheet.getRange(1, currentHeaders.length).setValue("_workena_id");
  }
  if (currentHeaders.findIndex((header) => normalizedHeader(header) === normalizedHeader("_workena_updated_at")) < 0) {
    currentHeaders.push("_workena_updated_at");
    sheet.getRange(1, currentHeaders.length).setValue("_workena_updated_at");
  }
  const indexes = headerMap(currentHeaders);
  sheet.setFrozenRows(1);
  sheet.hideColumns(indexes.id + 1);
  sheet.hideColumns(indexes.updated_at + 1);
  ScriptApp.getProjectTriggers()
    .filter((trigger) => ["onEditWorkena", "onChangeWorkena"].includes(trigger.getHandlerFunction()))
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger("onEditWorkena").forSpreadsheet(spreadsheet).onEdit().create();
  ScriptApp.newTrigger("onChangeWorkena").forSpreadsheet(spreadsheet).onChange().create();
  saveKnownIds();
}

function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    if (!request || request.secret !== WORKENA_SHARED_SECRET) return output({ ok: false, error: "Neplatný bezpečnostný kľúč." });
    if (request.action === "ping") return output({ ok: true });
    if (request.action === "read") {
      captureRemovedRows(request.lastSyncAt, false);
      return output({
        ok: true,
        rows: readRows(),
        deletedIds: readDeletedIds(),
      });
    }
    if (request.action === "apply") {
      applyChanges(
        request.rows || [],
        request.deleteIds || [],
        request.acknowledgedDeletedIds || [],
        request.expectedCustomerRowsById || {},
        request.expectedIds || [],
      );
      return output({ ok: true });
    }
    return output({ ok: false, error: "Neznáma požiadavka." });
  } catch (error) {
    return output({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function onEditWorkena(event) {
  if (!event || !event.range) return;
  const sheet = event.range.getSheet();
  const sheetId = PropertiesService.getScriptProperties().getProperty("WORKENA_SHEET_ID");
  if (!sheetId || String(sheet.getSheetId()) !== sheetId || event.range.getRow() < 2) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const idColumn = headers.indexOf("_workena_id") + 1;
  const updatedColumn = headers.indexOf("_workena_updated_at") + 1;
  if (!idColumn || !updatedColumn) return;
  const now = new Date().toISOString();
  const firstRow = event.range.getRow();
  const lastRow = firstRow + event.range.getNumRows() - 1;
  for (let row = firstRow; row <= lastRow; row += 1) {
    const id = String(sheet.getRange(row, idColumn).getValue() || "").trim();
    if (id) sheet.getRange(row, updatedColumn).setValue(now);
  }
  if (event.range.getColumn() === idColumn && event.range.getNumRows() === 1 && event.oldValue) {
    const state = readSyncState();
    const id = String(event.oldValue);
    state.deletedIds[id] = now;
    delete state.inferredIds[id];
    saveSyncState(state);
  }
}

function onChangeWorkena(event) {
  if (event && event.changeType === "REMOVE_ROW") captureRemovedRows();
}

function comparableDate(value, timeZone) {
  if (value instanceof Date) return Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
  const raw = String(value ?? "").trim();
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (isoDate) return isoDate[1];
  const skDate = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(raw);
  if (skDate) return skDate[3] + "-" + skDate[2].padStart(2, "0") + "-" + skDate[1].padStart(2, "0");
  const monthYear = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (monthYear) {
    const year = monthYear[2].length === 2 ? "20" + monthYear[2] : monthYear[2];
    return year + "-" + monthYear[1].padStart(2, "0") + "-01";
  }
  return raw.slice(0, 10);
}

function comparablePrice(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const normalized = String(value).replace(/[\s\u00a0€]/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? String(number) : normalized;
}

function applyChanges(rows, deleteIds, acknowledgedDeletedIds, expectedCustomerRowsById, expectedIds) {
  const sheet = workenaSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const indexes = headerMap(headers);
  const idColumn = indexes.id;
  const customerColumns = [
    indexes.customer_date,
    indexes.full_name,
    indexes.location,
    indexes.lead_source,
    indexes.product,
    indexes.quote_sent_date,
    indexes.contact_details,
    indexes.estimated_price,
    indexes.status,
    indexes.approved,
    indexes.rejected,
    indexes.no_response,
  ].filter((column) => column >= 0);
  const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== "";
  const existingRows = new Map();
  const existingCustomerIds = new Set();
  const spreadsheetTimeZone = sheet.getParent().getSpreadsheetTimeZone();
  for (let index = 1; index < data.length; index += 1) {
    const id = String(data[index][idColumn] || "").trim();
    if (id) {
      existingRows.set(id, index);
      if (customerColumns.some((column) => hasValue(data[index][column]))) existingCustomerIds.add(id);
    }
  }
  if (expectedIds.length !== existingCustomerIds.size || expectedIds.some((id) => !existingCustomerIds.has(String(id)))) {
    throw new Error("Tabuľka sa počas synchronizácie zmenila (počet alebo ID zákazníckych riadkov nesúhlasí). Údaje neboli prepísané; spustite synchronizáciu znova.");
  }
  if (expectedIds.length !== Object.keys(expectedCustomerRowsById).length || expectedIds.some((id) => !expectedCustomerRowsById[id])) {
    throw new Error("Apps Script nemá aktuálny kód na bezpečné porovnanie riadkov. Skopírujte nový skript z Workeny a nasaďte novú verziu.");
  }
  Object.keys(expectedCustomerRowsById).forEach((id) => {
    const rowIndex = existingRows.get(id);
    if (rowIndex === undefined) throw new Error("Tabuľka sa počas synchronizácie zmenila (riadok bol odstránený). Skúste synchronizovať znova.");
    const expectedRow = expectedCustomerRowsById[id];
    const actualRow = data[rowIndex];
    const mismatchedField = [
      ["customer_date", indexes.customer_date],
      ["full_name", indexes.full_name],
      ["location", indexes.location],
      ["lead_source", indexes.lead_source],
      ["product", indexes.product],
      ["quote_sent_date", indexes.quote_sent_date],
      ["contact_details", indexes.contact_details],
      ["estimated_price", indexes.estimated_price],
    ].find(([field, column]) => {
      const actual = actualRow[column];
      const expected = expectedRow[field];
      if (field === "customer_date" || field === "quote_sent_date") {
        return comparableDate(actual, spreadsheetTimeZone) !== comparableDate(expected, spreadsheetTimeZone);
      }
      if (field === "estimated_price") {
        return comparablePrice(actual) !== comparablePrice(expected);
      }
      return String(actual ?? "").trim() !== String(expected ?? "").trim();
    });
    const actualStatus = statusFromCells(actualRow, indexes);
    if (mismatchedField) throw new Error("Tabuľka sa počas synchronizácie zmenila (riadok " + (rowIndex + 1) + ", pole " + mismatchedField[0] + "). Údaje neboli prepísané; spustite synchronizáciu znova.");
    if (actualStatus !== String(expectedRow.status ?? "")) {
      throw new Error("Tabuľka sa počas synchronizácie zmenila (riadok " + (rowIndex + 1) + ", pole stav). Údaje neboli prepísané; spustite synchronizáciu znova.");
    }
  });
  const rowsById = new Map(rows.map((customer) => [String(customer.id), customer]));
  const deleteSet = new Set(deleteIds.map(String));
  const nextRows = [];
  let lastCustomerRowIndex = -1;
  for (let index = 1; index < data.length; index += 1) {
    const id = String(data[index][idColumn] || "").trim();
    if (!id) {
      if (data[index].some(hasValue)) {
        nextRows.push(data[index]);
        if (customerColumns.some((column) => hasValue(data[index][column]))) {
          lastCustomerRowIndex = nextRows.length - 1;
        }
      }
      continue;
    }
    if (deleteSet.has(id) || !rowsById.has(id)) continue;
    nextRows.push(valuesToCells(rowsById.get(id), headers, data[index]));
    lastCustomerRowIndex = nextRows.length - 1;
    rowsById.delete(id);
  }
  const newRows = [...rowsById.values()].map((customer) => valuesToCells(customer, headers));
  nextRows.splice(lastCustomerRowIndex + 1, 0, ...newRows);
  const result = [data[0], ...nextRows];
  sheet.getRange(1, 1, result.length, headers.length).setValues(result);
  if (data.length > result.length) sheet.getRange(result.length + 1, 1, data.length - result.length, headers.length).clearContent();

  const state = readSyncState();
  acknowledgedDeletedIds.forEach((id) => {
    delete state.deletedIds[String(id)];
    delete state.inferredIds[String(id)];
  });
  state.knownIds = readRows().map((row) => String(row.id || "").trim()).filter(Boolean);
  saveSyncState(state);
  saveKnownIds();
}

function valuesToCells(customer, headers, previousValues) {
  const indexes = headerMap(headers);
  return headers.map((header, index) => {
    const field = WORKENA_FIELDS.find((candidate) => indexes[candidate] === index);
    if (field === "status" || index === indexes.approved || index === indexes.rejected || index === indexes.no_response) {
      if (index === indexes.approved) return customer.status === "APPROVED";
      if (index === indexes.rejected) return customer.status === "REJECTED";
      if (index === indexes.no_response) return customer.status === "NO_RESPONSE";
      return customer.status === "APPROVED" ? "Schválená" : customer.status === "REJECTED" ? "Zamietnutá" : "Bez odpovede";
    }
    if (!field) return previousValues ? previousValues[index] : "";
    return customer[field] ?? "";
  });
}

function readRows() {
  const sheet = workenaSheet();
  const data = sheet.getDataRange().getValues();
  if (!data.length) return [];
  const headers = data[0].map(String);
  const indexes = headerMap(headers);
  const timeZone = sheet.getParent().getSpreadsheetTimeZone();
  return data.slice(1).map((cells, rowIndex) => {
    const row = {};
    WORKENA_FIELDS.forEach((field) => {
      if (field === "status") {
        row[field] = statusFromCells(cells, indexes);
        return;
      }
      const index = indexes[field];
      let value = index >= 0 ? cells[index] : "";
      if ((field === "customer_date" || field === "quote_sent_date") && value instanceof Date) {
        value = Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
      } else if (value instanceof Date) {
        value = value.toISOString();
      }
      row[field] = value === null || value === undefined ? "" : value;
    });
    const hasData = WORKENA_FIELDS.slice(1, -2).some((field) => String(row[field] || "").trim() !== "");
    if (hasData && !row.id) {
      row.id = Utilities.getUuid();
      row.updated_at = new Date().toISOString();
      sheet.getRange(rowIndex + 2, indexes.id + 1).setValue(row.id);
      sheet.getRange(rowIndex + 2, indexes.updated_at + 1).setValue(row.updated_at);
    }
    return row;
  }).filter((row) => row.id || WORKENA_FIELDS.slice(1, -2).some((field) => row[field] !== ""));
}

function captureRemovedRows(fallbackTimestamp, updateKnownIds = true) {
  const state = readSyncState();
  const current = readRows().map((row) => String(row.id || "").trim()).filter(Boolean);
  const currentSet = new Set(current);
  const parsedFallback = Date.parse(String(fallbackTimestamp || ""));
  const timestamp = Number.isNaN(parsedFallback) ? new Date().toISOString() : new Date(parsedFallback).toISOString();
  state.knownIds.filter((id) => !currentSet.has(id)).forEach((id) => {
    if (updateKnownIds && state.inferredIds[id]) {
      state.deletedIds[id] = new Date().toISOString();
      delete state.inferredIds[id];
    } else if (!state.deletedIds[id]) {
      state.deletedIds[id] = timestamp;
      if (!updateKnownIds) state.inferredIds[id] = true;
    }
  });
  if (updateKnownIds) state.knownIds = current;
  saveSyncState(state);
}

function saveKnownIds() {
  const state = readSyncState();
  state.knownIds = readRows().map((row) => String(row.id || "").trim()).filter(Boolean);
  saveSyncState(state);
}

function readDeletedIds() {
  return readSyncState().deletedIds;
}

function readSyncState() {
  const sheet = workenaStateSheet();
  const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues() : [];
  const state = { knownIds: [], deletedIds: {}, inferredIds: {} };
  values.forEach(([type, id, timestamp]) => {
    const key = String(id || "");
    if (type === "known" && key) state.knownIds.push(key);
    if (type === "deleted" && key) state.deletedIds[key] = String(timestamp || "");
    if (type === "inferred" && key) state.inferredIds[key] = true;
  });
  return state;
}

function saveSyncState(state) {
  const sheet = workenaStateSheet();
  const values = [["type", "id", "timestamp"]];
  state.knownIds.forEach((id) => values.push(["known", id, ""]));
  Object.keys(state.deletedIds).forEach((id) => values.push(["deleted", id, state.deletedIds[id]]));
  Object.keys(state.inferredIds).forEach((id) => values.push(["inferred", id, ""]));
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, 3).setValues(values);
}

function workenaStateSheet() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("WORKENA_SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("Spustite najskôr funkciu setupWorkena() z editora Google Tabuľky.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const sheet = spreadsheet.getSheetByName("_WorkenaSync") || spreadsheet.insertSheet("_WorkenaSync");
  sheet.hideSheet();
  return sheet;
}

function workenaSheet() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("WORKENA_SPREADSHEET_ID");
  const sheetId = PropertiesService.getScriptProperties().getProperty("WORKENA_SHEET_ID");
  if (!spreadsheetId || !sheetId) throw new Error("Spustite najskôr funkciu setupWorkena() z editora Google Tabuľky.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const sheet = spreadsheet.getSheetById(Number(sheetId));
  if (!sheet) throw new Error("Hárok s údajmi sa nenašiel. Spustite znovu funkciu setupWorkena() z editora Google Tabuľky.");
  return sheet;
}

function output(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}`;
