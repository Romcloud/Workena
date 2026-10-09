import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
let validUrl = false;

if (url) {
  try {
    const parsedUrl = new URL(url);
    validUrl =
      (parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:") &&
      parsedUrl.hostname.includes(".");
  } catch {
    validUrl = false;
  }
}

export const supabase =
  url && anonKey && validUrl
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

export const supabaseConfigurationError =
  url && !validUrl
    ? "VITE_SUPABASE_URL nie je platná URL. V GitHub Actions Variables nastavte napr. https://qutvxysezkyawwevxaxe.supabase.co a znovu spustite nasadenie."
    : !url || !anonKey
      ? "Doplňte VITE_SUPABASE_URL a VITE_SUPABASE_ANON_KEY v GitHub Actions Variables a znovu spustite nasadenie."
      : null;
