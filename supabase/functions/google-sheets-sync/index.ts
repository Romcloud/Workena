import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const customerFields = [
  "customer_date",
  "full_name",
  "location",
  "lead_source",
  "product",
  "quote_sent_date",
  "contact_details",
  "estimated_price",
  "status",
] as const;

type CustomerStatus = "APPROVED" | "REJECTED" | "NO_RESPONSE";
type CustomerValues = {
  customer_date: string;
  full_name: string;
  location: string;
  lead_source: string;
  product: string;
  quote_sent_date: string | null;
  contact_details: string;
  estimated_price: number | null;
  status: CustomerStatus;
};
type CustomerRow = CustomerValues & {
  id: string;
  company_id: string;
  salesperson_id: string;
  created_at: string;
  updated_at: string;
};
type SheetRow = Omit<CustomerValues, "status"> & { id: string; status: CustomerStatus | ""; updated_at: string };
type PartialCustomerValues = Partial<CustomerValues>;
type SnapshotEntry = { values: CustomerValues; updated_at: string };
type Connection = {
  company_id: string;
  user_id: string;
  web_app_url: string | null;
  shared_secret: string;
  snapshot: Record<string, SnapshotEntry>;
  last_sync_at: string | null;
  sync_lock_until: string | null;
};
type SheetResponse = {
  ok?: boolean;
  error?: string;
  rows?: Record<string, unknown>[];
  deletedIds?: Record<string, string>;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Google Tabuľka vrátila neplatné údaje.");
  }
  return value as Record<string, unknown>;
}

function normalizedDate(value: unknown, optional = false) {
  const raw = String(value ?? "").trim();
  if (!raw && optional) return null;
  let date = raw;
  const skDate = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (skDate) date = `${skDate[3]}-${skDate[2].padStart(2, "0")}-${skDate[1].padStart(2, "0")}`;
  const monthYear = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (monthYear) {
    const month = Number(monthYear[1]);
    const year = monthYear[2].length === 2 ? 2000 + Number(monthYear[2]) : Number(monthYear[2]);
    if (month >= 1 && month <= 12) date = `${year}-${String(month).padStart(2, "0")}-01`;
  }
  date = date.slice(0, 10);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error(`Neplatný dátum v riadku tabuľky: ${raw || "(prázdny)"}. Použite formát RRRR-MM-DD, D.M.RRRR alebo M/RR.`);
  }
  return date;
}

function parseStatus(value: unknown): CustomerStatus {
  const status = String(value ?? "").trim().toLocaleUpperCase("sk");
  if (!status) return "NO_RESPONSE";
  if (status === "APPROVED" || status === "SCHVÁLENÁ" || status === "SCHVALENA") return "APPROVED";
  if (status === "REJECTED" || status === "ZAMIETNUTÁ" || status === "ZAMIETNUTA") return "REJECTED";
  if (status === "NO_RESPONSE" || status === "BEZ ODPOVEDE") return "NO_RESPONSE";
  throw new Error(`Neznámy stav zákazníka „${String(value)}“. Použite Schválená, Zamietnutá alebo Bez odpovede.`);
}

function parseSheetRow(value: unknown): SheetRow | null {
  const row = asObject(value);
  const idValue = String(row.id ?? "").trim();
  if (idValue && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idValue)) {
    throw new Error(`Riadok tabuľky má neplatné ID „${idValue}“. Skryté ID neupravujte.`);
  }
  const hasData = customerFields.some((field) => String(row[field] ?? "").trim() !== "");
  if (!hasData) return null;

  const fullName = String(row.full_name ?? "").trim();
  const location = String(row.location ?? "").trim();
  const leadSource = String(row.lead_source ?? "").trim() || "Neuvedené";
  const product = String(row.product ?? "").trim() || "Neuvedené";
  const contactDetails = String(row.contact_details ?? "").trim() || "Neuvedené";

  const rawPrice = String(row.estimated_price ?? "").trim();
  const priceValue = rawPrice.replace(/\s/g, "").replace(",", ".");
  const estimatedPrice = !rawPrice || rawPrice === "--" ? null : Number(priceValue);
  if (estimatedPrice !== null && (!Number.isFinite(estimatedPrice) || estimatedPrice < 0 || estimatedPrice > 9999999999.99)) {
    throw new Error(`Zákazník ${fullName}: cena musí byť nezáporné číslo.`);
  }

  const timestampValue = String(row.updated_at ?? "").trim();
  const timestamp = timestampValue && !Number.isNaN(Date.parse(timestampValue))
    ? new Date(Math.min(Date.parse(timestampValue), Date.now())).toISOString()
    : new Date().toISOString();
  const rawStatus = String(row.status ?? "").trim();
  return {
    id: idValue,
    customer_date: normalizedDate(row.customer_date, true) ?? new Date().toISOString().slice(0, 10),
    full_name: fullName,
    location,
    lead_source: leadSource,
    product,
    quote_sent_date: normalizedDate(row.quote_sent_date, true),
    contact_details: contactDetails,
    estimated_price: estimatedPrice,
    status: rawStatus ? parseStatus(rawStatus) : "",
    updated_at: timestamp,
  };
}

