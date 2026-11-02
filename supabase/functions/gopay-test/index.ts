import { createClient } from "jsr:@supabase/supabase-js@2";

const GO_PAY_API = "https://gw.sandbox.gopay.com/api";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://workena.eu";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GO_PAY_GOID = Deno.env.get("GOPAY_GOID");
const GO_PAY_CLIENT_ID = Deno.env.get("GOPAY_CLIENT_ID");
const GO_PAY_CLIENT_SECRET = Deno.env.get("GOPAY_CLIENT_SECRET");

const PLAN_DETAILS = {
  BASIC: { name: "Basic", amountEur: 19 },
  PRO: { name: "Pro", amountEur: 39 },
  TEAM: { name: "Team", amountEur: 69 },
} as const;

type Plan = keyof typeof PLAN_DETAILS;
type GoPayPayment = { id: string | number; gw_url: string; state: string };
type GoPayStatus = { id: string | number; state: string };

function isPlan(value: unknown): value is Plan {
  return value === "BASIC" || value === "PRO" || value === "TEAM";
}

function json(status: number, body: Record<string, unknown>, origin = APP_ORIGIN) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Content-Type": "application/json",
      "Vary": "Origin",
    },
  });
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase server credentials are not configured.");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function requireGoPayCredentials() {
  if (!GO_PAY_GOID || !GO_PAY_CLIENT_ID || !GO_PAY_CLIENT_SECRET) {
    throw new Error("GoPay sandbox credentials are not configured.");
  }
}

async function getGoPayToken(scope: "payment-create" | "payment-all") {
  requireGoPayCredentials();
  const credentials = btoa(`${GO_PAY_CLIENT_ID}:${GO_PAY_CLIENT_SECRET}`);
  const response = await fetch(`${GO_PAY_API}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });

  if (!response.ok) {
    throw new Error(`GoPay token request failed (${response.status}).`);
  }
  const result = await response.json() as { access_token?: string };
  if (!result.access_token) throw new Error("GoPay did not return an access token.");
  return result.access_token;
}

async function goPayRequest<T>(
  path: string,
  scope: "payment-create" | "payment-all",
  method: "GET" | "POST",
  body?: Record<string, unknown>,
) {
  const token = await getGoPayToken(scope);
  const response = await fetch(`${GO_PAY_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) throw new Error(`GoPay request failed (${response.status}).`);
  return await response.json() as T;
}

async function authenticatedUser(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase authentication is not configured.");
  }
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

async function isActiveOwner(companyId: string, userId: string) {
  const { data, error } = await serviceClient()
    .from("memberships")
    .select("id")
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .eq("role", "OWNER")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error("Could not verify company ownership.");
  return Boolean(data);
}

async function createTestPayment(request: Request, origin: string) {
  const user = await authenticatedUser(request);
  if (!user) return json(401, { error: "Prihlásenie vypršalo. Prihláste sa znova." }, origin);

  const input = await request.json() as { companyId?: unknown; plan?: unknown };
  const companyId = typeof input.companyId === "string" ? input.companyId : "";
  const plan = input.plan;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId)
    || !isPlan(plan)) {
    return json(400, { error: "Vyberte platný firemný priestor a plán." }, origin);
  }
  if (!user.email) return json(400, { error: "Účet nemá kontaktný e-mail potrebný pre GoPay." }, origin);
  if (!await isActiveOwner(companyId, user.id)) {
    return json(403, { error: "Testovaciu GoPay platbu môže vytvoriť iba vlastník firmy." }, origin);
  }

  const details = PLAN_DETAILS[plan];
  const db = serviceClient();
  const orderNumber = `WK-${crypto.randomUUID()}`;
  const { error: insertError } = await db.from("gopay_test_payments").insert({
    company_id: companyId,
    requested_by: user.id,
    plan,
    amount_eur: details.amountEur,
    order_number: orderNumber,
  });
  if (insertError) {
    return json(500, { error: "Testovaciu platbu sa nepodarilo pripraviť. Skúste to znova." }, origin);
  }

  const displayName = typeof user.user_metadata?.full_name === "string"
    ? user.user_metadata.full_name.trim()
    : "";
  const fullName = displayName ? displayName.split(/\s+/) : [];
  const firstName = fullName.shift() || "Workena";
  const lastName = fullName.join(" ") || "Tester";
  try {
    const payment = await goPayRequest<GoPayPayment>("/payments/payment", "payment-create", "POST", {
      payer: {
        allowed_payment_instruments: ["PAYMENT_CARD"],
        contact: {
          first_name: firstName,
          last_name: lastName,
          email: user.email,
        },
      },
      target: { type: "ACCOUNT", goid: GO_PAY_GOID },
      amount: details.amountEur * 100,
      currency: "EUR",
      order_number: orderNumber,
      order_description: `Testovacia platba Workena ${details.name} - cena vratane DPH 23 %`,
      items: [{ name: `Workena ${details.name} - test`, amount: details.amountEur * 100, count: 1 }],
      callback: {
        return_url: `${APP_ORIGIN}/?gopay_test=return&order_number=${encodeURIComponent(orderNumber)}`,
        notification_url: `${SUPABASE_URL}/functions/v1/gopay-test?notification=1`,
      },
      lang: "SK",
    });

    const gatewayUrl = new URL(payment.gw_url);
    if (gatewayUrl.protocol !== "https:" || gatewayUrl.hostname !== "gw.sandbox.gopay.com") {
      throw new Error("GoPay returned an unexpected payment URL.");
    }

    const { error: updateError } = await db.from("gopay_test_payments").update({
      gopay_payment_id: String(payment.id),
      status: payment.state,
      updated_at: new Date().toISOString(),
    }).eq("order_number", orderNumber);
    if (updateError) {
      throw new Error("Could not store the GoPay test payment reference.");
    }

    return json(200, { paymentUrl: gatewayUrl.toString(), orderNumber }, origin);
  } catch (error) {
    console.error("GoPay sandbox payment creation failed:", error);
    const { error: updateError } = await db.from("gopay_test_payments")
      .update({ status: "CREATE_FAILED", updated_at: new Date().toISOString() })
      .eq("order_number", orderNumber);
    if (updateError) console.error("Could not record failed GoPay test payment.");
    return json(502, {
      error: "GoPay testovacia platba sa nepodarila vytvoriť. Skontrolujte sandbox konfiguráciu.",
    }, origin);
  }
}

