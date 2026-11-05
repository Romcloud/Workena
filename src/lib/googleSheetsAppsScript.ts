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

function setupWorkena() {
  const spreadsheet = SpreadsheetApp.getActive();
  if (!spreadsheet) throw new Error("Otvorte tento skript cez Rozšírenia → Apps Script priamo v Google Tabuľke.");
  PropertiesService.getScriptProperties().setProperty("WORKENA_SPREADSHEET_ID", spreadsheet.getId());
  const sheet = workenaSheet();
  const headers = sheet.getLastRow() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
  if (!headers.length || headers.every((value) => !value)) {
    sheet.getRange(1, 1, 1, WORKENA_HEADERS.length).setValues([WORKENA_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.hideColumns(1);
    sheet.hideColumns(WORKENA_HEADERS.length);
  } else {
    const missing = WORKENA_HEADERS.filter((header) => !headers.includes(header));
    if (missing.length) throw new Error("V tabuľke chýbajú stĺpce: " + missing.join(", "));
    sheet.setFrozenRows(1);
    sheet.hideColumns(headers.indexOf("_workena_id") + 1);
    sheet.hideColumns(headers.indexOf("_workena_updated_at") + 1);
  }
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
        request.expectedUpdatedAtById || {},
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
  if (sheet.getName() !== WORKENA_SHEET_NAME || event.range.getRow() < 2) return;
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

function applyChanges(rows, deleteIds, acknowledgedDeletedIds, expectedUpdatedAtById, expectedIds) {
  const sheet = workenaSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const idColumn = headers.indexOf("_workena_id");
  const updatedColumn = headers.indexOf("_workena_updated_at");
  if (idColumn < 0) throw new Error("Spustite najskôr funkciu setupWorkena().");
  const existingRows = new Map();
  for (let index = 1; index < data.length; index += 1) {
    const id = String(data[index][idColumn] || "").trim();
    if (id) existingRows.set(id, index);
  }
  if (expectedIds.length !== existingRows.size || expectedIds.some((id) => !existingRows.has(String(id)))) {
    throw new Error("Tabuľka sa počas synchronizácie zmenila. Údaje neboli prepísané; spustite synchronizáciu znova.");
  }
  Object.keys(expectedUpdatedAtById).forEach((id) => {
    const rowIndex = existingRows.get(id);
    if (rowIndex === undefined) throw new Error("Tabuľka sa počas synchronizácie zmenila (riadok bol odstránený). Skúste synchronizovať znova.");
    const updatedAtValue = data[rowIndex][updatedColumn];
    const actualUpdatedAt = updatedAtValue instanceof Date ? updatedAtValue.toISOString() : String(updatedAtValue || "");
    if (actualUpdatedAt !== String(expectedUpdatedAtById[id] || "")) {
      throw new Error("Tabuľka sa počas synchronizácie zmenila. Údaje neboli prepísané; spustite synchronizáciu znova.");
    }
  });
  const rowsById = new Map(rows.map((customer) => [String(customer.id), customer]));
  const deleteSet = new Set(deleteIds.map(String));
  const nextRows = [];
  for (let index = 1; index < data.length; index += 1) {
    const id = String(data[index][idColumn] || "").trim();
    if (!id) {
      if (data[index].some((value) => value !== "")) nextRows.push(data[index]);
      continue;
    }
    if (deleteSet.has(id) || !rowsById.has(id)) continue;
    nextRows.push(valuesToCells(rowsById.get(id), headers, data[index]));
    rowsById.delete(id);
  }
  rowsById.forEach((customer) => nextRows.push(valuesToCells(customer, headers)));
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
  return headers.map((header, index) => {
    const fieldIndex = WORKENA_HEADERS.indexOf(header);
    if (fieldIndex < 0) return previousValues ? previousValues[index] : "";
    if (WORKENA_FIELDS[fieldIndex] === "status") {
      return customer.status === "APPROVED" ? "Schválená" : customer.status === "REJECTED" ? "Zamietnutá" : "Bez odpovede";
    }
    return customer[WORKENA_FIELDS[fieldIndex]] ?? "";
  });
}

function readRows() {
  const sheet = workenaSheet();
  const data = sheet.getDataRange().getValues();
  if (!data.length) return [];
  const headers = data[0].map(String);
  const indexes = WORKENA_HEADERS.map((header) => headers.indexOf(header));
  if (indexes.some((index) => index < 0)) throw new Error("Spustite najskôr funkciu setupWorkena().");
  const timeZone = sheet.getParent().getSpreadsheetTimeZone();
  return data.slice(1).map((cells, rowIndex) => {
    const row = {};
    WORKENA_FIELDS.forEach((field, index) => {
      let value = cells[indexes[index]];
      if ((field === "customer_date" || field === "quote_sent_date") && value instanceof Date) {
        value = Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
      } else if (value instanceof Date) {
        value = value.toISOString();
      }
      row[field] = value === null || value === undefined ? "" : value;
    });
    const hasData = WORKENA_FIELDS.slice(1, -1).some((field) => String(row[field] || "").trim() !== "");
    if (hasData && !row.id) {
      row.id = Utilities.getUuid();
      row.updated_at = new Date().toISOString();
      sheet.getRange(rowIndex + 2, indexes[0] + 1).setValue(row.id);
      sheet.getRange(rowIndex + 2, indexes[indexes.length - 1] + 1).setValue(row.updated_at);
    }
    return row;
  }).filter((row) => row.id || WORKENA_FIELDS.slice(1, -1).some((field) => row[field] !== ""));
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
  if (!spreadsheetId) throw new Error("Spustite najskôr funkciu setupWorkena() z editora Google Tabuľky.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  return spreadsheet.getSheetByName(WORKENA_SHEET_NAME) || spreadsheet.insertSheet(WORKENA_SHEET_NAME);
}

function output(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}`;