function valuesFromCustomer(row: CustomerRow): CustomerValues {
  return {
    customer_date: row.customer_date,
    full_name: row.full_name,
    location: row.location,
    lead_source: row.lead_source,
    product: row.product,
    quote_sent_date: row.quote_sent_date,
    contact_details: row.contact_details,
    estimated_price: row.estimated_price === null ? null : Number(row.estimated_price),
    status: row.status,
  };
}

function entryFromCustomer(row: CustomerRow): SnapshotEntry {
  const updatedAt = Date.parse(row.updated_at);
  return {
    values: valuesFromCustomer(row),
    updated_at: Number.isNaN(updatedAt) ? new Date(0).toISOString() : new Date(updatedAt).toISOString(),
  };
}

function valuesEqual(left: CustomerValues, right: CustomerValues) {
  return customerFields.every((field) => left[field] === right[field]);
}

function partialValuesEqual(left: PartialCustomerValues, right: CustomerValues) {
  return customerFields.every((field) => {
    const value = left[field];
    if (field === "estimated_price" && value !== undefined) return value === right[field];
    return isNonBlank(value) ? value === right[field] : !isNonBlank(right[field]);
  });
}

function isNonBlank<K extends keyof CustomerValues>(
  value: PartialCustomerValues[K],
): value is CustomerValues[K] {
  return value !== undefined
    && value !== null
    && value !== ""
    && !(typeof value === "string" && !value.trim());
}

function mergeCustomerValues(...sources: PartialCustomerValues[]): CustomerValues {
  const defaults: CustomerValues = {
    customer_date: "",
    full_name: "",
    location: "Neuvedené",
    lead_source: "",
    product: "",
    quote_sent_date: null,
    contact_details: "",
    estimated_price: null,
    status: "NO_RESPONSE",
  };
  const pick = <K extends Exclude<keyof CustomerValues, "estimated_price">>(field: K): CustomerValues[K] => {
    for (const source of sources) {
      const value = source[field];
      if (isNonBlank<K>(value)) return value;
    }
    return defaults[field];
  };
  const priceSource = sources.find((source) => source.estimated_price !== undefined);
  return {
    customer_date: pick("customer_date"),
    full_name: pick("full_name"),
    location: pick("location"),
    lead_source: pick("lead_source"),
    product: pick("product"),
    quote_sent_date: pick("quote_sent_date"),
    contact_details: pick("contact_details"),
    estimated_price: priceSource ? priceSource.estimated_price ?? null : defaults.estimated_price,
    status: pick("status"),
  };
}

function rowChanged(row: { values: PartialCustomerValues; updated_at: string }, snapshot: SnapshotEntry | undefined) {
  return !snapshot
    || customerFields.some((field) => field === "estimated_price"
      ? row.values.estimated_price !== undefined && row.values.estimated_price !== snapshot.values.estimated_price
      : isNonBlank(row.values[field]) && row.values[field] !== snapshot.values[field])
    || row.updated_at !== snapshot.updated_at;
}

function rowFromSheet(row: SheetRow): { values: PartialCustomerValues; updated_at: string } {
  const values: PartialCustomerValues = {
    customer_date: row.customer_date,
    full_name: row.full_name,
    location: row.location,
    lead_source: row.lead_source,
    product: row.product,
    quote_sent_date: row.quote_sent_date,
    contact_details: row.contact_details,
    estimated_price: row.estimated_price,
  };
  if (row.status) values.status = row.status;
  return { values, updated_at: row.updated_at };
}

