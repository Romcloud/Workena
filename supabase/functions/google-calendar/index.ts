import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-google-calendar-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Connection = {
  company_id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  sync_token: string | null;
  last_sync_at: string | null;
};

type WorkOrderRow = {
  id: string;
  company_id: string;
  title: string;
  address: string;
  due_date: string;
  description: string;
  status: string;
  contact_phone: string | null;
  starts_at: string | null;
  ends_at: string | null;
  time_to_arrange: boolean;
  updated_at: string;
};

type EventMapping = {
  work_order_id: string;
  company_id: string;
  user_id: string;
  google_event_id: string;
  work_order_updated_at: string;
  google_updated_at: string;
  google_deleted_at: string | null;
};

type GoogleEvent = {
  id: string;
  status?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};

type GoogleEventsPage = {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
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

function secretsMatch(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function localDateTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Google Kalendár vrátil neplatný dátum.");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function makeGoogleEvent(order: WorkOrderRow, timeZone: string) {
  const privateProperties = { workenaOrderId: order.id };
  const description = [
    order.description,
    `Adresa: ${order.address}`,
    order.contact_phone ? `Telefón: ${order.contact_phone}` : "",
    "Spravované cez Workena",
  ].filter(Boolean).join("\n\n");
  if (order.starts_at && order.ends_at) {
    return {
      summary: order.title,
      location: order.address,
      description,
      start: { dateTime: `${order.due_date}T${order.starts_at}`, timeZone },
      end: { dateTime: `${order.due_date}T${order.ends_at}`, timeZone },
      extendedProperties: { private: privateProperties },
    };
  }
  return {
    summary: order.title,
    location: order.address,
    description,
    start: { date: order.due_date },
    end: { date: nextDate(order.due_date) },
    extendedProperties: { private: privateProperties },
  };
}

function parseGoogleSchedule(event: GoogleEvent, order: WorkOrderRow, timeZone: string) {
  if (event.start?.date) {
    return {
      due_date: event.start.date,
      starts_at: null,
      ends_at: null,
      time_to_arrange: order.time_to_arrange,
    };
  }
  if (!event.start?.dateTime || !event.end?.dateTime) {
    throw new Error("Udalosť Google Kalendára nemá platný začiatok a koniec.");
  }
  const zone = event.start.timeZone || timeZone;
  const start = localDateTime(event.start.dateTime, zone);
  const end = localDateTime(event.end.dateTime, event.end.timeZone || zone);
  if (start.date !== end.date || end.time <= start.time) {
    return { due_date: start.date, starts_at: null, ends_at: null, time_to_arrange: true };
  }
  return {
    due_date: start.date,
    starts_at: start.time,
    ends_at: end.time,
    time_to_arrange: false,
  };
}

async function googleRequest<T>(
  accessToken: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Google Kalendár: ${response.status} ${responseText.slice(0, 500)}`);
  }
  if (response.status === 204) return null as T;
  return await response.json() as T;
}

async function listGoogleChanges(accessToken: string, syncToken: string | null) {
  const events: GoogleEvent[] = [];
  let pageToken = "";
  let nextSyncToken: string | null = null;
  do {
    const params = new URLSearchParams({ maxResults: "2500", showDeleted: "true" });
    if (syncToken) params.set("syncToken", syncToken);
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 410 && syncToken) return await listGoogleChanges(accessToken, null);
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`Google Kalendár: ${response.status} ${responseText.slice(0, 500)}`);
    }
    const page = await response.json() as GoogleEventsPage;
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken ?? "";
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);
  return { events, syncToken: nextSyncToken };
}

async function refreshGoogleAccessToken(connection: Connection, adminClient: ReturnType<typeof createClient>) {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar OAuth nie je nakonfigurovaný na serveri.");
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokenResult = await tokenResponse.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!tokenResponse.ok || !tokenResult.access_token) {
    throw new Error(tokenResult.error_description ?? "Google neprijal obnovovací token. Znovu pripojte Google Kalendár.");
  }
  const expiresAt = new Date(Date.now() + (tokenResult.expires_in ?? 3600) * 1000).toISOString();
  const { error: saveError } = await adminClient
    .from("google_calendar_connections")
    .update({ access_token: tokenResult.access_token, access_token_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("company_id", connection.company_id)
    .eq("user_id", connection.user_id);
  if (saveError) throw saveError;
  return { ...connection, access_token: tokenResult.access_token, access_token_expires_at: expiresAt };
}

async function syncCompanyCalendar(
  adminClient: ReturnType<typeof createClient>,
  originalConnection: Connection,
) {
  const { data: activeMember, error: memberError } = await adminClient
    .from("memberships")
    .select("user_id, role")
    .eq("company_id", originalConnection.company_id)
    .eq("user_id", originalConnection.user_id)
    .eq("active", true)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!activeMember) return { connected: false, skipped: true };

  const lockToken = crypto.randomUUID();
  const lockTime = new Date().toISOString();
  const { data: lock, error: lockError } = await adminClient
    .from("google_calendar_connections")
    .update({
      sync_lock_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      sync_lock_token: lockToken,
    })
    .eq("company_id", originalConnection.company_id)
    .eq("user_id", originalConnection.user_id)
    .or(`sync_lock_until.is.null,sync_lock_until.lt.${lockTime}`)
    .select("company_id, user_id")
    .maybeSingle();
  if (lockError) throw lockError;
  if (!lock) return { connected: true, skipped: true };

  try {
    return await syncCompanyCalendarLocked(adminClient, originalConnection, activeMember.role);
  } finally {
    const { error: unlockError } = await adminClient
      .from("google_calendar_connections")
      .update({ sync_lock_until: null, sync_lock_token: null })
      .eq("company_id", originalConnection.company_id)
      .eq("user_id", originalConnection.user_id)
      .eq("sync_lock_token", lockToken);
    if (unlockError) throw unlockError;
  }
}

async function syncCompanyCalendarLocked(
  adminClient: ReturnType<typeof createClient>,
  originalConnection: Connection,
  memberRole: string,
) {
  let connection = originalConnection;
  if (new Date(connection.access_token_expires_at).getTime() < Date.now() + 120_000) {
    connection = await refreshGoogleAccessToken(connection, adminClient);
  }

  const { data: orderRows, error: ordersError } = await adminClient
    .from("work_orders")
    .select("id, company_id, title, address, due_date, description, status, contact_phone, starts_at, ends_at, time_to_arrange, updated_at")
    .eq("company_id", connection.company_id);
  if (ordersError) throw ordersError;
  let visibleOrderRows = orderRows ?? [];
  if (memberRole !== "OWNER") {
    const { data: assignmentRows, error: assignmentsError } = await adminClient
      .from("work_order_assignees")
      .select("work_order_id")
      .eq("company_id", connection.company_id)
      .eq("user_id", connection.user_id)
      .is("declined_at", null)
      .is("reassigned_at", null);
    if (assignmentsError) throw assignmentsError;
    const assignedOrderIds = new Set((assignmentRows ?? []).map((assignment) => assignment.work_order_id));
    visibleOrderRows = visibleOrderRows.filter((order) => assignedOrderIds.has(order.id));
  }
  const orders = visibleOrderRows as WorkOrderRow[];
  const ordersById = new Map(orders.map((order) => [order.id, order]));

  const { data: mappingRows, error: mappingError } = await adminClient
    .from("google_work_order_events")
    .select("work_order_id, company_id, user_id, google_event_id, work_order_updated_at, google_updated_at, google_deleted_at")
    .eq("company_id", connection.company_id)
    .eq("user_id", connection.user_id);
  if (mappingError) throw mappingError;
  const mappings = (mappingRows ?? []) as EventMapping[];
  const mappingByEvent = new Map(mappings.map((mapping) => [mapping.google_event_id, mapping]));
  const mappingByOrder = new Map(mappings.map((mapping) => [mapping.work_order_id, mapping]));
  const { events, syncToken } = await listGoogleChanges(connection.access_token, connection.sync_token);
  const timeZone = Deno.env.get("WORKENA_TIMEZONE") ?? "Europe/Bratislava";
  let pulled = 0;
  let pushed = 0;
  let removed = 0;

  for (const event of events) {
    const orderId = event.extendedProperties?.private?.workenaOrderId;
    const mapping = mappingByEvent.get(event.id) ?? (orderId ? mappingByOrder.get(orderId) : undefined);
    if (!mapping) continue;
    const order = ordersById.get(mapping.work_order_id);
    if (!order) continue;

    if (event.status === "cancelled") {
      const deletedAt = event.updated ?? new Date().toISOString();
      const { error: deletedError } = await adminClient
        .from("google_work_order_events")
        .update({ google_deleted_at: deletedAt, google_updated_at: deletedAt, updated_at: new Date().toISOString() })
        .eq("work_order_id", order.id)
        .eq("company_id", connection.company_id)
        .eq("user_id", connection.user_id);
      if (deletedError) throw deletedError;
      mapping.google_deleted_at = deletedAt;
      mapping.google_updated_at = deletedAt;
      removed++;
      continue;
    }

    const eventUpdatedAt = event.updated ?? mapping.google_updated_at;
    const orderChanged = new Date(order.updated_at).getTime() > new Date(mapping.work_order_updated_at).getTime();
    const eventChanged = new Date(eventUpdatedAt).getTime() > new Date(mapping.google_updated_at).getTime();
    if (eventChanged && (!orderChanged || new Date(eventUpdatedAt).getTime() >= new Date(order.updated_at).getTime())) {
      const schedule = parseGoogleSchedule(event, order, timeZone);
      const updatedOrder = {
        title: event.summary?.trim().length && event.summary.trim().length <= 140 ? event.summary.trim() : order.title,
        address: event.location?.trim().length && event.location.trim().length <= 250 ? event.location.trim() : order.address,
        description: event.description?.trim().length && event.description.trim().length >= 2 && event.description.trim().length <= 4000
          ? event.description.trim().split("\n\nAdresa:")[0].slice(0, 4000)
          : order.description,
        ...schedule,
        updated_at: new Date().toISOString(),
      };
      const { error: updateError } = await adminClient
        .from("work_orders")
        .update(updatedOrder)
        .eq("id", order.id)
        .eq("company_id", connection.company_id)
        .neq("status", "DONE");
      if (updateError) throw updateError;
      Object.assign(order, updatedOrder);
      pulled++;
    } else if (orderChanged && order.status !== "DONE") {
      const updatedEvent = await googleRequest<GoogleEvent>(
        connection.access_token,
        `/calendars/primary/events/${encodeURIComponent(mapping.google_event_id)}`,
        "PATCH",
        makeGoogleEvent(order, timeZone),
      );
      Object.assign(event, updatedEvent ?? {});
      pushed++;
    }

    const { error: saveMappingError } = await adminClient
      .from("google_work_order_events")
      .update({
        work_order_updated_at: order.updated_at,
        google_updated_at: event.updated ?? eventUpdatedAt,
        google_deleted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("work_order_id", order.id)
      .eq("company_id", connection.company_id)
      .eq("user_id", connection.user_id);
    if (saveMappingError) throw saveMappingError;
    mapping.work_order_updated_at = order.updated_at;
    mapping.google_updated_at = event.updated ?? eventUpdatedAt;
    mapping.google_deleted_at = null;
  }

  for (const order of orders) {
    const mapping = mappingByOrder.get(order.id);
    if (order.status === "DONE") {
      if (mapping) {
        try {
          await googleRequest<null>(
            connection.access_token,
            `/calendars/primary/events/${encodeURIComponent(mapping.google_event_id)}`,
            "DELETE",
          );
        } catch (reason) {
          if (!errorMessage(reason).includes("Google Kalendár: 404")) throw reason;
        }
        const { error: deleteMappingError } = await adminClient
          .from("google_work_order_events")
          .delete()
          .eq("work_order_id", order.id)
          .eq("company_id", connection.company_id)
          .eq("user_id", connection.user_id);
        if (deleteMappingError) throw deleteMappingError;
        mappingByOrder.delete(order.id);
        removed++;
      }
      continue;
    }
    if (mapping) {
      if (mapping.google_deleted_at && new Date(order.updated_at).getTime() <= new Date(mapping.work_order_updated_at).getTime()) continue;
      if (mapping.google_deleted_at) {
        const { error: removeDeletedMappingError } = await adminClient
          .from("google_work_order_events")
          .delete()
          .eq("work_order_id", order.id)
          .eq("company_id", connection.company_id)
          .eq("user_id", connection.user_id);
        if (removeDeletedMappingError) throw removeDeletedMappingError;
        mappingByOrder.delete(order.id);
      } else {
        continue;
      }
    }
    const createdEvent = await googleRequest<GoogleEvent>(
      connection.access_token,
      "/calendars/primary/events",
      "POST",
      makeGoogleEvent(order, timeZone),
    );
    if (!createdEvent.id || !createdEvent.updated) throw new Error("Google Kalendár nevytvoril udalosť.");
    const newMapping: EventMapping = {
      work_order_id: order.id,
      company_id: connection.company_id,
      user_id: connection.user_id,
      google_event_id: createdEvent.id,
      work_order_updated_at: order.updated_at,
      google_updated_at: createdEvent.updated,
      google_deleted_at: null,
    };
    const { error: insertMappingError } = await adminClient
      .from("google_work_order_events")
      .upsert(newMapping, { onConflict: "company_id,user_id,work_order_id" });
    if (insertMappingError) throw insertMappingError;
    mappingByOrder.set(order.id, newMapping);
    pushed++;
  }

  const syncedAt = new Date().toISOString();
  const { error: updateConnectionError } = await adminClient
    .from("google_calendar_connections")
    .update({ sync_token: syncToken ?? connection.sync_token, last_sync_at: syncedAt, updated_at: syncedAt })
    .eq("company_id", connection.company_id)
    .eq("user_id", connection.user_id);
  if (updateConnectionError) throw updateConnectionError;
  return { connected: true, syncedAt, pulled, pushed, removed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json(500, { error: "Supabase služba nie je nakonfigurovaná." });
    }
    const body = await req.json() as {
      action?: string;
      companyId?: string;
      accessToken?: string;
      refreshToken?: string;
    };
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (body.action === "scheduled_sync") {
      const expectedSecret = Deno.env.get("GOOGLE_CALENDAR_SYNC_SECRET");
      const providedSecret = req.headers.get("x-google-calendar-sync-secret");
      if (!expectedSecret || !providedSecret || !secretsMatch(expectedSecret, providedSecret)) {
        return json(401, { error: "Neplatná autorizácia plánovanej synchronizácie." });
      }
      const { data: connections, error: connectionsError } = await adminClient
        .from("google_calendar_connections")
        .select("company_id, user_id, access_token, refresh_token, access_token_expires_at, sync_token, last_sync_at");
      if (connectionsError) return json(500, { error: connectionsError.message });
      const failures: string[] = [];
      for (const connection of (connections ?? []) as Connection[]) {
        try {
          await syncCompanyCalendar(adminClient, connection);
        } catch (reason) {
          console.error("[google-calendar] scheduled sync failed", connection.company_id, connection.user_id, errorMessage(reason));
          failures.push(`${connection.company_id}: ${errorMessage(reason)}`);
        }
      }
      if (failures.length) return json(500, { error: "Niektoré kalendáre sa nepodarilo synchronizovať.", failures });
      return json(200, { synced: connections?.length ?? 0 });
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization) return json(401, { error: "Chýba autorizácia." });
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!anonKey) return json(500, { error: "Supabase prihlasovanie nie je nakonfigurované." });

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return json(401, { error: "Neplatné prihlásenie." });

    if (!body.companyId || !["connect", "status", "sync"].includes(body.action ?? "")) {
      return json(400, { error: "Požiadavka nemá platnú akciu alebo firmu." });
    }

    const { data: activeMember, error: memberError } = await adminClient
      .from("memberships")
      .select("user_id")
      .eq("company_id", body.companyId)
      .eq("user_id", authData.user.id)
      .eq("active", true)
      .maybeSingle();
    if (memberError) return json(500, { error: memberError.message });
    if (!activeMember) return json(403, { error: "Google Kalendár môže prepojiť iba aktívny člen firmy." });

    if (body.action === "connect") {
      if (!body.accessToken || !body.refreshToken) {
        return json(400, { error: "Google neposkytol prístupový aj obnovovací token. Znovu pripojte účet a potvrďte prístup ku kalendáru." });
      }
      const { error: connectionError } = await adminClient
        .from("google_calendar_connections")
        .upsert({
          company_id: body.companyId,
          user_id: authData.user.id,
          access_token: body.accessToken,
          refresh_token: body.refreshToken,
          access_token_expires_at: new Date(Date.now() + 3500_000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "company_id,user_id" });
      if (connectionError) return json(500, { error: connectionError.message });
      return json(200, { connected: true });
    }

    const { data: connection, error: connectionError } = await adminClient
      .from("google_calendar_connections")
      .select("company_id, user_id, access_token, refresh_token, access_token_expires_at, sync_token, last_sync_at")
      .eq("company_id", body.companyId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (connectionError) return json(500, { error: connectionError.message });
    if (!connection) return json(200, { connected: false, lastSyncAt: null });
    if (body.action === "status") {
      return json(200, { connected: true, lastSyncAt: connection.last_sync_at });
    }

    const result = await syncCompanyCalendar(adminClient, connection as Connection);
    return json(200, result);
  } catch (reason) {
    console.error("[google-calendar] request failed", errorMessage(reason));
    return json(500, { error: errorMessage(reason) });
  }
});
