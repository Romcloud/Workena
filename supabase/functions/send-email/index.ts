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

type EmailTemplate = "company_welcome" | "license_requested" | "payment_confirmed" | "payment_reminder";

type TemplateData = {
  companyName?: string;
  fullName?: string;
  planName?: string;
  amount?: string;
  variableSymbol?: string;
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

function renderEmail(template: EmailTemplate, data: TemplateData): { subject: string; html: string } {
  const companyName = data.companyName ?? "vaša firma";
  const fullName = data.fullName ?? "";
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

    const body = (await req.json()) as { template: EmailTemplate; to: string; data?: TemplateData };
    if (!body.template || !body.to) return json(400, { error: "Chýba šablóna alebo príjemca." });

    const adminOnlyTemplates: EmailTemplate[] = ["payment_confirmed", "payment_reminder"];
    if (adminOnlyTemplates.includes(body.template)) {
      const { data: isAdmin } = await userClient.rpc("is_platform_admin");
      if (!isAdmin) return json(403, { error: "Prístup odmietnutý." });
    } else if (body.to.toLowerCase() !== (userData.user.email ?? "").toLowerCase()) {
      return json(403, { error: "Prístup odmietnutý." });
    }

    if (!RESEND_API_KEY) return json(500, { error: "Emailová služba nie je nakonfigurovaná." });

    const { subject, html } = renderEmail(body.template, body.data ?? {});

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [body.to], subject, html }),
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