function validateCustomerValues(values: CustomerValues) {
  const fullName = values.full_name.trim();
  const location = values.location.trim();
  const leadSource = values.lead_source.trim();
  const product = values.product.trim();
  const contactDetails = values.contact_details.trim();
  if (!values.customer_date.trim()) throw new Error("Dátum zákazníka je povinný.");
  normalizedDate(values.customer_date);
  if (fullName.length < 2 || fullName.length > 160) throw new Error("Meno zákazníka musí mať 2 až 160 znakov.");
  if (location.length > 250) throw new Error(`Zákazník ${fullName}: lokalita môže mať najviac 250 znakov.`);
  if (!leadSource || leadSource.length > 160) throw new Error(`Zákazník ${fullName}: zdroj dopytu je povinný (max. 160 znakov).`);
  if (!product || product.length > 200) throw new Error(`Zákazník ${fullName}: produkt je povinný (max. 200 znakov).`);
  if (contactDetails.length < 2 || contactDetails.length > 400) throw new Error(`Zákazník ${fullName}: kontakt musí mať 2 až 400 znakov.`);
}

function makeSharedSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateWebAppUrl(value: unknown) {
  const url = String(value ?? "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    throw new Error("Vložte platnú adresu Google Apps Scriptu, ktorá začína https://script.google.com/macros/s/ a končí /exec.");
  }
  return url;
}

