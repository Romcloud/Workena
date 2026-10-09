"use client";

import { useActionState } from "react";
import { createWorkEntry, updateWorkEntry, type ActionState } from "@/app/actions";

type Values = { workedAt: Date; hours: number; workType: string; workplace: string; note?: string | null };

function dateTimeLocal(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function EntryForm({ entry }: { entry?: Values & { id: string } }) {
  const serverAction = entry ? updateWorkEntry.bind(null, entry.id) : createWorkEntry;
  const [state, formAction, pending] = useActionState(async (previous: ActionState, formData: FormData) => {
    const workedAt = formData.get("workedAt");
    if (typeof workedAt === "string") {
      const date = new Date(workedAt);
      if (!Number.isNaN(date.getTime())) formData.set("workedAt", date.toISOString());
    }
    return serverAction(previous, formData);
  }, {});
  return (
    <form action={formAction} className="form-stack entry-form">
      <div className="form-grid">
        <label className="field"><span>Dátum a čas práce</span><input type="datetime-local" name="workedAt" defaultValue={dateTimeLocal(entry?.workedAt ?? new Date())} required /></label>
        <label className="field"><span>Odpracované hodiny</span><input type="number" name="hours" min="0.25" max="24" step="0.25" defaultValue={entry?.hours ?? ""} placeholder="napr. 7,5" required /></label>
        <label className="field"><span>Druh práce</span><input name="workType" maxLength={120} defaultValue={entry?.workType} placeholder="napr. Montáž, servis…" required /></label>
        <label className="field"><span>Miesto / pracovisko</span><input name="workplace" maxLength={120} defaultValue={entry?.workplace} placeholder="napr. Bratislava — Ružinov" required /></label>
      </div>
      <label className="field"><span>Poznámka <small>voliteľné</small></span><textarea name="note" rows={4} maxLength={2000} defaultValue={entry?.note ?? ""} placeholder="Doplňujúce informácie k práci…" /></label>
      <div className="photo-hint"><span className="photo-hint-icon">＋</span><span><strong>Fotografie k záznamu</strong><small>Po uložení môžete pridať fotky vo formáte JPG, PNG alebo WebP (max. 8 MB).</small></span></div>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="form-actions"><a href="/dashboard" className="button button-quiet">Zrušiť</a><button className="button button-primary" disabled={pending}>{pending ? "Ukladám…" : entry ? "Uložiť zmeny" : "Uložiť záznam"}</button></div>
    </form>
  );
}
