import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

type Props = { client: SupabaseClient; userId: string };
type Settings = { assignment_enabled: boolean; reminder_enabled: boolean };

function failureMessage(reason: unknown) {
  if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string") return reason.message;
  return "Notifikácie sa nepodarilo nastaviť.";
}

function applicationKey(value: string) {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function removeDevicePushSubscription(client: SupabaseClient) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const { error } = await client.rpc("remove_push_subscription", { p_endpoint: subscription.endpoint });
  if (error) throw error;
  if (!await subscription.unsubscribe()) throw new Error("Odber notifikácií sa nepodarilo vypnúť na tomto zariadení.");
}

export function PushNotificationSettings({ client, userId }: Props) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
  const [assignment, setAssignment] = useState(false);
  const [reminder, setReminder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [deviceSubscription, setDeviceSubscription] = useState<PushSubscription | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setAssignment(false);
    setReminder(false);
    setError("");
    setPublicKey("");
    setRegistration(null);
    setDeviceSubscription(null);
    const load = async () => {
      try {
        if (!supported) return;
        const worker = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        const subscription = await worker.pushManager.getSubscription();
        if (subscription) {
          const { data, error: queryError } = await client.from("push_subscriptions")
            .select("assignment_enabled, reminder_enabled").eq("endpoint", subscription.endpoint).maybeSingle();
          if (queryError) throw queryError;
          if (active && data) {
            const settings: Settings = data;
            setAssignment(settings.assignment_enabled);
            setReminder(settings.reminder_enabled);
          }
        }
        const { data, error: keyError } = await client.functions.invoke<{ publicKey: string }>("work-order-push", {
          body: { action: "public-key" },
        });
        if (keyError) throw keyError;
        if (!data?.publicKey) throw new Error("Server neposkytol kľúč pre notifikácie.");
        if (active) {
          setRegistration(worker);
          setDeviceSubscription(subscription ?? null);
          setPublicKey(data.publicKey);
        }
      } catch (reason: unknown) {
        if (active) setError(failureMessage(reason));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [client, supported, userId]);

  const save = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      if (!assignment && !reminder) {
        await removeDevicePushSubscription(client);
        setDeviceSubscription(null);
        setMessage("Notifikácie na tomto zariadení sú vypnuté.");
        return;
      }
      if (!registration || !publicKey) throw new Error("Služba notifikácií nie je pripravená. Obnovte stránku a skúste znova.");
      if (Notification.permission === "denied") throw new Error("Notifikácie nie sú povolené v prehliadači alebo v nastaveniach zariadenia.");
      let subscription = deviceSubscription;
      let created = false;
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(publicKey) });
        created = true;
      }
      const keys = subscription.toJSON().keys;
      if (!keys?.p256dh || !keys.auth) throw new Error("Prehliadač neposkytol platné údaje pre notifikácie.");
      const { error: saveError } = await client.rpc("save_push_subscription", {
        p_endpoint: subscription.endpoint, p_p256dh: keys.p256dh, p_auth_key: keys.auth,
        p_assignment_enabled: assignment, p_reminder_enabled: reminder,
      });
      if (saveError) {
        if (created) await subscription.unsubscribe();
        throw saveError;
      }
      setDeviceSubscription(subscription);
      setMessage("Notifikácie na tomto zariadení sú uložené.");
    } catch (reason: unknown) {
      setError(failureMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  return <section className="panel form-panel form-stack">
    <div><h2>Notifikácie zákaziek</h2><p className="muted">Nastavenie platí pre toto zariadenie a prehliadač. Na iPhone alebo iPade pridajte Workenu na plochu a otvorte ju odtiaľ.</p></div>
    {!supported ? <p className="form-error">Tento prehliadač nepodporuje push notifikácie alebo stránka nie je zabezpečená.</p> : <>
      <label><input type="checkbox" checked={assignment} disabled={loading} onChange={(event) => setAssignment(event.target.checked)} /> Upozorniť pri priradení zákazky</label>
      <label><input type="checkbox" checked={reminder} disabled={loading} onChange={(event) => setReminder(event.target.checked)} /> Pripomenúť zákazku hodinu pred začiatkom</label>
      <p className="muted">Pri zákazke bez určeného času príde upozornenie v deň zákazky o 8:00. Upozornenia môžu prísť aj pri zatvorenej Workene.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="invite-success" role="status">{message}</p>}
      <div className="form-actions"><button type="button" className="button button-primary" disabled={loading} onClick={() => void save()}>{loading ? "Načítavam…" : "Uložiť notifikácie"}</button></div>
    </>}
  </section>;
}
