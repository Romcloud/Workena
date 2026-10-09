"use client";

import { useActionState } from "react";
import { updateCompanySettings } from "@/app/actions";

export function CompanySettingsForm({
  name,
  emailDomain,
  enforceEmailDomain,
}: {
  name: string;
  emailDomain: string | null;
  enforceEmailDomain: boolean;
}) {
  const [state, action, pending] = useActionState(updateCompanySettings, {});
  return (
    <form action={action} className="form-stack">
      <label className="field"><span>Názov firmy</span><input name="name" required minLength={2} maxLength={120} defaultValue={name} /></label>
      <label className="field"><span>Firemná e-mailová doména</span><div className="input-prefix"><span>@</span><input name="emailDomain" defaultValue={emailDomain ?? ""} placeholder="vasafirma.sk" /></div></label>
      <label className="checkbox-line"><input type="checkbox" name="enforceEmailDomain" defaultChecked={enforceEmailDomain} /><span>Vyžadovať túto doménu pri nových pozvánkach</span></label>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.success && <p className="invite-success" role="status">{state.success}</p>}
      <button className="button button-outline" disabled={pending}>{pending ? "Ukladám…" : "Uložiť nastavenia firmy"}</button>
    </form>
  );
}