async function callSheetScript(url: string, secret: string, payload: Record<string, unknown>): Promise<SheetResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, secret }),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Google Apps Script vrátil chybu ${response.status}. Skontrolujte nasadenie webovej aplikácie.`);
  const result = await response.json() as SheetResponse;
  if (result.ok !== true) throw new Error(result.error || "Google Apps Script neodpovedal platne.");
  return result;
}

async function performSync(
  userClient: ReturnType<typeof createClient>,
  adminClient: ReturnType<typeof createClient>,
  connection: Connection,
) {
  if (!connection.web_app_url) throw new Error("Najskôr pripojte Google Tabuľku podľa návodu.");
  const lockToken = crypto.randomUUID();
  const lockNow = new Date().toISOString();
  const { data: lock, error: lockError } = await adminClient
    .from("google_sheets_customer_connections")
    .update({
      sync_lock_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      sync_lock_token: lockToken,
    })
    .eq("company_id", connection.company_id)
    .eq("user_id", connection.user_id)
    .or(`sync_lock_until.is.null,sync_lock_until.lt.${lockNow}`)
    .select("company_id")
    .maybeSingle();
  if (lockError) throw lockError;
  if (!lock) throw new Error("Synchronizácia už prebieha. Skúste to o chvíľu.");

  try {
    const [{ data: databaseRows, error: customersError }, { data: deletionRows, error: deletionsError }] = await Promise.all([
      userClient.from("customers")
        .select("id,company_id,salesperson_id,customer_date,full_name,location,lead_source,product,quote_sent_date,contact_details,estimated_price,status,created_at,updated_at")
        .eq("company_id", connection.company_id)
        .eq("salesperson_id", connection.user_id),
      adminClient.from("google_sheets_customer_deletions")
        .select("customer_id,deleted_at")
        .eq("company_id", connection.company_id)
        .eq("salesperson_id", connection.user_id),
    ]);
    if (customersError) throw customersError;
    if (deletionsError) throw deletionsError;

    const sheetResult = await callSheetScript(connection.web_app_url, connection.shared_secret, {
      action: "read",
      lastSyncAt: connection.last_sync_at,
    });
    const parsedRows = (sheetResult.rows ?? []).map(parseSheetRow).filter((row): row is SheetRow => row !== null);
    if (parsedRows.length > 5000) throw new Error("Tabuľka má viac ako 5 000 zákazníkov. Rozdeľte ju alebo odstráňte prázdne riadky.");
    const sheetById = new Map<string, SheetRow>();
    for (const row of parsedRows) {
      if (!row.id) row.id = crypto.randomUUID();
      if (sheetById.has(row.id)) throw new Error(`V tabuľke sa opakuje ID zákazníka ${row.id}. Odstráňte duplicitný riadok a skúste znova.`);
      sheetById.set(row.id, row);
    }

    const dbRows = (databaseRows ?? []) as CustomerRow[];
    const dbById = new Map(dbRows.map((row) => [row.id, row]));
    const snapshot = connection.snapshot ?? {};
    const dbDeletedAt = new Map((deletionRows ?? []).map((row) => [row.customer_id, row.deleted_at]));
    const sheetDeletedAt = sheetResult.deletedIds ?? {};
    const allIds = new Set([
      ...Object.keys(snapshot),
      ...dbById.keys(),
      ...sheetById.keys(),
      ...dbDeletedAt.keys(),
      ...Object.keys(sheetDeletedAt),
    ]);
    const finalRows = new Map<string, { values: CustomerValues; updated_at: string }>();
    const acknowledgedDeletedIds: string[] = [];

    for (const id of allIds) {
      const dbRow = dbById.get(id);
      const sheetRow = sheetById.get(id);
      const previous = snapshot[id];
      if (!previous) {
        const dbEntry = dbRow ? entryFromCustomer(dbRow) : null;
        const sheetEntry = sheetRow ? rowFromSheet(sheetRow) : null;
        if (dbEntry && sheetEntry) {
          const preferred = Date.parse(dbEntry.updated_at) >= Date.parse(sheetEntry.updated_at) ? dbEntry : sheetEntry;
          const fallback = preferred === dbEntry ? sheetEntry : dbEntry;
          finalRows.set(id, {
            values: mergeCustomerValues(preferred.values, fallback.values),
            updated_at: preferred.updated_at,
          });
        } else if (dbEntry) {
          finalRows.set(id, dbEntry);
        } else if (sheetEntry) {
          finalRows.set(id, {
            values: mergeCustomerValues(sheetEntry.values),
            updated_at: sheetEntry.updated_at,
          });
        }
        acknowledgedDeletedIds.push(id);
        continue;
      }

      if (dbRow && sheetRow) {
        const dbEntry = entryFromCustomer(dbRow);
        const sheetEntry = rowFromSheet(sheetRow);
        const dbChanged = rowChanged(dbEntry, previous);
        const sheetChanged = rowChanged(sheetEntry, previous);
        const preferred = dbChanged && sheetChanged
          ? Date.parse(dbEntry.updated_at) >= Date.parse(sheetEntry.updated_at) ? dbEntry : sheetEntry
          : sheetChanged ? sheetEntry : dbEntry;
        const fallback = preferred === dbEntry ? sheetEntry : dbEntry;
        finalRows.set(id, {
          values: mergeCustomerValues(preferred.values, fallback.values, previous.values),
          updated_at: preferred.updated_at,
        });
      } else if (!dbRow && sheetRow) {
        const dbDeletion = dbDeletedAt.get(id);
        const sheetEntry = rowFromSheet(sheetRow);
        if (dbDeletion && Date.parse(dbDeletion) >= Date.parse(sheetEntry.updated_at)) {
          acknowledgedDeletedIds.push(id);
        } else {
          finalRows.set(id, {
            values: mergeCustomerValues(sheetEntry.values, previous.values),
            updated_at: sheetEntry.updated_at,
          });
        }
      } else if (dbRow && !sheetRow) {
        const sheetDeletion = sheetDeletedAt[id];
        const dbEntry = entryFromCustomer(dbRow);
        if (sheetDeletion && Date.parse(sheetDeletion) > Date.parse(dbEntry.updated_at)) {
          acknowledgedDeletedIds.push(id);
        } else {
          finalRows.set(id, dbEntry);
        }
      } else {
        acknowledgedDeletedIds.push(id);
      }
    }

    let createdFromSheet = 0;
    let createdInSheet = 0;
    let updatedInWorkena = 0;
    let updatedInSheet = 0;
    let deletedInWorkena = 0;
    let deletedInSheet = 0;
    const writeToDatabase: Array<CustomerValues & {
      id: string;
      company_id: string;
      salesperson_id: string;
      updated_at: string;
    }> = [];
    const databaseDeleteIds: string[] = [];
    const sheetDeleteIds: string[] = [];

    for (const [id, merged] of finalRows) {
      validateCustomerValues(merged.values);
      const existing = dbById.get(id);
      const sheetRow = sheetById.get(id);
      if (!existing) {
        const payload = {
          id,
          company_id: connection.company_id,
          salesperson_id: connection.user_id,
          ...merged.values,
          updated_at: merged.updated_at,
        };
        writeToDatabase.push(payload);
        if (sheetRow) createdFromSheet++;
        else updatedInWorkena++;
      } else if (!valuesEqual(entryFromCustomer(existing).values, merged.values) || entryFromCustomer(existing).updated_at !== merged.updated_at) {
        writeToDatabase.push({
          ...existing,
          ...merged.values,
          updated_at: merged.updated_at,
        });
        updatedInWorkena++;
      }

      if (!sheetRow || !partialValuesEqual(rowFromSheet(sheetRow).values, merged.values) || sheetRow.updated_at !== merged.updated_at) {
        if (sheetRow) updatedInSheet++;
        else createdInSheet++;
      }
    }

    for (const id of dbById.keys()) {
      if (!finalRows.has(id)) {
        databaseDeleteIds.push(id);
        deletedInWorkena++;
      }
    }
    for (const id of sheetById.keys()) {
      if (!finalRows.has(id)) {
        sheetDeleteIds.push(id);
        deletedInSheet++;
      }
    }

    for (const customer of writeToDatabase) {
      if (dbById.has(customer.id)) {
        const { id, ...customerValues } = customer;
        const { error: updateError } = await userClient.from("customers")
          .update(customerValues)
          .eq("id", id)
          .eq("company_id", connection.company_id)
          .eq("salesperson_id", connection.user_id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await userClient.from("customers").insert(customer);
        if (insertError) throw insertError;
      }
    }
    if (databaseDeleteIds.length) {
      const { error: deleteError } = await userClient.from("customers")
        .delete()
        .eq("company_id", connection.company_id)
        .eq("salesperson_id", connection.user_id)
        .in("id", databaseDeleteIds);
      if (deleteError) throw deleteError;
    }

    const sheetWriteRows = [...finalRows.entries()].map(([id, entry]) => ({
      id,
      ...entry.values,
      updated_at: entry.updated_at,
    }));
    await callSheetScript(connection.web_app_url, connection.shared_secret, {
      action: "apply",
      rows: sheetWriteRows,
      deleteIds: sheetDeleteIds,
      expectedUpdatedAtById: Object.fromEntries([...sheetById].map(([id, row]) => [id, row.updated_at])),
      expectedIds: [...sheetById.keys()],
      acknowledgedDeletedIds: [...new Set([...acknowledgedDeletedIds, ...dbById.keys(), ...sheetById.keys()])],
    });

    const nextSnapshot: Record<string, SnapshotEntry> = {};
    for (const [id, entry] of finalRows) nextSnapshot[id] = entry;
    const syncedAt = new Date().toISOString();
    const { error: saveError } = await adminClient.from("google_sheets_customer_connections")
      .update({ snapshot: nextSnapshot, last_sync_at: syncedAt, updated_at: syncedAt })
      .eq("company_id", connection.company_id)
      .eq("user_id", connection.user_id)
      .eq("sync_lock_token", lockToken);
    if (saveError) throw saveError;

    const processedIds = [...new Set([...allIds])];
    if (processedIds.length) {
      const { error: cleanError } = await adminClient.from("google_sheets_customer_deletions")
        .delete()
        .eq("company_id", connection.company_id)
        .eq("salesperson_id", connection.user_id)
        .in("customer_id", processedIds);
      if (cleanError) throw cleanError;
    }
    return {
      connected: true,
      syncedAt,
      createdFromSheet,
      createdInSheet,
      updatedInWorkena,
      updatedInSheet,
      deletedInWorkena,
      deletedInSheet,
    };
  } finally {
    const { error: unlockError } = await adminClient.from("google_sheets_customer_connections")
      .update({ sync_lock_until: null, sync_lock_token: null })
      .eq("company_id", connection.company_id)
      .eq("user_id", connection.user_id)
      .eq("sync_lock_token", lockToken);
    if (unlockError) throw unlockError;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Metóda nie je povolená." });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceRoleKey || !anonKey) return json(500, { error: "Supabase služba nie je nakonfigurovaná." });
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json(401, { error: "Chýba autorizácia." });

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return json(401, { error: "Neplatné prihlásenie." });
    const body = await req.json() as { action?: string; companyId?: string; webAppUrl?: string; salespersonId?: string };
    if (!body.companyId || !["create", "configure", "status", "sync", "disconnect"].includes(body.action ?? "")) {
      return json(400, { error: "Požiadavka nemá platnú akciu alebo firmu." });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: membership, error: membershipError } = await adminClient.from("memberships")
      .select("user_id,role,is_salesperson")
      .eq("company_id", body.companyId)
      .eq("user_id", authData.user.id)
      .eq("active", true)
      .maybeSingle();
    if (membershipError) return json(500, { error: membershipError.message });
    if (!membership) return json(403, { error: "Nemáte aktívne členstvo v tejto firme." });

    let syncUserId = authData.user.id;
    if (body.action === "sync" && body.salespersonId && body.salespersonId !== authData.user.id) {
      if (membership.role !== "OWNER") return json(403, { error: "Tabuľku iného obchodníka môže synchronizovať iba vlastník firmy." });
      const { data: targetMembership, error: targetMembershipError } = await adminClient.from("memberships")
        .select("user_id,is_salesperson")
        .eq("company_id", body.companyId)
        .eq("user_id", body.salespersonId)
        .eq("active", true)
        .maybeSingle();
      if (targetMembershipError) return json(500, { error: targetMembershipError.message });
      if (!targetMembership?.is_salesperson) return json(400, { error: "Vybraný člen nie je aktívny obchodník." });
      syncUserId = targetMembership.user_id;
    } else if (!membership.is_salesperson) {
      return json(403, { error: "Google Tabuľku môže pripojiť iba aktívny obchodník." });
    }

    if (body.action === "create") {
      const secret = makeSharedSecret();
      const { error: createError } = await adminClient.from("google_sheets_customer_connections").upsert({
        company_id: body.companyId,
        user_id: authData.user.id,
        shared_secret: secret,
        web_app_url: null,
        snapshot: {},
        last_sync_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "company_id,user_id" });
      if (createError) return json(500, { error: createError.message });
      return json(200, { secret });
    }

    if (body.action === "disconnect") {
      const { error: disconnectError } = await adminClient.from("google_sheets_customer_connections")
        .delete().eq("company_id", body.companyId).eq("user_id", authData.user.id);
      if (disconnectError) return json(500, { error: disconnectError.message });
      return json(200, { connected: false });
    }

    const { data: connection, error: connectionError } = await adminClient.from("google_sheets_customer_connections")
      .select("company_id,user_id,web_app_url,shared_secret,snapshot,last_sync_at,sync_lock_until")
      .eq("company_id", body.companyId)
      .eq("user_id", body.action === "sync" ? syncUserId : authData.user.id)
      .maybeSingle();
    if (connectionError) return json(500, { error: connectionError.message });
    if (!connection) {
      return body.action === "status"
        ? json(200, { connected: false, configured: false, lastSyncAt: null, webAppUrl: null })
        : json(409, { error: "Najskôr vytvorte bezpečný kľúč pre Google Apps Script." });
    }
    if (body.action === "status") {
      return json(200, {
        connected: Boolean(connection.web_app_url),
        configured: true,
        lastSyncAt: connection.last_sync_at,
        webAppUrl: connection.web_app_url,
      });
    }
    if (body.action === "configure") {
      const url = validateWebAppUrl(body.webAppUrl);
      await callSheetScript(url, connection.shared_secret, { action: "ping" });
      const { error: saveUrlError } = await adminClient.from("google_sheets_customer_connections")
        .update({ web_app_url: url, updated_at: new Date().toISOString() })
        .eq("company_id", body.companyId)
        .eq("user_id", authData.user.id);
      if (saveUrlError) return json(500, { error: saveUrlError.message });
      return json(200, { connected: true, webAppUrl: url });
    }

    const result = await performSync(userClient, adminClient, connection as Connection);
    return json(200, result);
  } catch (reason) {
    console.error("[google-sheets-sync] request failed", errorMessage(reason));
    return json(500, { error: errorMessage(reason) });
  }
});
