"use client";

import { useActionState } from "react";
import { createCompany } from "@/app/actions";

export function CompanyForm() {
  const [state, action, pending] = useActionState(createCompany, {});
  return (
    <form action={action} className="form-stack">
      <label className="field"><span>Názov firmy</span><input name="name" required minLength={2} maxLength={120} placeholder="napr. Stavmont s.r.o." /></label>
      <label className="field"><span>Firemná e-mailová doména <small>voliteľné</small></span><div className="input-prefix"><span>@</span><input name="emailDomain" placeholder="vasafirma.sk" /></div></label>
      <label className="checkbox-line"><input type="checkbox" name="enforceEmailDomain" /><span>Vyžadovať túto doménu pri pozývaní členov</span></label>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <button className="button button-primary button-full" disabled={pending}>{pending ? "Vytváram priestor…" : "Vytvoriť firemný priestor"}</button>
    </form>
  );
}