async function refreshPaymentStatus(paymentId: string) {
  const status = await goPayRequest<GoPayStatus>(
    `/payments/payment/${encodeURIComponent(paymentId)}`,
    "payment-all",
    "GET",
  );
  const { error } = await serviceClient().from("gopay_test_payments").update({
    status: status.state,
    updated_at: new Date().toISOString(),
  }).eq("gopay_payment_id", String(status.id));
  if (error) throw new Error("Could not save the verified GoPay payment status.");
  return status.state;
}

async function handleNotification(request: Request) {
  let paymentId = new URL(request.url).searchParams.get("id") ?? "";
  if (!paymentId && request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as { id?: unknown };
      paymentId = typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : "";
    } else {
      const form = await request.formData();
      const value = form.get("id");
      paymentId = typeof value === "string" ? value : "";
    }
  }
  if (!/^[0-9]+$/.test(paymentId)) return json(400, { error: "Invalid payment reference." });

  const { data, error } = await serviceClient()
    .from("gopay_test_payments")
    .select("gopay_payment_id")
    .eq("gopay_payment_id", paymentId)
    .maybeSingle();
  if (error) return json(500, { error: "Could not load test payment." });
  if (!data) return json(404, { error: "Unknown test payment." });

  await refreshPaymentStatus(paymentId);
  return json(200, { status: "ok" });
}

async function getTestPaymentStatus(request: Request, origin: string) {
  const user = await authenticatedUser(request);
  if (!user) return json(401, { error: "Prihlásenie vypršalo. Prihláste sa znova." }, origin);
  const input = await request.json() as { orderNumber?: unknown };
  const orderNumber = typeof input.orderNumber === "string" ? input.orderNumber : "";
  if (!/^WK-[0-9a-f-]{36}$/i.test(orderNumber)) {
    return json(400, { error: "Neplatné číslo testovacej platby." }, origin);
  }

  const db = serviceClient();
  const { data: payment, error } = await db.from("gopay_test_payments")
    .select("company_id, gopay_payment_id, status")
    .eq("order_number", orderNumber)
    .eq("requested_by", user.id)
    .maybeSingle();
  if (error) return json(500, { error: "Stav testovacej platby sa nepodarilo načítať." }, origin);
  if (!payment || !await isActiveOwner(payment.company_id, user.id)) {
    return json(404, { error: "Testovacia platba sa nenašla." }, origin);
  }
  if (!payment.gopay_payment_id) {
    return json(200, { status: payment.status }, origin);
  }

  const status = await refreshPaymentStatus(payment.gopay_payment_id);
  return json(200, { status }, origin);
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin") ?? APP_ORIGIN;
  const allowedOrigins = new Set([
    APP_ORIGIN,
    "https://workena.eu",
    "https://www.workena.eu",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  if (request.headers.has("Origin") && !allowedOrigins.has(origin)) {
    return json(403, { error: "Origin is not allowed." });
  }
  if (request.method === "OPTIONS") return new Response("ok", { headers: {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  } });

  const url = new URL(request.url);
  if (url.searchParams.get("notification") === "1") {
    if (request.method !== "GET" && request.method !== "POST") {
      return json(405, { error: "Method not allowed." });
    }
    return await handleNotification(request);
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed." }, origin);

  let input: { action?: unknown };
  try {
    input = await request.clone().json() as { action?: unknown };
  } catch {
    return json(400, { error: "Neplatné JSON telo požiadavky." }, origin);
  }
  if (input?.action === "create") return await createTestPayment(request, origin);
  if (input?.action === "status") return await getTestPaymentStatus(request, origin);
  return json(400, { error: "Neznáma požiadavka na testovaciu GoPay platbu." }, origin);
});
