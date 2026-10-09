"use client";

import { useActionState } from "react";
import { acceptInvitation } from "@/app/actions";

export function AcceptInviteForm({ token, emailMatches }: { token: string; emailMatches: boolean }) {
  const action = async () => acceptInvitation(token);
  const [state, formAction, pending] = useActionState(action, {});
  return <form action={formAction} className="form-stack">{state.error && <p className="form-error" role="alert">{state.error}</p>}{!emailMatches && <p className="form-error" role="alert">Pozvánka patrí inej adrese. Odhláste sa a prihláste sa účtom uvedeným na pozvánke.</p>}<button className="button button-primary button-full" disabled={!emailMatches || pending}>{pending ? "Pripájam…" : "Prijať pozvánku"}</button></form>;
}
