import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  Clock3,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Download,
  History,
  LayoutDashboard,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Printer,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigurationError } from "./lib/supabase";
import type { Company, EntryStatus, Membership, Photo, Role, WorkEntry } from "./lib/types";

type WorkspaceMembership = Membership & { company: Company };
type Page = "dashboard" | "entry" | "team" | "history";
type PhotoView = Photo & { url: string };

const PHOTO_BUCKET = "work-photos";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 10;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Požiadavku sa nepodarilo dokončiť. Skúste to znova.";
}

function initials(name: string) {
  return name.trim().slice(0, 1).toLocaleUpperCase("sk");
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function localDateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function hoursLabel(value: number) {
  return new Intl.NumberFormat("sk-SK", { maximumFractionDigits: 2 }).format(Number(value));
}

function dateTimeLocal(value?: string) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function roleName(role: Role) {
  return role === "OWNER" ? "Vlastník" : role === "MANAGER" ? "Vedúci" : "Zamestnanec";
}

function statusName(status: EntryStatus) {
  return status === "APPROVED" ? "Schválené" : status === "REJECTED" ? "Vrátené" : "Čaká na kontrolu";
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [entries, setEntries] = useState<WorkEntry[]>([]);
  const [roster, setRoster] = useState<Membership[]>([]);
  const [page, setPage] = useState<Page>("dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<WorkEntry | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<File[]>([]);
  const [historyMonth, setHistoryMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const activeMembership = memberships.find((membership) => membership.company_id === companyId) ?? memberships[0];
  const activeCompanyId = activeMembership?.company_id ?? "";
  const isManager = activeMembership?.role === "OWNER" || activeMembership?.role === "MANAGER";
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const profileName =
    session?.user.user_metadata.full_name ??
    session?.user.user_metadata.name ??
    session?.user.email?.split("@")[0] ??
    "Používateľ";
  const client = supabase;

  useEffect(() => {
    if (!client) {
      setAuthReady(true);
      return;
    }

    let alive = true;
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setMemberships([]);
      setCompanyId("");
      setEntries([]);
      setRoster([]);
      setSelectedId(null);
      setPage("dashboard");
    });
    void client.auth.getSession().then(({ data: sessionData, error: sessionError }) => {
      if (!alive) return;
      if (sessionError) setError(sessionError.message);
      setSession(sessionData.session);
      setAuthReady(true);
    });

    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!client || !session) {
      setMemberships([]);
      return;
    }

    let alive = true;
    void (async () => {
      const { data: memberRows, error: memberError } = await client
        .from("memberships")
        .select("id, company_id, user_id, email, full_name, role, active, deactivated_at")
        .eq("user_id", session.user.id);
      if (!alive) return;
      if (memberError) {
        setError(memberError.message);
        return;
      }
      const memberList = (memberRows ?? []) as Membership[];
      if (memberList.length === 0) {
        setMemberships([]);
        return;
      }
      const { data: companyRows, error: companyError } = await client
        .from("companies")
        .select("id, name, plan")
        .in("id", memberList.map((member) => member.company_id));
      if (!alive) return;
      if (companyError) {
        setError(companyError.message);
        return;
      }
      const companies = (companyRows ?? []) as Company[];
      const companyById = new Map(companies.map((company) => [company.id, company]));
      const workspaces = memberList.flatMap((membership) => {
        const company = companyById.get(membership.company_id);
        return company ? [{ ...membership, company }] : [];
      });
      setMemberships(workspaces);
      setCompanyId((current) =>
        workspaces.some((membership) => membership.company_id === current)
          ? current
          : workspaces[0]?.company_id ?? "",
      );
    })();

    return () => {
      alive = false;
    };
  }, [client, session]);

  const refreshWorkspace = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const [{ data: entryRows, error: entryError }, { data: memberRows, error: memberError }] = await Promise.all([
      client
        .from("work_entries")
        .select("*")
        .eq("company_id", activeCompanyId)
        .order("worked_at", { ascending: false }),
      client
        .from("memberships")
        .select("id, company_id, user_id, email, full_name, role, active, deactivated_at")
        .eq("company_id", activeCompanyId)
        .order("created_at"),
    ]);
    if (entryError) {
      setError(entryError.message);
      return;
    }
    if (memberError) {
      setError(memberError.message);
      return;
    }
    setEntries((entryRows ?? []) as WorkEntry[]);
    setRoster((memberRows ?? []) as Membership[]);
  }, [activeCompanyId, client]);

  useEffect(() => {
    if (!client || !activeCompanyId) {
      setEntries([]);
      setRoster([]);
      return;
    }
    let alive = true;
    void refreshWorkspace().catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });
    return () => {
      alive = false;
    };
  }, [activeCompanyId, client, refreshWorkspace]);

  const loadPhotos = useCallback(
    async (entryId: string) => {
      if (!client) return;
      const { data, error: photoError } = await client
        .from("photos")
        .select("*")
        .eq("work_entry_id", entryId)
        .order("created_at");
      if (photoError) throw photoError;
      const photoRows = (data ?? []) as Photo[];
      const views = await Promise.all(
        photoRows.map(async (photo) => {
          const { data: signed, error: signedError } = await client.storage
            .from(PHOTO_BUCKET)
            .createSignedUrl(photo.storage_path, 60 * 60);
          if (signedError) throw signedError;
          return { ...photo, url: signed.signedUrl };
        }),
      );
      setPhotos(views);
    },
    [client],
  );

  useEffect(() => {
    if (!selectedId) {
      setPhotos([]);
      return;
    }
    let alive = true;
    void loadPhotos(selectedId).catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });
    return () => {
      alive = false;
    };
  }, [loadPhotos, selectedId]);

  const signIn = async () => {
    if (!client) return;
    setBusy(true);
    setError("");
    const { error: signInError } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (signInError) {
      setError(signInError.message);
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!client) return;
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) setError(signOutError.message);
  };

  const createCompany = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    const { error: createError } = await client.rpc("create_company", { p_name: String(form.get("name") ?? "") });
    if (createError) setError(createError.message);
    else {
      const { data: refreshed, error: refreshError } = await client
        .from("memberships")
        .select("id, company_id, user_id, email, full_name, role, active, deactivated_at")
        .eq("user_id", session?.user.id ?? "");
      if (refreshError) setError(refreshError.message);
      else {
        const memberRows = (refreshed ?? []) as Membership[];
        const { data: companyRows, error: companyError } = await client
          .from("companies")
          .select("id, name, plan")
          .in("id", memberRows.map((membership) => membership.company_id));
        if (companyError) setError(companyError.message);
        else {
          const companyById = new Map(((companyRows ?? []) as Company[]).map((company) => [company.id, company]));
          const workspaces = memberRows.flatMap((membership) => {
            const company = companyById.get(membership.company_id);
            return company ? [{ ...membership, company }] : [];
          });
          setMemberships(workspaces);
          setCompanyId(workspaces[workspaces.length - 1]?.company_id ?? "");
          setNotice("Firemný priestor je pripravený.");
        }
      }
    }
    setBusy(false);
  };

  const saveEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeMembership || !session) return;
    const form = new FormData(event.currentTarget);
    const values = {
      company_id: activeMembership.company_id,
      user_id: session.user.id,
      worked_at: new Date(String(form.get("worked_at"))).toISOString(),
      hours: Number(form.get("hours")),
      work_type: String(form.get("work_type")).trim(),
      workplace: String(form.get("workplace")).trim(),
      note: String(form.get("note") ?? "").trim() || null,
    };
    if (!Number.isFinite(values.hours) || values.hours <= 0 || values.hours > 24) {
      setError("Zadajte počet hodín od 0,25 do 24.");
      return;
    }
    setBusy(true);
    setError("");
    let entryId = editingEntry?.id ?? "";
    let saveError: string | null = null;
    if (editingEntry) {
      const { error: updateError } = await client
        .from("work_entries")
        .update(values)
        .eq("id", editingEntry.id)
        .eq("company_id", activeCompanyId);
      if (updateError) saveError = updateError.message;
    } else {
      const { data, error: insertError } = await client
        .from("work_entries")
        .insert(values)
        .select("id")
        .single();
      if (insertError) saveError = insertError.message;
      else entryId = data.id;
    }
    if (saveError) setError(saveError);
    else {
      if (editingEntry?.status === "REJECTED") {
        const { error: resubmitError } = await client.rpc("resubmit_work_entry", { p_entry_id: editingEntry.id });
        if (resubmitError) {
          setError(resubmitError.message);
          setBusy(false);
          return;
        }
      }
      const photosError = pendingPhotos.length ? await uploadFilesToEntry(entryId, pendingPhotos) : null;
      await refreshWorkspace();
      setEditingEntry(null);
      setPendingPhotos([]);
      setPage("dashboard");
      if (photosError) {
        setError(`Záznam bol uložený, no fotografie sa nepodarilo úplne pridať: ${photosError}`);
      } else {
        setNotice(editingEntry ? "Záznam bol upravený." : "Záznam bol uložený.");
      }
    }
    setBusy(false);
  };

  const changeReview = async (entry: WorkEntry, status: "APPROVED" | "REJECTED") => {
    if (!client) return;
    const reviewNote = status === "REJECTED" ? window.prompt("Dôvod vrátenia (voliteľné):") : null;
    if (status === "REJECTED" && reviewNote === null) return;
    setBusy(true);
    setError("");
    const { error: reviewError } = await client.rpc("review_work_entry", {
      p_entry_id: entry.id,
      p_status: status,
      p_review_note: reviewNote,
    });
    if (reviewError) setError(reviewError.message);
    else {
      await refreshWorkspace();
      setNotice(status === "APPROVED" ? "Záznam bol schválený." : "Záznam bol vrátený na opravu.");
    }
    setBusy(false);
  };

  const removeEntry = async (entry: WorkEntry) => {
    if (!client || !window.confirm("Naozaj chcete odstrániť tento pracovný záznam a jeho fotografie?")) return;
    setBusy(true);
    setError("");
    const { data: rows, error: photosError } = await client
      .from("photos")
      .select("storage_path")
      .eq("work_entry_id", entry.id);
    if (photosError) {
      setError(photosError.message);
      setBusy(false);
      return;
    }
    const paths = ((rows ?? []) as Pick<Photo, "storage_path">[]).map((photo) => photo.storage_path);
    if (paths.length) {
      const { error: storageError } = await client.storage.from(PHOTO_BUCKET).remove(paths);
      if (storageError) {
        setError(storageError.message);
        setBusy(false);
        return;
      }
    }
    const { error: deleteError } = await client.from("work_entries").delete().eq("id", entry.id);
    if (deleteError) setError(deleteError.message);
    else {
      setSelectedId(null);
      await refreshWorkspace();
      setNotice("Záznam a fotografie boli odstránené.");
    }
    setBusy(false);
  };

  const validatePhotoFiles = (files: File[]) => {
    for (const file of files) {
      if (!PHOTO_TYPES.includes(file.type) || file.size > MAX_PHOTO_BYTES) {
        return "Povolené sú JPG, PNG alebo WebP do veľkosti 8 MB.";
      }
    }
    return null;
  };

  const choosePhotos = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    const validationError = validatePhotoFiles(files);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (pendingPhotos.length + files.length > MAX_PHOTOS) {
      setError(`K jednému záznamu môžete pridať najviac ${MAX_PHOTOS} fotografií.`);
      return;
    }
    setError("");
    setPendingPhotos((current) => [...current, ...files]);
  };

  async function uploadFilesToEntry(entryId: string, files: File[]) {
    if (!client || !activeMembership) return "Firemný priestor nie je dostupný.";
    const { count, error: countError } = await client
      .from("photos")
      .select("id", { count: "exact", head: true })
      .eq("work_entry_id", entryId);
    if (countError) return countError.message;
    if ((count ?? 0) + files.length > MAX_PHOTOS) {
      return `K jednému záznamu môžete pridať najviac ${MAX_PHOTOS} fotografií.`;
    }

    for (const file of files) {
      const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
      const path = `${activeMembership.company_id}/${entryId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await client.storage.from(PHOTO_BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadError) return uploadError.message;
      const { error: metadataError } = await client.from("photos").insert({
        company_id: activeMembership.company_id,
        work_entry_id: entryId,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      });
      if (metadataError) {
        const { error: cleanupError } = await client.storage.from(PHOTO_BUCKET).remove([path]);
        return cleanupError
          ? `${metadataError.message} Súbor sa nepodarilo vyčistiť z úložiska: ${cleanupError.message}`
          : metadataError.message;
      }
    }
    return null;
  }

  const uploadPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!client || !selectedEntry || files.length === 0) return;
    const validationError = validatePhotoFiles(files);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError("");
    const uploadError = await uploadFilesToEntry(selectedEntry.id, files);
    if (uploadError) setError(uploadError);
    await loadPhotos(selectedEntry.id).catch((reason: unknown) => setError(errorText(reason)));
    setBusy(false);
  };

  const downloadPhoto = async (photo: PhotoView) => {
    if (!client) return;
    setBusy(true);
    setError("");
    const { data, error: downloadError } = await client.storage.from(PHOTO_BUCKET).download(photo.storage_path);
    if (downloadError) {
      setError(downloadError.message);
      setBusy(false);
      return;
    }
    const objectUrl = URL.createObjectURL(data);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = photo.file_name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setBusy(false);
  };

  const removePhoto = async (photo: PhotoView) => {
    if (!client || !window.confirm(`Odstrániť fotografiu „${photo.file_name}“?`)) return;
    setBusy(true);
    setError("");
    const { error: storageError } = await client.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);
    if (storageError) {
      setError(storageError.message);
      setBusy(false);
      return;
    }
    const { error: metadataError } = await client.from("photos").delete().eq("id", photo.id);
    if (metadataError) setError(metadataError.message);
    else await loadPhotos(photo.work_entry_id).catch((reason: unknown) => setError(errorText(reason)));
    setBusy(false);
  };

  const addMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    const { error: addError } = await client.rpc("add_company_member", {
      p_company_id: activeCompanyId,
      p_email: String(form.get("email") ?? ""),
      p_role: String(form.get("role") ?? "EMPLOYEE"),
    });
    if (addError) setError(addError.message);
    else {
      formElement.reset();
      await refreshWorkspace();
      setNotice("Člen bol pridaný do firemného priestoru.");
    }
    setBusy(false);
  };

  const removeMember = async (membership: Membership) => {
    if (!client || !window.confirm(`Odobrať ${membership.email} prístup do firmy? Jeho pracovná história zostane dostupná vedúcemu.`)) return;
    setBusy(true);
    setError("");
    const { error: removeError } = await client.rpc("remove_company_member", {
      p_membership_id: membership.id,
    });
    if (removeError) setError(removeError.message);
    else await refreshWorkspace();
    setBusy(false);
  };

  const monthlyEntries = useMemo(() => {
    const now = new Date();
    return entries
      .filter((entry) => {
        const date = new Date(entry.worked_at);
        return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()
          && (isManager || entry.user_id === session?.user.id);
      });
  }, [entries, isManager, session?.user.id]);
  const monthHours = useMemo(
    () => monthlyEntries.reduce((sum, entry) => sum + Number(entry.hours), 0),
    [monthlyEntries],
  );
  const visibleEntries = useMemo(
    () => isManager ? entries : entries.filter((entry) => entry.user_id === session?.user.id),
    [entries, isManager, session?.user.id],
  );
  const employeeMonthSummary = useMemo(() => {
    const totalsByUser = new Map<string, { hours: number; entries: number }>();
    for (const entry of monthlyEntries) {
      const total = totalsByUser.get(entry.user_id) ?? { hours: 0, entries: 0 };
      total.hours += Number(entry.hours);
      total.entries += 1;
      totalsByUser.set(entry.user_id, total);
    }
    return roster
      .filter((member) => member.role === "EMPLOYEE")
      .map((member) => {
        const total = totalsByUser.get(member.user_id) ?? { hours: 0, entries: 0 };
        return { member, hours: total.hours, entryCount: total.entries };
      })
      .filter(({ member, entryCount }) => member.active || entryCount > 0)
      .sort(
        (a, b) =>
          b.hours - a.hours ||
          (a.member.full_name ?? a.member.email).localeCompare(b.member.full_name ?? b.member.email, "sk"),
      );
  }, [monthlyEntries, roster]);
  const historyEntries = useMemo(
    () => entries.filter((entry) => localDateKey(entry.worked_at).slice(0, 7) === historyMonth),
    [entries, historyMonth],
  );
  const historyEmployeeSummary = useMemo(() => {
    const totalsByUser = new Map<string, { hours: number; entries: number }>();
    for (const entry of historyEntries) {
      const total = totalsByUser.get(entry.user_id) ?? { hours: 0, entries: 0 };
      total.hours += Number(entry.hours);
      total.entries += 1;
      totalsByUser.set(entry.user_id, total);
    }
    return roster
      .filter((member) => member.role === "EMPLOYEE")
      .map((member) => {
        const total = totalsByUser.get(member.user_id) ?? { hours: 0, entries: 0 };
        return { member, hours: total.hours, entryCount: total.entries };
      })
      .filter(({ member, entryCount }) => member.active || entryCount > 0)
      .sort(
        (a, b) =>
          b.hours - a.hours ||
          (a.member.full_name ?? a.member.email).localeCompare(b.member.full_name ?? b.member.email, "sk"),
      );
  }, [historyEntries, roster]);
  const historyMonthOptions = useMemo(() => {
    const months = new Set([localDateKey(new Date().toISOString()).slice(0, 7)]);
    for (const entry of entries) months.add(localDateKey(entry.worked_at).slice(0, 7));
    return [...months].sort((a, b) => b.localeCompare(a));
  }, [entries]);
  const historyMonthLabel = new Intl.DateTimeFormat("sk-SK", { month: "long", year: "numeric" })
    .format(new Date(`${historyMonth}-15T12:00:00`));
  const reportMonth = new Intl.DateTimeFormat("sk-SK", { month: "long", year: "numeric" }).format(new Date());
  const printMonthlyReport = () => {
    const previousTitle = document.title;
    document.title = `${activeMembership?.company.name ?? "Workena"} - ${reportMonth}`;
    window.addEventListener("afterprint", () => {
      document.title = previousTitle;
    }, { once: true });
    window.print();
  };

  if (!client) {
    return (
      <main className="center-page">
        <section className="center-card">
          <Brand />
          <span className="eyebrow">Chýba konfigurácia</span>
          <h1>Prepojte Supabase projekt</h1>
          <p className="muted">{supabaseConfigurationError}</p>
        </section>
      </main>
    );
  }

  if (!authReady) {
    return <main className="center-page"><div className="loading-card"><span /><span /></div></main>;
  }

  if (!session) {
    return (
      <main className="landing">
        <nav className="landing-nav">
          <Brand />
          <button className="button button-outline" onClick={() => void signIn()} disabled={busy}>Prihlásiť sa</button>
        </nav>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow"><span className="eyebrow-dot" /> Poriadok v pracovnom dni</span>
            <h1>Odpracované.<br /><span>Bez zbytočného papiera.</span></h1>
            <p>Jednoduchá evidencia práce pre ľudí v teréne aj celý tím v kancelárii. Záznamy, hodiny a fotografie na jednom bezpečnom mieste.</p>
            <button className="button button-primary button-large" onClick={() => void signIn()} disabled={busy}>
              Pokračovať cez Google <ArrowRight size={18} />
            </button>
            <div className="trust-note"><ShieldCheck size={16} /> Súkromné priestory pre každú firmu</div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="hero-visual" aria-label="Ukážka prehľadu odpracovaných hodín">
            <div className="visual-orb orb-one" /><div className="visual-orb orb-two" />
            <div className="preview-card">
              <div className="preview-heading"><div><span className="muted-label">TÝŽDENNÝ PREHĽAD</span><h2>Tento týždeň</h2></div><span className="avatar avatar-green">WK</span></div>
              <div className="hours-total"><strong>32,5</strong><span>hodín celkom</span><div className="progress"><i /></div></div>
              <div className="preview-days">{[5, 7, 6, 8, 6.5].map((hours, index) => <div className="day-column" key={index}><span className="day-bar" style={{ height: `${hours * 8}px` }} /><span>{["Po", "Ut", "St", "Št", "Pi"][index]}</span></div>)}</div>
              <div className="preview-entry"><span className="entry-icon"><Clock3 size={17} /></span><div><strong>Montáž rozvodov</strong><small>Bratislava · dnes</small></div><span className="entry-hours">6,5 h</span></div>
            </div>
            <div className="floating-note"><CheckCircle2 size={16} /> Záznam uložený</div>
          </div>
        </section>
        <section className="landing-benefits">
          <div><span className="benefit-icon"><Clock3 size={19} /></span><strong>Rýchle záznamy</strong><p>Prácu zapíšete aj z mobilu priamo z pracoviska.</p></div>
          <div><span className="benefit-icon"><ShieldCheck size={19} /></span><strong>Firemné súkromie</strong><p>Každá firma má svoje oddelené a chránené údaje.</p></div>
          <div><span className="benefit-icon"><CheckCircle2 size={19} /></span><strong>Jasný prehľad</strong><p>Vedúci nájde potrebné záznamy podľa ľudí aj práce.</p></div>
        </section>
        <footer className="landing-footer">© {new Date().getFullYear()} Workena <span>Navrhnutá pre skutočnú prácu.</span></footer>
      </main>
    );
  }

  const renderEntryForm = () => (
    <section className="narrow-page content-page">
      <button className="back-link button-quiet" onClick={() => { setPage("dashboard"); setEditingEntry(null); setPendingPhotos([]); }}><ArrowLeft size={15} /> Späť na prehľad</button>
      <header className="page-heading"><span className="heading-icon"><ClipboardList size={20} /></span><div><span className="eyebrow">{editingEntry ? "ÚPRAVA ZÁZNAMU" : "NOVÝ ZÁZNAM"}</span><h1>{editingEntry ? "Upraviť odpracovaný čas" : "Zapísať odpracovaný čas"}</h1><p>Údaje sú viditeľné iba členom firmy {activeMembership?.company.name}.</p></div></header>
      <form className="panel form-panel form-stack entry-form" onSubmit={(event) => void saveEntry(event)}>
        <div className="form-grid">
          <label className="field"><span>Dátum a čas práce</span><input type="datetime-local" name="worked_at" defaultValue={dateTimeLocal(editingEntry?.worked_at)} required /></label>
          <label className="field"><span>Odpracované hodiny</span><input type="number" name="hours" min="0.25" max="24" step="0.25" defaultValue={editingEntry?.hours ?? ""} placeholder="napr. 7,5" required /></label>
          <label className="field"><span>Druh práce</span><input name="work_type" minLength={2} maxLength={120} defaultValue={editingEntry?.work_type ?? ""} placeholder="napr. Montáž, servis…" required /></label>
          <label className="field"><span>Miesto / pracovisko</span><input name="workplace" minLength={2} maxLength={120} defaultValue={editingEntry?.workplace ?? ""} placeholder="napr. Bratislava — Ružinov" required /></label>
        </div>
        <label className="field"><span>Poznámka <small>voliteľné</small></span><textarea name="note" rows={4} maxLength={2000} defaultValue={editingEntry?.note ?? ""} placeholder="Doplňujúce informácie k práci…" /></label>
        <section className="entry-photo-picker">
          <div className="entry-photo-heading"><span className="photo-hint-icon"><Camera size={17} /></span><span><strong>Fotografie k záznamu</strong><small>JPG, PNG alebo WebP · max. 8 MB na fotografiu · najviac {MAX_PHOTOS}</small></span></div>
          <label className="button button-outline button-small entry-photo-button"><Plus size={15} /> Vybrať fotografie<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} disabled={busy} /></label>
          {pendingPhotos.length > 0 && <ul className="pending-photo-list">{pendingPhotos.map((photo, index) => <li key={`${photo.name}-${photo.size}-${index}`}><span><Camera size={14} />{photo.name}</span><button type="button" aria-label={`Odstrániť ${photo.name}`} onClick={() => setPendingPhotos((current) => current.filter((_, photoIndex) => photoIndex !== index))}><X size={15} /></button></li>)}</ul>}
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="button button-quiet" onClick={() => { setPage("dashboard"); setEditingEntry(null); setPendingPhotos([]); }}>Zrušiť</button><button className="button button-primary" disabled={busy}>{busy ? "Ukladám…" : editingEntry ? "Uložiť zmeny" : "Uložiť záznam"}</button></div>
      </form>
    </section>
  );

  const renderTeam = () => (
    <section className="content-page">
      <header className="dashboard-title-row"><div><span className="eyebrow">FIREMNÝ PRIESTOR</span><h1>Tím</h1><p>Správa členov a ich prístupu k údajom firmy.</p></div></header>
      <div className="team-layout">
        <section className="panel team-panel">
          <div className="panel-heading"><div><h2><Users size={17} /> Členovia tímu</h2><p>Prístup majú iba aktívni členovia firmy.</p></div><span className="count-pill">{roster.filter((member) => member.active).length} členov</span></div>
          <div className="member-list">{roster.filter((member) => member.active).map((member) => <div className="member-row" key={member.id}>
            <span className="avatar">{initials(member.full_name || member.email)}</span>
            <span className="member-name"><strong>{member.full_name || member.email}</strong><small>{member.email}</small></span>
            <span className={`status-pill role-${member.role.toLowerCase()}`}>{roleName(member.role)}</span>
            {member.role !== "OWNER" && (activeMembership?.role === "OWNER" || member.role === "EMPLOYEE") && <button className="logout-button" aria-label={`Odstrániť ${member.email}`} onClick={() => void removeMember(member)} disabled={busy}><X size={16} /></button>}
          </div>)}</div>
        </section>
        {isManager && <section className="panel invite-panel">
          <div className="panel-heading"><div><h2><Plus size={17} /> Pridať člena</h2><p>Člen musí mať aspoň raz vytvorený účet cez Google.</p></div></div>
          <form className="invite-form" onSubmit={(event) => void addMember(event)}>
            <label className="field"><span>E-mail Google účtu</span><input type="email" name="email" autoComplete="email" placeholder="meno@firma.sk" required /></label>
            <label className="field"><span>Rola</span><select name="role" defaultValue="EMPLOYEE"><option value="EMPLOYEE">Zamestnanec</option>{activeMembership?.role === "OWNER" && <option value="MANAGER">Vedúci</option>}</select></label>
            <button className="button button-primary" disabled={busy}>Pridať do tímu</button>
          </form>
        </section>}
      </div>
      {activeMembership?.role === "OWNER" && <section className={`panel plan-card ${activeMembership.company.plan === "PRO" ? "plan-card-pro" : ""}`}>
        <div className="plan-card-copy"><span className="eyebrow">{activeMembership.company.plan === "PRO" ? "AKTÍVNY PLÁN" : "BEZPLATNÝ PLÁN"}</span><h2>{activeMembership.company.plan === "PRO" ? "Workena Pro" : "Workena Free"}</h2><p>{activeMembership.company.plan === "PRO" ? "Firemný priestor používa plán Pro." : `Používate ${roster.filter((member) => member.active && member.role === "EMPLOYEE").length} z 2 zamestnaneckých miest.`}</p></div>
        <div className="plan-card-price"><strong>{activeMembership.company.plan === "PRO" ? "Pro" : "50 €"}</strong><span>{activeMembership.company.plan === "PRO" ? "aktívny" : "za rok · Pro"}</span></div>
        {activeMembership.company.plan === "FREE" && <p className="plan-card-note">Bezplatný plán má limit 2 zamestnancov. Online platby zatiaľ nie sú zapnuté; pre aktiváciu Pro kontaktujte správcu Workena.</p>}
      </section>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );

  const renderHistory = () => (
    <section className="content-page">
      <header className="dashboard-title-row">
        <div><span className="eyebrow">ARCHÍV FIRMY</span><h1>História odpracovaných hodín</h1><p>Prehľady minulých mesiacov vrátane bývalých zamestnancov.</p></div>
        <label className="field history-month-field"><span>Vybrať mesiac</span><select value={historyMonth} onChange={(event) => setHistoryMonth(event.target.value)}>
          {historyMonthOptions.map((month) => <option key={month} value={month}>{new Intl.DateTimeFormat("sk-SK", { month: "long", year: "numeric" }).format(new Date(`${month}-15T12:00:00`))}</option>)}
        </select></label>
      </header>
      <section className="records-section">
        <div className="section-title-row"><div><h2><History size={17} /> {historyMonthLabel}</h2><p>Každý súčet zahŕňa záznamy daného mesiaca.</p></div><span className="count-pill">{historyEmployeeSummary.length} zamestnancov</span></div>
        {historyEmployeeSummary.length === 0
          ? <div className="panel employee-hours-empty">Za tento mesiac sa nenašli pracovné záznamy.</div>
          : <div className="panel employee-hours-list">{historyEmployeeSummary.map(({ member, hours, entryCount }) => {
            const expanded = expandedEmployeeId === member.id;
            const memberEntries = historyEntries
              .filter((entry) => entry.user_id === member.user_id)
              .sort((a, b) => b.worked_at.localeCompare(a.worked_at));
            const entriesByDay = new Map<string, WorkEntry[]>();
            for (const entry of memberEntries) {
              const day = localDateKey(entry.worked_at);
              entriesByDay.set(day, [...(entriesByDay.get(day) ?? []), entry]);
            }
            return <div className="employee-hours-item" key={member.id}>
              <div className="employee-hours-row history-employee-row">
                <span className="avatar">{initials(member.full_name || member.email)}</span>
                <span className="employee-hours-name"><strong>{member.full_name || member.email}</strong><small>{member.email}</small></span>
                {!member.active && <span className="former-employee-badge">Bývalý zamestnanec</span>}
                <span className="employee-hours-count">Záznamy: {entryCount}</span>
                <strong className="employee-hours-total">{hoursLabel(hours)} <small>hod.</small></strong>
                <button className="employee-hours-toggle" aria-label={`${expanded ? "Skryť" : "Zobraziť"} históriu: ${member.full_name || member.email}`} aria-expanded={expanded} onClick={() => setExpandedEmployeeId(expanded ? null : member.id)}>
                  {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
                </button>
              </div>
              {expanded && <div className="employee-hours-details">
                {entryCount === 0
                  ? <p className="employee-hours-no-entries">Bez pracovných záznamov za tento mesiac.</p>
                  : Array.from(entriesByDay.entries()).map(([day, dayEntries]) => <section className="employee-day" key={day}>
                    <div className="employee-day-heading"><strong>{dateLabel(`${day}T12:00:00`)}</strong><span>{hoursLabel(dayEntries.reduce((sum, entry) => sum + Number(entry.hours), 0))} hod.</span></div>
                    {dayEntries.map((entry) => <button className="employee-day-entry" key={entry.id} onClick={() => setSelectedId(entry.id)}>
                      <span><strong>{entry.work_type}</strong><small>{entry.workplace} · {statusName(entry.status)}</small></span>
                      <strong>{hoursLabel(Number(entry.hours))} h</strong>
                    </button>)}
                  </section>)}
              </div>}
            </div>;
          })}</div>}
      </section>
    </section>
  );

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <button className="brand brand-button" onClick={() => { setPage("dashboard"); setSelectedId(null); }}><span className="brand-mark">w</span> workena</button>
        <div className="workspace-switch">
          <span className="workspace-monogram">{initials(activeMembership?.company.name ?? "W")}</span>
          {memberships.length > 1
            ? <select aria-label="Vybrať firmu" value={activeCompanyId} onChange={(event) => { setCompanyId(event.target.value); setSelectedId(null); }}><option value="" disabled>Vybrať firmu</option>{memberships.map((membership) => <option key={membership.company_id} value={membership.company_id}>{membership.company.name}</option>)}</select>
            : <span><strong>{activeMembership?.company.name}</strong><small>Firemný priestor</small></span>}
        </div>
        <span className="nav-caption">PRACOVNÝ PRIESTOR</span>
        <nav className="side-nav">
          <button className={`nav-link ${page === "dashboard" ? "active" : ""}`} onClick={() => { setPage("dashboard"); setSelectedId(null); }}><LayoutDashboard size={18} /> Prehľad</button>
          <button className={`nav-link ${page === "entry" ? "active" : ""}`} onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setPage("entry"); }}><ClipboardList size={18} /> Nový záznam</button>
          {isManager && <button className={`nav-link ${page === "team" ? "active" : ""}`} onClick={() => setPage("team")}><Users size={18} /> Tím</button>}
          {isManager && <button className={`nav-link ${page === "history" ? "active" : ""}`} onClick={() => setPage("history")}><History size={18} /> História</button>}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row"><span className="avatar">{initials(profileName)}</span><span className="profile-name"><strong>{profileName}</strong><small>{activeMembership ? roleName(activeMembership.role) : "Bez firmy"}</small></span></div>
          <button className="logout-button" aria-label="Odhlásiť sa" onClick={() => void signOut()}><LogOut size={17} /></button>
        </div>
      </aside>
      <div className="main-area">
        <header className="mobile-top"><Brand /><span className="mobile-company">{activeMembership?.company.name}</span><button className="logout-button" aria-label="Odhlásiť sa" onClick={() => void signOut()}><LogOut size={17} /></button></header>
        <main className="page-content">
          {!activeMembership ? (
            <section className="center-card company-create">
              <span className="eyebrow">VITAJTE VO WORKENE</span><h1>Založte firemný priestor</h1>
              <p className="muted">Váš účet zatiaľ nie je členom firmy. Založte firmu a stanete sa jej vlastníkom.</p>
              <form className="form-stack" onSubmit={(event) => void createCompany(event)}>
                <label className="field"><span>Názov firmy</span><input name="name" minLength={2} maxLength={120} placeholder="napr. Workena s.r.o." required /></label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="button button-primary" disabled={busy}>{busy ? "Vytváram…" : "Vytvoriť firmu"}</button>
              </form>
            </section>
          ) : page === "entry" ? renderEntryForm() : page === "team" ? renderTeam() : page === "history" && isManager ? renderHistory() : (
            <div className="content-page">
              <header className="dashboard-title-row"><div><span className="eyebrow">PREHĽAD PRÁCE</span><h1>Dobrý deň, {profileName.split(" ")[0]}</h1><p>Tu je prehľad práce vo firme {activeMembership.company.name}.</p></div><button className="button button-primary" onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setPage("entry"); }}><Plus size={16} /> Nový záznam</button></header>
              <section className="stats-grid">
                <div className="stat-card"><span className="stat-label">Odpracované tento mesiac</span><span className="stat-icon stat-purple"><Clock3 size={17} /></span><strong>{hoursLabel(monthHours)} <small>hod.</small></strong><span className="stat-foot">{isManager ? "Všetci zamestnanci" : "Vaše odpracované hodiny"}</span></div>
                <div className="stat-card"><span className="stat-label">{isManager ? "Čaká na kontrolu" : "Moje záznamy na kontrolu"}</span><span className="stat-icon stat-amber"><ClipboardList size={17} /></span><strong>{visibleEntries.filter((entry) => entry.status === "PENDING").length}</strong><span className="stat-foot">{isManager ? "Nevybavené záznamy firmy" : "Vaše nevybavené záznamy"}</span></div>
                <div className="stat-card"><span className="stat-label">{isManager ? "Členovia tímu" : "Moje záznamy tento mesiac"}</span><span className={`stat-icon ${isManager ? "stat-green" : "stat-purple"}`}>{isManager ? <Users size={17} /> : <ClipboardList size={17} />}</span><strong>{isManager ? roster.filter((member) => member.active).length : monthlyEntries.length}</strong><span className="stat-foot">{isManager ? "Aktívni členovia firmy" : "Zapísané pracovné dni"}</span></div>
              </section>
              {isManager && <section className="employee-hours-section">
                <div className="section-title-row"><div><h2><Clock3 size={17} /> Odpracované hodiny podľa zamestnanca</h2><p>Súčet záznamov za {reportMonth}.</p></div><div className="report-heading-actions"><span className="count-pill">{employeeMonthSummary.length} zamestnancov</span><button className="button button-outline button-small no-print" onClick={printMonthlyReport}><Printer size={15} /> Vytlačiť / uložiť PDF</button></div></div>
                {employeeMonthSummary.length > 0
                  ? <div className="panel employee-hours-list">{employeeMonthSummary.map(({ member, hours, entryCount }) => {
                    const expanded = expandedEmployeeId === member.id;
                    const entriesByDay = new Map<string, WorkEntry[]>();
                    for (const entry of monthlyEntries) {
                      if (entry.user_id !== member.user_id) continue;
                      const day = localDateKey(entry.worked_at);
                      entriesByDay.set(day, [...(entriesByDay.get(day) ?? []), entry]);
                    }
                    return <div className="employee-hours-item" key={member.id}>
                      <div className="employee-hours-row">
                        <span className="avatar">{initials(member.full_name || member.email)}</span>
                        <span className="employee-hours-name"><strong>{member.full_name || member.email}</strong><small>{member.email}</small></span>
                        <span className="employee-hours-count">Záznamy: {entryCount}</span>
                        <strong className="employee-hours-total">{hoursLabel(hours)} <small>hod.</small></strong>
                        <button
                          className="employee-hours-toggle"
                          aria-label={`${expanded ? "Skryť" : "Zobraziť"} denné záznamy: ${member.full_name || member.email}`}
                          aria-expanded={expanded}
                          aria-controls={`employee-hours-details-${member.id}`}
                          onClick={() => setExpandedEmployeeId(expanded ? null : member.id)}
                        >{expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button>
                      </div>
                      {expanded && <div className="employee-hours-details" id={`employee-hours-details-${member.id}`}>
                        {entryCount === 0
                          ? <p className="employee-hours-no-entries">Tento mesiac zatiaľ nemá žiadne pracovné záznamy.</p>
                          : Array.from(entriesByDay.entries()).map(([day, dayEntries]) => {
                            const dayHours = dayEntries.reduce((sum, entry) => sum + Number(entry.hours), 0);
                            return <section className="employee-day" key={day}>
                              <div className="employee-day-heading"><strong>{dateLabel(`${day}T12:00:00`)}</strong><span>{hoursLabel(dayHours)} hod.</span></div>
                              {dayEntries.map((entry) => <button className="employee-day-entry" key={entry.id} onClick={() => setSelectedId(entry.id)}>
                                <span><strong>{entry.work_type}</strong><small>{entry.workplace} · {statusName(entry.status)}</small></span>
                                <strong>{hoursLabel(Number(entry.hours))} h</strong>
                              </button>)}
                            </section>;
                          })}
                      </div>}
                    </div>;
                  })}</div>
                  : <div className="panel employee-hours-empty">Zatiaľ vo firme nie sú pridaní žiadni zamestnanci.</div>}
              </section>}
              {notice && <p className="invite-success" role="status">{notice}</p>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <section className="records-section">
                <div className="section-title-row"><div><h2><ClipboardList size={17} /> Pracovné záznamy</h2><p>{isManager ? "Záznamy dostupné členom tejto firmy." : "Vaše pracovné záznamy."}</p></div><span className="count-pill">{visibleEntries.length} záznamov</span></div>
                {visibleEntries.length === 0 ? <div className="panel empty-state"><span className="soft-icon"><ClipboardList size={19} /></span><strong>Zatiaľ tu nie sú žiadne záznamy</strong><p>Pridajte prvý pracovný záznam pre túto firmu.</p><button className="button button-primary button-small" onClick={() => setPage("entry")}><Plus size={15} /> Nový záznam</button></div> : (
                  <div className="record-list">{visibleEntries.map((entry) => {
                    const author = roster.find((member) => member.user_id === entry.user_id);
                    return <article className="record-card" key={entry.id}>
                      <div className="record-date"><strong>{new Intl.DateTimeFormat("sk-SK", { day: "2-digit" }).format(new Date(entry.worked_at))}</strong><span>{new Intl.DateTimeFormat("sk-SK", { month: "short" }).format(new Date(entry.worked_at))}</span><small>{new Date(entry.worked_at).getFullYear()}</small></div>
                      <div className="record-main">
                        <div className="record-heading"><button className="record-title" onClick={() => setSelectedId(entry.id)}>{entry.work_type}</button><span className={`status-pill status-${entry.status.toLowerCase()}`}>{statusName(entry.status)}</span></div>
                        <div className="record-meta"><span><MapPin size={12} /> {entry.workplace}</span><span>{author?.full_name || author?.email || "Člen firmy"}</span><span>{dateLabel(entry.worked_at)}</span></div>
                        {entry.review_note && <small className="review-note">{entry.review_note}</small>}
                      </div>
                      <div className="record-end"><strong>{hoursLabel(Number(entry.hours))} h</strong><button className="button button-outline button-small" onClick={() => setSelectedId(entry.id)}>Detail</button></div>
                    </article>;
                  })}</div>
                )}
              </section>
            </div>
          )}
        </main>
        {activeMembership && <nav className="mobile-nav" aria-label="Hlavná navigácia">
          <button className={`mobile-nav-link ${page === "dashboard" ? "active" : ""}`} aria-current={page === "dashboard" ? "page" : undefined} onClick={() => { setPage("dashboard"); setSelectedId(null); }}>
            <LayoutDashboard size={19} /><span>Prehľad</span>
          </button>
          <button className={`mobile-nav-link ${page === "entry" ? "active" : ""}`} aria-current={page === "entry" ? "page" : undefined} onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setPage("entry"); }}>
            <Plus size={20} /><span>Nový záznam</span>
          </button>
          {isManager && <button className={`mobile-nav-link ${page === "team" ? "active" : ""}`} aria-current={page === "team" ? "page" : undefined} onClick={() => setPage("team")}>
            <Users size={19} /><span>Tím</span>
          </button>}
          {isManager && <button className={`mobile-nav-link ${page === "history" ? "active" : ""}`} aria-current={page === "history" ? "page" : undefined} onClick={() => setPage("history")}>
            <History size={19} /><span>História</span>
          </button>}
        </nav>}
      </div>
      {isManager && <section className="print-report">
        <header className="print-report-header"><span className="brand"><span className="brand-mark">w</span> workena</span><span>Firemný mesačný prehľad</span></header>
        <h1>Odpracované hodiny — {reportMonth}</h1>
        <p className="print-report-company">{activeMembership?.company.name} · Vygenerované {dateLabel(new Date().toISOString())}</p>
        <div className="print-report-total"><span>Spolu za zamestnancov</span><strong>{hoursLabel(employeeMonthSummary.reduce((sum, employee) => sum + employee.hours, 0))} hod.</strong></div>
        {employeeMonthSummary.map(({ member, hours, entryCount }) => {
          const memberEntries = monthlyEntries
            .filter((entry) => entry.user_id === member.user_id)
            .sort((a, b) => a.worked_at.localeCompare(b.worked_at));
          const dayGroups = new Map<string, WorkEntry[]>();
          for (const entry of memberEntries) {
            const day = localDateKey(entry.worked_at);
            dayGroups.set(day, [...(dayGroups.get(day) ?? []), entry]);
          }
          return <section className="print-employee" key={member.id}>
            <div className="print-employee-heading"><div><h2>{member.full_name || member.email}</h2><span>{member.email} · {entryCount} záznamov</span></div><strong>{hoursLabel(hours)} hod.</strong></div>
            {Array.from(dayGroups.entries()).map(([day, dayEntries]) => <div className="print-day" key={day}>
              <div className="print-day-heading"><strong>{dateLabel(`${day}T12:00:00`)}</strong><strong>{hoursLabel(dayEntries.reduce((sum, entry) => sum + Number(entry.hours), 0))} hod.</strong></div>
              {dayEntries.map((entry) => <div className="print-entry" key={entry.id}><span><strong>{entry.work_type}</strong><small>{entry.workplace} · {statusName(entry.status)}</small></span><strong>{hoursLabel(Number(entry.hours))} h</strong></div>)}
            </div>)}
            {memberEntries.length === 0 && <p className="print-empty">Tento mesiac bez záznamov.</p>}
          </section>;
        })}
        <footer className="print-report-footer">Workena · {activeMembership?.company.name}</footer>
      </section>}
      {selectedEntry && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}>
        <section className="detail-panel detail-modal" role="dialog" aria-modal="true" aria-labelledby="entry-detail-title">
          <div className="detail-modal-heading"><div className="detail-modal-title-icon"><ClipboardList size={21} /></div><div className="detail-modal-title-copy"><span className="eyebrow">PRACOVNÝ ZÁZNAM</span><h2 id="entry-detail-title">{selectedEntry.work_type}</h2><p>{roster.find((member) => member.user_id === selectedEntry.user_id)?.full_name || roster.find((member) => member.user_id === selectedEntry.user_id)?.email || "Vaše pracovné hodiny"}</p></div><button className="logout-button" aria-label="Zavrieť detail" onClick={() => setSelectedId(null)}><X size={18} /></button></div>
          {isManager && selectedEntry.status === "PENDING" && <div className="review-banner"><span className="review-banner-icon"><CheckCircle2 size={18} /></span><span><strong>Záznam čaká na vaše schválenie</strong><small>Skontrolujte údaje a potvrďte odpracovaný čas.</small></span></div>}
          <div className="detail-stats"><div><span>Dátum</span><strong>{dateLabel(selectedEntry.worked_at)}</strong></div><div><span>Odpracovaný čas</span><strong>{hoursLabel(Number(selectedEntry.hours))} hod.</strong></div><div><span>Miesto</span><strong>{selectedEntry.workplace}</strong></div></div>
          {selectedEntry.note && <div className="detail-note"><span className="muted-label">POZNÁMKA</span><p>{selectedEntry.note}</p></div>}
          <section className="photo-section">
            <div className="section-title-row"><div><h3><Camera size={16} /> Fotografie</h3><p className="muted">{photos.length} z {MAX_PHOTOS} fotografií · súkromné úložisko</p></div></div>
            {photos.length > 0 && <div className="photo-grid">{photos.map((photo) => <div className="photo-tile" key={photo.id}><a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={photo.file_name} /><span>{photo.file_name}</span></a>{isManager && <button className="photo-download" onClick={() => void downloadPhoto(photo)} aria-label={`Stiahnuť ${photo.file_name}`} disabled={busy}><Download size={14} /></button>}{(isManager || (selectedEntry.user_id === session.user.id && selectedEntry.status !== "APPROVED")) && <button className="photo-remove" onClick={() => void removePhoto(photo)} aria-label={`Odstrániť ${photo.file_name}`}><Trash2 size={14} /></button>}</div>)}</div>}
            {(isManager || (selectedEntry.user_id === session.user.id && selectedEntry.status !== "APPROVED")) && photos.length < MAX_PHOTOS && <label className="button button-outline button-small upload-label"><Plus size={15} /> Pridať fotografie<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void uploadPhotos(event)} disabled={busy} /></label>}
          </section>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="detail-actions">
            {isManager && selectedEntry.status === "PENDING" && <><button className="button button-outline button-small" disabled={busy} onClick={() => void changeReview(selectedEntry, "REJECTED")}>Vrátiť na opravu</button><button className="button button-primary button-small" disabled={busy} onClick={() => void changeReview(selectedEntry, "APPROVED")}><CheckCircle2 size={15} /> Schváliť</button></>}
            {(isManager || (selectedEntry.user_id === session.user.id && selectedEntry.status !== "APPROVED")) && <button className="button button-outline button-small" disabled={busy} onClick={() => { setEditingEntry(selectedEntry); setPendingPhotos([]); setSelectedId(null); setPage("entry"); setError(""); }}><Pencil size={14} /> Upraviť</button>}
            {(isManager || (selectedEntry.user_id === session.user.id && selectedEntry.status !== "APPROVED")) && <button className="button button-danger button-small" disabled={busy} onClick={() => void removeEntry(selectedEntry)}><Trash2 size={14} /> Odstrániť</button>}
          </div>
        </section>
      </div>}
    </div>
  );
}

function Brand() {
  return <span className="brand"><span className="brand-mark">w</span> workena</span>;
}
