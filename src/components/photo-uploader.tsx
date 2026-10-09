"use client";

import { useState } from "react";

export function PhotoUploader({ entryId }: { entryId: string }) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  async function upload(formData: FormData) {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setMessage("Vyberte fotografiu.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/entries/${entryId}/upload`, { method: "POST", body: formData });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setMessage(result.error ?? "Fotografiu sa nepodarilo nahrať.");
        return;
      }
      window.location.reload();
    } catch {
      setMessage("Fotografiu sa nepodarilo nahrať. Skúste to znova.");
    } finally {
      setPending(false);
    }
  }
  return <form action={upload} className="upload-row"><label className="button button-outline upload-label">Vybrať fotografiu<input type="file" name="file" accept="image/jpeg,image/png,image/webp" required /></label><button className="button button-primary" disabled={pending}>{pending ? "Nahrávam…" : "Nahrať"}</button>{message && <span className="upload-message" role="alert">{message}</span>}</form>;
}
