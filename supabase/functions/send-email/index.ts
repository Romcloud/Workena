// Supabase Edge Function: sends transactional emails from info@rovolt.sk via Resend.
// Deploy with: supabase functions deploy send-email
// Requires secret: supabase secrets set RESEND_API_KEY=...
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Workena <info@rovolt.sk>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EmailTemplate = "company_welcome" | "company_join_request" | "license_requested" | "payment_confirmed" | "payment_reminder" | "admin_custom" | "maintenance_notice";

type TemplateData = {
  companyName?: string;
  fullName?: string;
  planName?: string;
  amount?: string;
  variableSymbol?: string;
  subject?: string;
  message?: string;
  startsAt?: string;
  endsAt?: string;
  reason?: string;
  requestId?: string;
  requesterName?: string;
  requesterEmail?: string;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function layout(title: string, bodyHtml: string) {
  return `<!doctype html>
<html lang="sk">
  <body style="font-family: Arial, Helvetica, sans-serif; background:#f6f7fb; padding:24px; color:#1f2430;">
    <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:12px; padding:32px; border:1px solid #e7e9f2;">
      <h1 style="font-size:20px; margin:0 0 16px;">${title}</h1>
      ${bodyHtml}
      <p style="margin-top:32px; font-size:13px; color:#6b7280;">Tím Workena<br/>info@rovolt.sk</p>
    </div>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function renderEmail(template: EmailTemplate, data: TemplateData): { subject: string; html: string } {
  const companyName = escapeHtml(data.companyName ?? "vaša firma");
  const fullName = escapeHtml(data.fullName ?? "");
  const greeting = fullName ? `Dobrý deň, ${fullName},` : "Dobrý deň,";

  switch (template) {
    case "company_welcome":
      return {
        subject: "Vitajte vo Workena",
        html: layout("Ďakujeme za registráciu", `
          <p>${greeting}</p>
          <p>ďakujeme, že ste si vo Workena založili firemný priestor <strong>${companyName}</strong>. Môžete teraz pozývať kolegov, zadávať zákazky a sledovať dochádzku na jednom mieste.</p>
          <p>Ak budete potrebovať pomôcť, stačí odpovedať na tento email.</p>
        `),
      };
    case "company_join_request":
      return {
        subject: `Žiadosť o vstup do firmy ${data.companyName ?? "vo Workena"}`,
        html: layout("Žiadosť o vstup do firmy", `
          <p>Dobrý deň,</p>
          <p>Používateľ <strong>${escapeHtml(data.requesterName ?? "Používateľ")}</strong> (${escapeHtml(data.requesterEmail ?? "")}) požiadal o prístup do firmy <strong>${companyName}</strong>.</p>
          <p>Žiadosť môžete prijať alebo odstrániť v časti Tím vo Workena.</p>
        `),
      };
    case "license_requested":
      return {
        subject: "Prijali sme vašu žiadosť o licenciu",
        html: layout("Ďakujeme za žiadosť o licenciu", `
          <p>${greeting}</p>
          <p>zaevidovali sme vašu žiadosť o licenciu <strong>${data.planName ?? ""}</strong> pre firmu <strong>${companyName}</strong>.</p>
          <p>Suma na úhradu: <strong>${data.amount ?? ""} €</strong><br/>Variabilný symbol: <strong>${data.variableSymbol ?? ""}</strong></p>
          <p>Po prijatí platby vám licenciu aktivujeme a pošleme potvrdenie.</p>
        `),
      };
    case "payment_confirmed":
      return {
        subject: "Platba prijatá – licencia je aktívna",
        html: layout("Ďakujeme za platbu", `
          <p>${greeting}</p>
          <p>potvrdzujeme prijatie platby za licenciu <strong>${data.planName ?? ""}</strong> pre firmu <strong>${companyName}</strong>. Licencia je od teraz aktívna.</p>
          <p>Ďakujeme, že používate Workena.</p>
        `),
      };
    case "payment_reminder":
      return {
        subject: "Pripomienka k úhrade licencie",
        html: layout("Pripomienka k úhrade", `
          <p>${greeting}</p>
          <p>evidujeme nedokončenú platbu za licenciu <strong>${data.planName ?? ""}</strong> pre firmu <strong>${companyName}</strong>.</p>
          <p>Suma na úhradu: <strong>${data.amount ?? ""} €</strong><br/>Variabilný symbol: <strong>${data.variableSymbol ?? ""}</strong></p>
          <p>Ak ste platbu už vykonali, tento email prosím ignorujte.</p>
        `),
      };
    case "admin_custom":
      return {
        subject: data.subject ?? "Správa z Workena",
        html: layout(data.subject ?? "Správa z Workena", `
          <p>${greeting}</p>
          <p>${(data.message ?? "").replace(/\n/g, "<br/>")}</p>
        `),
      };
    case "maintenance_notice":
      return {
        subject: "Plánovaná odstávka Workena",
        html: layout("Plánovaná odstávka", `
          <p>${greeting}</p>
          <p>upozorňujeme na plánovanú odstávku aplikácie Workena kvôli aktualizáciám a opravám.</p>
          <p>Od: <strong>${data.startsAt ?? ""}</strong><br/>Do: <strong>${data.endsAt ?? ""}</strong></p>
          ${data.reason ? `<p>${data.reason}</p>` : ""}
          <p>Počas tohto obdobia nemusí byť aplikácia dostupná. Ďakujeme za pochopenie.</p>
        `),
      };
    default:
      throw new Error("Neznáma šablóna emailu.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Chýba autorizácia." });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return json(401, { error: "Neplatné prihlásenie." });

    const body = (await req.json()) as { template: EmailTemplate; to?: string; data?: TemplateData };
    if (!body.template) return json(400, { error: "Chýba šablóna emailu." });

    const adminOnlyTemplates: EmailTemplate[] = ["payment_confirmed", "payment_reminder", "admin_custom", "maintenance_notice"];
    let recipients: string[];
    let templateData = body.data ?? {};
    if (adminOnlyTemplates.includes(body.template)) {
      const { data: isAdmin } = await userClient.rpc("is_platform_admin");
      if (!isAdmin) return json(403, { error: "Prístup odmietnutý." });
      if (!body.to) return json(400, { error: "Chýba príjemca." });
      recipients = [body.to];
    } else if (body.template === "company_join_request") {
      if (!body.data?.requestId) return json(400, { error: "Chýba identifikátor žiadosti." });
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!serviceRoleKey) return json(500, { error: "Serverová databázová služba nie je nakonfigurovaná." });
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: request, error: requestError } = await adminClient
        .from("company_join_requests")
        .select("company_id, email, full_name")
        .eq("id", body.data.requestId)
        .eq("user_id", userData.user.id)
        .eq("status", "PENDING")
        .maybeSingle();
      if (requestError || !request) return json(403, { error: requestError?.message ?? "Žiadosť o vstup sa nenašla." });
      const [{ data: company, error: companyError }, { data: managers, error: managersError }] = await Promise.all([
        adminClient.from("companies").select("name").eq("id", request.company_id).maybeSingle(),
        adminClient.from("memberships").select("email").eq("company_id", request.company_id).eq("active", true).in("role", ["OWNER", "MANAGER"]),
      ]);
      if (companyError || managersError) return json(500, { error: companyError?.message ?? managersError?.message ?? "Podrobnosti firmy sa nepodarilo načítať." });
      recipients = (managers ?? []).map((manager) => manager.email).filter((email): email is string => Boolean(email));
      if (!recipients.length) return json(400, { error: "Vedenie firmy nemá nastavenú e-mailovú adresu." });
      templateData = {
        companyName: company?.name,
        requesterName: request.full_name ?? request.email,
        requesterEmail: request.email,
      };
    } else if (!body.to || body.to.toLowerCase() !== (userData.user.email ?? "").toLowerCase()) {
      return json(403, { error: "Prístup odmietnutý." });
    } else {
      recipients = [body.to];
    }

    if (!RESEND_API_KEY) return json(500, { error: "Emailová služba nie je nakonfigurovaná." });

    const { subject, html } = renderEmail(body.template, templateData);

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: recipients, subject, html }),
    });

    if (!resendResponse.ok) {
      const errText = await resendResponse.text();
      return json(502, { error: `Email sa nepodarilo odoslať: ${errText}` });
    }

    return json(200, { ok: true });
  } catch (reason) {
    return json(500, { error: String(reason instanceof Error ? reason.message : reason) });
  }
});
