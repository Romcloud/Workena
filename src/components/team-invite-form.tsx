"use client";

import { useActionState } from "react";
import { createInvitation } from "@/app/actions";
import type { ActionState } from "@/app/actions";

export function TeamInviteForm({ canInviteManager }: { canInviteManager: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createInvitation, {});
  return (
    <form action={action} className="invite-form">
      <label className="field"><span>E-mailová adresa</span><input type="email" name="email" required placeholder="meno@vasafirma.sk" /></label>
      <label className="field"><span>Rola</span><select name="role"><option value="EMPLOYEE">Zamestnanec</option>{canInviteManager && <option value="MANAGER">Vedúci</option>}</select></label>
      <button className="button button-primary" disabled={pending}>{pending ? "Vytváram…" : "Vytvoriť pozvánku"}</button>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.inviteUrl && <p className="invite-success" role="status">Pozvánka je pripravená (platí 7 dní). Skopírujte odkaz a pošlite ho bezpečne: <a href={state.inviteUrl}>{state.inviteUrl}</a></p>}
    </form>
  );
}
