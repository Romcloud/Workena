import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

type PushJob = {
  job_id: number;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  kind: "ASSIGNMENT" | "REMINDER";
};

function validEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && (url.hostname === "fcm.googleapis.com"
      || url.hostname === "updates.push.services.mozilla.com"
      || /^[^.]+\.push\.apple\.com$/.test(url.hostname)
      || /^[^.]+\.notify\.windows\.com$/.test(url.hostname));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Nepodporovaná metóda." });
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const schedulerSecret = Deno.env.get("WORK_ORDER_PUSH_SCHEDULER_SECRET");
  if (!url || !anonKey || !serviceKey || !publicKey || !privateKey || !schedulerSecret) {
    console.error("Push notifications are not configured.");
    return json(503, { error: "Push notifikácie nie sú nakonfigurované." });
  }
  const authorization = request.headers.get("Authorization") ?? "";
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("action" in body)) return json(400, { error: "Chýba akcia." });
  if (body.action === "public-key") {
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data, error } = await userClient.auth.getUser();
    if (error || !data.user) return json(401, { error: "Prihláste sa." });
    return json(200, { publicKey });
  }
  if (body.action !== "dispatch" || authorization !== `Bearer ${schedulerSecret}`) {
    return json(403, { error: "Prístup odmietnutý." });
  }
  const admin = createClient(url, serviceKey);
  webpush.setVapidDetails("mailto:info@rovolt.sk", publicKey, privateKey);
  const { data, error } = await admin.rpc("claim_work_order_push_jobs");
  if (error) {
    console.error("Claiming push jobs failed:", error.message);
    return json(500, { error: "Notifikácie sa nepodarilo načítať." });
  }
  let failures = 0;
  const jobs = (data ?? []) as PushJob[];
  const deliver = async (job: PushJob) => {
    let status: "sent" | "expired" | "retry" = "sent";
    let message: string | null = null;
    try {
      if (!validEndpoint(job.endpoint)) throw new Error("Nepodporovaná adresa notifikačnej služby.");
      await webpush.sendNotification(
        { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth_key } },
        JSON.stringify({
          title: job.kind === "ASSIGNMENT" ? "Nová pridelená zákazka" : "Pripomienka zákazky",
          body: job.kind === "ASSIGNMENT" ? "Vo Workene máte novú pridelenú zákazku." : "Blíži sa termín vašej zákazky. Otvorte Workenu pre podrobnosti.",
        }),
        { TTL: 300, timeout: 10000 },
      );
    } catch (reason: unknown) {
      const code = typeof reason === "object" && reason !== null && "statusCode" in reason ? reason.statusCode : null;
      status = code === 404 || code === 410 ? "expired" : "retry";
      message = code == null ? "Chyba odosielania push notifikácie." : `Push služba odpovedala ${code}.`;
      if (status === "retry") {
        failures++;
        console.error("Push delivery failed:", code ?? message);
      }
    }
    const { error: finishError } = await admin.rpc("finish_work_order_push_job", {
      p_job_id: job.job_id, p_status: status, p_error: message,
    });
    if (finishError) {
      failures++;
      console.error("Updating push job failed:", finishError.message);
    }
  };
  for (let offset = 0; offset < jobs.length; offset += 10) {
    await Promise.all(jobs.slice(offset, offset + 10).map(deliver));
  }
  return json(failures ? 500 : 200, { processed: jobs.length, failures });
});
