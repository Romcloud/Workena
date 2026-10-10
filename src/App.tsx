import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  Clock3,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Coffee,
  Download,
  History,
  LayoutDashboard,
  LogOut,
  MapPin,
  Pencil,
  Play,
  Plus,
  Printer,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigurationError } from "./lib/supabase";
import type { AttendanceBreak, AttendanceShift, Company, EntryStatus, Membership, PaymentPlan, PaymentRequest, Photo, Role, VehicleTrip, WorkEntry, WorkOrder, WorkOrderPhoto, WorkOrderStatus } from "./lib/types";
import { TermsOfService } from "./TermsOfService";

type WorkspaceMembership = Membership & { company: Company };
type Page = "dashboard" | "entry" | "attendance" | "workOrders" | "trips" | "reports" | "team" | "history" | "terms";
type PhotoView = Photo & { url: string };

const PHOTO_BUCKET = "work-photos";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 10;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const WORK_ORDER_PHOTO_BUCKET = "work-order-photos";
const PAYMENT_IBAN = "SK5811000000002948309028";
const PAYMENT_BENEFICIARY = "Roman Chlebovec - ROVOLT";
const PAYMENT_PLAN_DETAILS: Record<PaymentPlan, { name: string; amount: number }> = {
  BASIC: { name: "Basic", amount: 19 },
  PRO: { name: "Pro", amount: 39 },
  TEAM: { name: "Team", amount: 69 },
};

type WorkOrderPhotoView = WorkOrderPhoto & { url: string };
type WorkOrderPhotoFiles = Record<string, { BEFORE: File[]; AFTER: File[] }>;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Požiadavku sa nepodarilo dokončiť. Skúste to znova.";
}

function initials(name: string) {
  return name.trim().slice(0, 1).toLocaleUpperCase("sk");
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function localDateKey(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function hoursLabel(value: number) {
  return new Intl.NumberFormat("sk-SK", { maximumFractionDigits: 2 }).format(Number(value));
}

function dateTimeLocal(value?: string) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("sk-SK", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function durationLabel(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

function attendanceDuration(
  shift: AttendanceShift,
  breaks: AttendanceBreak[],
  now: number,
  rangeStart = Number.NEGATIVE_INFINITY,
  rangeEnd = Number.POSITIVE_INFINITY,
) {
  const shiftStart = Math.max(new Date(shift.started_at).getTime(), rangeStart);
  const shiftEnd = Math.min(shift.ended_at ? new Date(shift.ended_at).getTime() : now, rangeEnd);
  const elapsed = Math.max(0, shiftEnd - shiftStart);
  const breakDuration = breaks.reduce((total, pause) => {
    const pauseStart = Math.max(new Date(pause.started_at).getTime(), shiftStart);
    const pauseEnd = Math.min(pause.ended_at ? new Date(pause.ended_at).getTime() : now, shiftEnd);
    return total + Math.max(0, pauseEnd - pauseStart);
  }, 0);
  return Math.max(0, elapsed - breakDuration);
}

function roleName(role: Role) {
  return role === "OWNER" ? "Vlastník" : role === "MANAGER" ? "Vedúci" : "Zamestnanec";
}

function statusName(status: EntryStatus) {
  return status === "APPROVED" ? "Schválené" : status === "REJECTED" ? "Vrátené" : "Čaká na kontrolu";
}

function workOrderStatusName(status: WorkOrderStatus) {
  return status === "DONE" ? "Hotové" : status === "IN_PROGRESS" ? "Rozpracované" : "Priradené";
}

function csvCell(value: string | number | null | undefined) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function reportMonthKey(value: string | null) {
  return value ? localDateKey(value).slice(0, 7) : "";
}

function monthBounds(month: string) {
  const start = new Date(`${month}-01T00:00:00`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function geocodeSlovakAddress(address: string) {
  const params = new URLSearchParams({ format: "jsonv2", limit: "1", countrycodes: "sk", q: address });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { "Accept-Language": "sk" },
  });
  if (!response.ok) throw new Error(`Mapové vyhľadávanie zlyhalo (HTTP ${response.status}).`);
  const results = (await response.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
  const location = results[0];
  if (!location) throw new Error(`Adresu „${address}“ sa nepodarilo nájsť na Slovensku.`);
  return { lat: location.lat, lon: location.lon };
}

async function openStreetMapRoadDistance(origin: string, destination: string) {
  const from = await geocodeSlovakAddress(origin);
  await sleep(1100);
  const to = await geocodeSlovakAddress(destination);
  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&alternatives=false&steps=false`,
  );
  if (!response.ok) throw new Error(`Výpočet cestnej trasy zlyhal (HTTP ${response.status}).`);
  const route = (await response.json()) as { code: string; routes?: Array<{ distance: number }> };
  if (route.code !== "Ok" || !route.routes?.[0]) {
    throw new Error("Cestnú trasu sa nepodarilo vypočítať. Skontrolujte adresy alebo zadajte kilometre ručne.");
  }
  return Math.round((route.routes[0].distance / 1000) * 100) / 100;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [entries, setEntries] = useState<WorkEntry[]>([]);
  const [roster, setRoster] = useState<Membership[]>([]);
  const [attendanceShifts, setAttendanceShifts] = useState<AttendanceShift[]>([]);
  const [attendanceBreaks, setAttendanceBreaks] = useState<AttendanceBreak[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [workOrderPhotos, setWorkOrderPhotos] = useState<WorkOrderPhotoView[]>([]);
  const [pendingWorkOrderPhotos, setPendingWorkOrderPhotos] = useState<WorkOrderPhotoFiles>({});
  const [vehicleTrips, setVehicleTrips] = useState<VehicleTrip[]>([]);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [selectedPaymentRequestId, setSelectedPaymentRequestId] = useState<string | null>(null);
  const [tripMonth, setTripMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [tripOrigin, setTripOrigin] = useState("");
  const [tripDestination, setTripDestination] = useState("");
  const [tripRoundTrip, setTripRoundTrip] = useState(false);
  const [tripDistance, setTripDistance] = useState("");
  const [tripMapDistance, setTripMapDistance] = useState<number | null>(null);
  const [tripDistanceSource, setTripDistanceSource] = useState<"MAP" | "MANUAL" | "MAP_EDITED">("MANUAL");
  const [tripMapBusy, setTripMapBusy] = useState(false);
  const [tripNotice, setTripNotice] = useState("");
  const [attendanceMonth, setAttendanceMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [reportEmployeeId, setReportEmployeeId] = useState("ALL");
  const [reportDataType, setReportDataType] = useState<"ALL" | "ATTENDANCE" | "TRIPS" | "WORK_ORDERS">("ALL");
  const [attendanceNow, setAttendanceNow] = useState(Date.now());
  const [page, setPage] = useState<Page>(() => window.location.hash === "#obchodne-podmienky" ? "terms" : "dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<WorkEntry | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<File[]>([]);
  const [historyMonth, setHistoryMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attendanceRequest = useRef(0);
  const attendanceAutoStartKeys = useRef(new Set<string>());
  const workOrderRequest = useRef(0);
  const workOrdersCompany = useRef("");
  const workOrderPhotosRequest = useRef(0);
  const vehicleTripsRequest = useRef(0);

  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash === "#obchodne-podmienky") setPage("terms");
      else setPage((current) => current === "terms" ? "dashboard" : current);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const activeMembership = memberships.find((membership) => membership.company_id === companyId) ?? memberships[0];
  const activeCompanyId = activeMembership?.company_id ?? "";
  const isManager = activeMembership?.role === "OWNER" || activeMembership?.role === "MANAGER";
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const selectedPaymentRequest = paymentRequests.find((request) => request.id === selectedPaymentRequestId) ?? null;
  const profileName =
    session?.user.user_metadata.full_name ??
    session?.user.user_metadata.name ??
    session?.user.email?.split("@")[0] ??
    "Používateľ";
  const client = supabase;

  useEffect(() => {
    if (page === "terms") {
      return <TermsOfService onBack={() => {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        setPage("dashboard");
      }} />;
    }

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
      setAttendanceShifts([]);
      setAttendanceBreaks([]);
      setWorkOrders([]);
      setWorkOrderPhotos([]);
      setPendingWorkOrderPhotos({});
      setVehicleTrips([]);
      workOrdersCompany.current = "";
      workOrderRequest.current += 1;
      workOrderPhotosRequest.current += 1;
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
        .select("id, company_id, user_id, email, full_name, role, active, deactivated_at, created_at")
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
        .select("id, company_id, user_id, email, full_name, role, active, deactivated_at, created_at")
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
    if (!client || !activeCompanyId || activeMembership?.role !== "OWNER") {
      setPaymentRequests([]);
      setSelectedPaymentRequestId(null);
      return;
    }

    let alive = true;
    setPaymentRequests([]);
    setSelectedPaymentRequestId(null);
    void client
      .from("payment_requests")
      .select("id, company_id, plan, amount_eur, variable_symbol, status, created_at, reviewed_at")
      .eq("company_id", activeCompanyId)
      .order("created_at", { ascending: false })
      .then(({ data, error: paymentError }) => {
        if (!alive) return;
        if (paymentError) {
          setError(paymentError.message);
          return;
        }
        const requests = (data ?? []) as PaymentRequest[];
        setPaymentRequests(requests);
        setSelectedPaymentRequestId(requests.find((request) => request.status === "PENDING")?.id ?? null);
      });

    return () => {
      alive = false;
    };
  }, [activeCompanyId, activeMembership?.role, client]);

  const createPaymentRequest = async (plan: PaymentPlan) => {
    if (!client) return;
    setError("");
    setBusy(true);
    const { data, error: paymentError } = await client.rpc("create_payment_request", { p_company_id: activeCompanyId, p_plan: plan });
    setBusy(false);
    if (paymentError) {
      setError(paymentError.message);
      return;
    }
    const request = data as PaymentRequest;
    setPaymentRequests((current) => [request, ...current.filter((item) => item.id !== request.id)]);
    setSelectedPaymentRequestId(request.id);
  };

  const refreshWorkOrders = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    if (workOrdersCompany.current !== activeCompanyId) {
      workOrdersCompany.current = activeCompanyId;
      setWorkOrders([]);
    }
    const request = ++workOrderRequest.current;
    const { data, error: workOrdersError } = await client
      .from("work_orders")
      .select("*")
      .eq("company_id", activeCompanyId)
      .order("due_date", { ascending: true })
      .order("created_at", { ascending: false });
    if (request !== workOrderRequest.current) return;
    if (workOrdersError) throw workOrdersError;
    setWorkOrders((data ?? []) as WorkOrder[]);
  }, [activeCompanyId, client]);

  const refreshWorkOrderPhotos = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const request = ++workOrderPhotosRequest.current;
    const workOrderIds = workOrders.filter((order) => order.company_id === activeCompanyId).map((order) => order.id);
    if (!workOrderIds.length) {
      setWorkOrderPhotos([]);
      return;
    }
    const { data, error: photosError } = await client
      .from("work_order_photos")
      .select("*")
      .in("work_order_id", workOrderIds)
      .order("created_at");
    if (request !== workOrderPhotosRequest.current) return;
    if (photosError) throw photosError;
    const photoRows = (data ?? []) as WorkOrderPhoto[];
    const views = await Promise.all(photoRows.map(async (photo) => {
      const { data: signed, error: signedError } = await client.storage
        .from(WORK_ORDER_PHOTO_BUCKET)
        .createSignedUrl(photo.storage_path, 60 * 60);
      if (signedError) throw signedError;
      return { ...photo, url: signed.signedUrl };
    }));
    if (request === workOrderPhotosRequest.current) setWorkOrderPhotos(views);
  }, [activeCompanyId, client, workOrders]);

  const refreshVehicleTrips = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const request = ++vehicleTripsRequest.current;
    const { data, error: tripsError } = await client
      .from("vehicle_trips")
      .select("*")
      .eq("company_id", activeCompanyId)
      .order("trip_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (request !== vehicleTripsRequest.current) return;
    if (tripsError) throw tripsError;
    setVehicleTrips((data ?? []) as VehicleTrip[]);
  }, [activeCompanyId, client]);

  const refreshAttendance = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const request = ++attendanceRequest.current;
    const monthStart = new Date(`${attendanceMonth}-01T00:00:00`);
    const nextMonthStart = new Date(monthStart);
    nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
    const [{ data: monthRows, error: monthError }, { data: openRows, error: openError }] = await Promise.all([
      client
        .from("attendance_shifts")
        .select("id, company_id, user_id, started_at, ended_at, source_work_entry_id")
        .eq("company_id", activeCompanyId)
        .lt("started_at", nextMonthStart.toISOString())
        .or(`ended_at.is.null,ended_at.gt.${monthStart.toISOString()}`)
        .order("started_at", { ascending: false }),
      client
        .from("attendance_shifts")
        .select("id, company_id, user_id, started_at, ended_at, source_work_entry_id")
        .eq("company_id", activeCompanyId)
        .is("ended_at", null),
    ]);
    if (request !== attendanceRequest.current) return;
    if (monthError || openError) {
      setError(monthError?.message ?? openError?.message ?? "Dochádzku sa nepodarilo načítať.");
      return;
    }
    const shifts = new Map<string, AttendanceShift>();
    for (const shift of [...(monthRows ?? []), ...(openRows ?? [])] as AttendanceShift[]) shifts.set(shift.id, shift);
    const shiftList = [...shifts.values()];
    let breakRows: AttendanceBreak[] = [];
    if (shiftList.length) {
      const { data, error: breakError } = await client
        .from("attendance_breaks")
        .select("id, shift_id, started_at, ended_at")
        .in("shift_id", shiftList.map((shift) => shift.id))
        .order("started_at");
      if (request !== attendanceRequest.current) return;
      if (breakError) {
        setError(breakError.message);
        return;
      }
      breakRows = (data ?? []) as AttendanceBreak[];
    }
    setAttendanceShifts(shiftList);
    setAttendanceBreaks(breakRows);
  }, [activeCompanyId, attendanceMonth, client]);

  useEffect(() => {
    if (!client || !activeCompanyId) {
      setEntries([]);
      setRoster([]);
      setAttendanceShifts([]);
      setAttendanceBreaks([]);
      setWorkOrders([]);
      setWorkOrderPhotos([]);
      setPendingWorkOrderPhotos({});
      setVehicleTrips([]);
      workOrdersCompany.current = "";
      workOrderRequest.current += 1;
      workOrderPhotosRequest.current += 1;
      vehicleTripsRequest.current += 1;
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

  useEffect(() => {
    void refreshAttendance().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshAttendance]);

  useEffect(() => {
    if (!session) {
      attendanceAutoStartKeys.current.clear();
      return;
    }
    if (!client || activeMembership?.role !== "EMPLOYEE" || !activeMembership.active) return;

    const autoStartKey = `${session.user.id}:${activeCompanyId}`;
    if (attendanceAutoStartKeys.current.has(autoStartKey)) return;
    attendanceAutoStartKeys.current.add(autoStartKey);

    let alive = true;
    void (async () => {
      try {
        const { error: startError } = await client.rpc("start_attendance", { p_company_id: activeCompanyId });
        if (startError) throw startError;
        if (!alive) return;
        await refreshAttendance();
      } catch (reason: unknown) {
        attendanceAutoStartKeys.current.delete(autoStartKey);
        if (alive) setError(errorText(reason));
      }
    })();

    return () => {
      alive = false;
    };
  }, [activeCompanyId, activeMembership?.role, client, refreshAttendance, session]);

  useEffect(() => {
    void refreshWorkOrders().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshWorkOrders]);

  useEffect(() => {
    void refreshWorkOrderPhotos().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshWorkOrderPhotos]);

  useEffect(() => {
    void refreshVehicleTrips().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshVehicleTrips]);

  useEffect(() => {
    const timer = window.setInterval(() => setAttendanceNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

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
        .select("id, company_id, user_id, email, full_name, role, active, deactivated_at, created_at")
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
      await refreshAttendance();
      setEditingEntry(null);
      setPendingPhotos([]);
      setPage("dashboard");
      if (photosError) {
        setError(`Záznam bol uložený, no fotografie sa nepodarilo úplne pridať: ${photosError}`);
      } else {
        setNotice(editingEntry ? "Záznam bol upravený a dochádzka zosynchronizovaná." : "Záznam bol uložený a dochádzka zosynchronizovaná.");
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
      await refreshAttendance();
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

  const createWorkOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: createError } = await client.rpc("create_work_order", {
        p_company_id: activeCompanyId,
        p_assignee_id: String(form.get("assignee_id") ?? ""),
        p_title: String(form.get("title") ?? ""),
        p_address: String(form.get("address") ?? ""),
        p_due_date: String(form.get("due_date") ?? ""),
        p_description: String(form.get("description") ?? ""),
      });
      if (createError) {
        setError(createError.message);
        return;
      }
      await refreshWorkOrders();
      formElement.reset();
      setNotice("Zákazka bola priradená pracovníkovi.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const updateWorkOrder = async (event: FormEvent<HTMLFormElement>, workOrderId: string) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const status = String(form.get("status") ?? "IN_PROGRESS");
    const report = String(form.get("work_report") ?? "").trim();
    if (status === "DONE" && report.length < 2) {
      setError("Pred označením zákazky ako hotovej vyplňte výkaz práce.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const pending = pendingWorkOrderPhotos[workOrderId] ?? { BEFORE: [], AFTER: [] };
      for (const phase of ["BEFORE", "AFTER"] as const) {
        const uploadError = await uploadWorkOrderPhotos(workOrderId, phase, pending[phase]);
        if (uploadError) {
          setError(uploadError);
          return;
        }
      }
      const { error: updateError } = await client.rpc("submit_work_order_report", {
        p_work_order_id: workOrderId,
        p_status: status,
        p_employee_note: String(form.get("employee_note") ?? ""),
        p_employee_materials: String(form.get("employee_materials") ?? ""),
        p_work_report: report,
      });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      await refreshWorkOrders();
      await refreshWorkOrderPhotos();
      setPendingWorkOrderPhotos((current) => {
        const next = { ...current };
        delete next[workOrderId];
        return next;
      });
      setNotice(status === "DONE" ? "Zákazka a výkaz boli odoslané ako hotové." : "Výkaz zákazky bol uložený.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const chooseWorkOrderPhotos = (
    workOrder: WorkOrder,
    phase: "BEFORE" | "AFTER",
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    if (files.some((file) => !PHOTO_TYPES.includes(file.type) || file.size < 1 || file.size > MAX_PHOTO_BYTES)) {
      setError("Povolené sú JPG, PNG alebo WebP s veľkosťou do 8 MB na fotografiu.");
      return;
    }
    const existingCount = workOrderPhotos.filter((photo) => photo.work_order_id === workOrder.id && photo.phase === phase).length;
    const pendingCount = pendingWorkOrderPhotos[workOrder.id]?.[phase].length ?? 0;
    if (existingCount + pendingCount + files.length > MAX_PHOTOS) {
      setError(`K jednej fáze zákazky môžete pridať najviac ${MAX_PHOTOS} fotografií.`);
      return;
    }
    setError("");
    setPendingWorkOrderPhotos((current) => ({
      ...current,
      [workOrder.id]: {
        BEFORE: current[workOrder.id]?.BEFORE ?? [],
        AFTER: current[workOrder.id]?.AFTER ?? [],
        [phase]: [...(current[workOrder.id]?.[phase] ?? []), ...files],
      },
    }));
  };

  const uploadWorkOrderPhotos = async (
    workOrderId: string,
    phase: "BEFORE" | "AFTER",
    files: File[],
  ): Promise<string | null> => {
    if (!client || !activeMembership) return "Firemný priestor nie je dostupný.";
    const phaseCount = workOrderPhotos.filter((photo) => photo.work_order_id === workOrderId && photo.phase === phase).length;
    if (phaseCount + files.length > MAX_PHOTOS) return `K jednej fáze zákazky môžete pridať najviac ${MAX_PHOTOS} fotografií.`;
    const refreshMessage = async () => {
      try {
        await refreshWorkOrderPhotos();
        return "";
      } catch (reason: unknown) {
        return ` Nahraté fotografie zostali uložené, ale ich obnovenie zlyhalo: ${errorText(reason)}`;
      }
    };
    for (const file of files) {
      const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
      const folder = phase === "BEFORE" ? "before" : "after";
      const path = `${activeMembership.company_id}/${workOrderId}/${folder}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await client.storage.from(WORK_ORDER_PHOTO_BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadError) {
        const refreshError = await refreshMessage();
        return `Fotografiu „${file.name}“ sa nepodarilo nahrať: ${uploadError.message}.${refreshError}`;
      }
      const { error: metadataError } = await client.rpc("add_work_order_photo", {
        p_work_order_id: workOrderId,
        p_phase: phase,
        p_storage_path: path,
        p_file_name: file.name.slice(0, 255),
        p_mime_type: file.type,
        p_size_bytes: file.size,
      });
      if (metadataError) {
        const { error: cleanupError } = await client.storage.from(WORK_ORDER_PHOTO_BUCKET).remove([path]);
        const cleanupStatus = cleanupError ? ` Súbor sa nepodarilo odstrániť z úložiska: ${cleanupError.message}` : "";
        const refreshError = await refreshMessage();
        return `Fotografiu „${file.name}“ sa nepodarilo pripojiť k zákazke: ${metadataError.message}.${cleanupStatus}${refreshError}`;
      }
      setPendingWorkOrderPhotos((current) => ({
        ...current,
        [workOrderId]: {
          BEFORE: current[workOrderId]?.BEFORE ?? [],
          AFTER: current[workOrderId]?.AFTER ?? [],
          [phase]: (current[workOrderId]?.[phase] ?? []).filter((pending) => pending !== file),
        },
      }));
    }
    return null;
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
  const monthAttendanceShifts = useMemo(
    () => {
      const monthStart = new Date(`${attendanceMonth}-01T00:00:00`).getTime();
      const nextMonthStart = new Date(monthStart);
      nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
      return attendanceShifts.filter((shift) =>
        new Date(shift.started_at).getTime() < nextMonthStart.getTime()
        && (!shift.ended_at || new Date(shift.ended_at).getTime() > monthStart),
      );
    },
    [attendanceMonth, attendanceShifts],
  );
  const attendanceSummary = useMemo(() => {
    const members = isManager
      ? roster.filter((member) => member.role === "EMPLOYEE")
      : roster.filter((member) => member.user_id === session?.user.id);
    const monthStartDate = new Date(`${attendanceMonth}-01T00:00:00`);
    const monthEndDate = new Date(monthStartDate);
    monthEndDate.setMonth(monthEndDate.getMonth() + 1);
    return members
      .map((member) => {
        const memberShifts = monthAttendanceShifts.filter((shift) => shift.user_id === member.user_id);
        const totalMilliseconds = memberShifts.reduce(
          (total, shift) =>
            total + attendanceDuration(
              shift,
              attendanceBreaks.filter((pause) => pause.shift_id === shift.id),
              attendanceNow,
              monthStartDate.getTime(),
              monthEndDate.getTime(),
            ),
          0,
        );
        return { member, shifts: memberShifts, totalMilliseconds };
      })
      .filter(({ member, shifts }) => member.active || shifts.length > 0)
      .sort((a, b) => b.totalMilliseconds - a.totalMilliseconds);
  }, [attendanceBreaks, attendanceNow, isManager, monthAttendanceShifts, roster, session?.user.id]);
  const monthVehicleTrips = useMemo(
    () => vehicleTrips.filter((trip) => trip.trip_date.slice(0, 7) === tripMonth),
    [tripMonth, vehicleTrips],
  );
  const reportVehicleTrips = useMemo(
    () => vehicleTrips.filter((trip) => trip.trip_date.slice(0, 7) === attendanceMonth),
    [attendanceMonth, vehicleTrips],
  );
  const reportWorkOrders = useMemo(
    () => workOrders.filter((order) => order.work_report?.trim() && reportMonthKey(order.updated_at) === attendanceMonth),
    [attendanceMonth, workOrders],
  );
  const reportEmployeeSummary = useMemo(() => {
    const members = roster.filter((member) => member.role === "EMPLOYEE");
    return members
      .map((member) => {
        const shifts = attendanceShifts.filter(
          (shift) => shift.user_id === member.user_id && monthAttendanceShifts.some((monthShift) => monthShift.id === shift.id),
        );
        const workedMilliseconds = shifts.reduce(
          (sum, shift) => sum + attendanceDuration(
            shift,
            attendanceBreaks.filter((pause) => pause.shift_id === shift.id),
            attendanceNow,
            monthBounds(attendanceMonth).start.getTime(),
            monthBounds(attendanceMonth).end.getTime(),
          ),
          0,
        );
        const trips = reportVehicleTrips.filter((trip) => trip.user_id === member.user_id);
        const orders = reportWorkOrders.filter((order) => order.assignee_id === member.user_id);
        return {
          member,
          workedMilliseconds,
          shiftCount: shifts.length,
          distanceKm: trips.reduce((sum, trip) => sum + Number(trip.distance_km), 0),
          tripCount: trips.length,
          reportCount: orders.length,
        };
      })
      .filter(({ member, shiftCount, tripCount, reportCount }) => member.active || shiftCount + tripCount + reportCount > 0)
      .sort((a, b) => a.member.full_name?.localeCompare(b.member.full_name ?? "", "sk") ?? a.member.email.localeCompare(b.member.email, "sk"));
  }, [attendanceBreaks, attendanceNow, attendanceMonth, attendanceShifts, monthAttendanceShifts, reportVehicleTrips, reportWorkOrders, roster]);
  const reportOrderSummary = useMemo(() => {
    const orderIds = new Set([
      ...reportVehicleTrips.flatMap((trip) => trip.work_order_id ? [trip.work_order_id] : []),
      ...reportWorkOrders.map((order) => order.id),
    ]);
    return [...orderIds].flatMap((id) => {
      const order = workOrders.find((item) => item.id === id);
      if (!order) return [];
      const trips = reportVehicleTrips.filter((trip) => trip.work_order_id === id);
      return [{
        order,
        employee: roster.find((member) => member.user_id === order.assignee_id),
        distanceKm: trips.reduce((sum, trip) => sum + Number(trip.distance_km), 0),
        tripCount: trips.length,
        reportCount: reportWorkOrders.filter((item) => item.id === id).length,
      }];
    }).sort((a, b) => b.distanceKm - a.distanceKm || a.order.title.localeCompare(b.order.title, "sk"));
  }, [reportVehicleTrips, reportWorkOrders, roster, workOrders]);
  const filteredReportAttendanceShifts = useMemo(
    () => reportDataType === "TRIPS" || reportDataType === "WORK_ORDERS"
      ? []
      : monthAttendanceShifts.filter((shift) => reportEmployeeId === "ALL" || shift.user_id === reportEmployeeId),
    [monthAttendanceShifts, reportDataType, reportEmployeeId],
  );
  const filteredReportVehicleTrips = useMemo(
    () => reportDataType === "ATTENDANCE" || reportDataType === "WORK_ORDERS"
      ? []
      : reportVehicleTrips.filter((trip) => reportEmployeeId === "ALL" || trip.user_id === reportEmployeeId),
    [reportDataType, reportEmployeeId, reportVehicleTrips],
  );
  const filteredReportWorkOrders = useMemo(
    () => reportDataType === "ATTENDANCE" || reportDataType === "TRIPS"
      ? []
      : reportWorkOrders.filter((order) => reportEmployeeId === "ALL" || order.assignee_id === reportEmployeeId),
    [reportDataType, reportEmployeeId, reportWorkOrders],
  );
  const filteredReportEmployeeSummary = useMemo(
    () => reportEmployeeSummary.filter((summary) => reportEmployeeId === "ALL" || summary.member.user_id === reportEmployeeId),
    [reportEmployeeId, reportEmployeeSummary],
  );
  const filteredReportOrderSummary = useMemo(
    () => reportOrderSummary.filter((summary) =>
      (reportEmployeeId === "ALL" || summary.employee?.user_id === reportEmployeeId)
      && (reportDataType === "ALL"
        || (reportDataType === "TRIPS" && summary.tripCount > 0)
        || (reportDataType === "WORK_ORDERS" && summary.reportCount > 0)),
    ),
    [reportDataType, reportEmployeeId, reportOrderSummary],
  );
  const activeShift = attendanceShifts.find(
    (shift) => shift.ended_at === null && shift.user_id === session?.user.id,
  ) ?? null;
  const activeBreak = activeShift
    ? attendanceBreaks.find((pause) => pause.shift_id === activeShift.id && pause.ended_at === null) ?? null
    : null;
  const attendanceMonthLabel = new Intl.DateTimeFormat("sk-SK", { month: "long", year: "numeric" })
    .format(new Date(`${attendanceMonth}-15T12:00:00`));
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

  const attendanceAction = async (
    action: "start_attendance" | "start_attendance_break" | "end_attendance_break" | "end_attendance",
  ) => {
    if (!client || !activeCompanyId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: actionError } = await client.rpc(action, { p_company_id: activeCompanyId });
      if (actionError) {
        setError(actionError.message);
        return;
      }
      await refreshAttendance();
      setNotice(
        action === "start_attendance" ? "Pracovná zmena sa začala."
          : action === "start_attendance_break" ? "Prestávka sa začala."
            : action === "end_attendance_break" ? "Prestávka sa ukončila."
              : "Pracovná zmena sa ukončila.",
      );
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const calculateVehicleTripRoute = async () => {
    if (!tripOrigin.trim() || !tripDestination.trim()) {
      setError("Zadajte miesto odchodu aj cieľ jazdy.");
      return;
    }
    setTripMapBusy(true);
    setError("");
    setTripNotice("");
    try {
      const oneWayKm = await openStreetMapRoadDistance(tripOrigin.trim(), tripDestination.trim());
      const totalKm = tripRoundTrip ? oneWayKm * 2 : oneWayKm;
      setTripMapDistance(oneWayKm);
      setTripDistance(totalKm.toFixed(2));
      setTripDistanceSource("MAP");
      setTripNotice(`Vypočítaná ${tripRoundTrip ? "spiatočná" : "jednosmerná"} cestná trasa: ${totalKm.toFixed(2)} km.`);
    } catch (reason: unknown) {
      setError(`${errorText(reason)} Zadajte vzdialenosť ručne, ak mapová služba nie je dostupná.`);
    } finally {
      setTripMapBusy(false);
    }
  };

  const saveVehicleTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId) return;
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const distance = Number(tripDistance.replace(",", "."));
    if (!Number.isFinite(distance) || distance <= 0 || distance > 2000) {
      setError("Zadajte platnú vzdialenosť jazdy od 0,01 do 2 000 km.");
      return;
    }
    setBusy(true);
    setError("");
    setTripNotice("");
    try {
      const { error: saveError } = await client.rpc("create_vehicle_trip", {
        p_company_id: activeCompanyId,
        p_work_order_id: String(form.get("work_order_id") ?? "") || null,
        p_trip_date: String(form.get("trip_date") ?? ""),
        p_origin: tripOrigin.trim(),
        p_destination: tripDestination.trim(),
        p_is_round_trip: tripRoundTrip,
        p_calculated_one_way_km: tripMapDistance,
        p_distance_km: distance,
        p_distance_source: tripDistanceSource,
        p_note: String(form.get("note") ?? ""),
      });
      if (saveError) {
        setError(saveError.message);
        return;
      }
      await refreshVehicleTrips();
      formElement.reset();
      setTripOrigin("");
      setTripDestination("");
      setTripRoundTrip(false);
      setTripDistance("");
      setTripMapDistance(null);
      setTripDistanceSource("MANUAL");
      setTripNotice("Jazda bola zaznamenaná.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportMonthlyCsv = () => {
    const rows: Array<Array<string | number | null | undefined>> = [
      ["Typ riadka", "Zamestnanec", "Dátum", "Zákazka", "Začiatok", "Koniec", "Odpracovaný čas", "Odkiaľ", "Kam", "Kilometre", "Typ jazdy", "Použitý materiál", "Výkaz práce", "Poznámka"],
    ];
    const { start, end } = monthBounds(attendanceMonth);
    for (const shift of filteredReportAttendanceShifts) {
      const shiftBreaks = attendanceBreaks.filter((pause) => pause.shift_id === shift.id);
      const employee = roster.find((member) => member.user_id === shift.user_id);
      rows.push([
        "Dochádzka",
        employee?.full_name || employee?.email || "",
        new Date(shift.started_at).toLocaleDateString("sv-SE"),
        "",
        timeLabel(shift.started_at),
        shift.ended_at ? timeLabel(shift.ended_at) : "Prebieha",
        durationLabel(attendanceDuration(shift, shiftBreaks, attendanceNow, start.getTime(), end.getTime())),
        "", "", "", "", "", "",
        shiftBreaks.map((pause) => `Prestávka ${timeLabel(pause.started_at)}–${pause.ended_at ? timeLabel(pause.ended_at) : "prebieha"}`).join("; "),
      ]);
    }
    for (const trip of filteredReportVehicleTrips) {
      const employee = roster.find((member) => member.user_id === trip.user_id);
      const order = workOrders.find((item) => item.id === trip.work_order_id);
      rows.push([
        "Jazda",
        employee?.full_name || employee?.email || "",
        trip.trip_date,
        order?.title ?? "",
        "", "", "",
        trip.origin,
        trip.destination,
        Number(trip.distance_km).toFixed(2),
        trip.is_round_trip ? "Spiatočná" : "Jednosmerná",
        "", "", trip.note ?? "",
      ]);
    }
    for (const order of filteredReportWorkOrders) {
      const employee = roster.find((member) => member.user_id === order.assignee_id);
      rows.push([
        "Výkaz zákazky",
        employee?.full_name || employee?.email || "",
        order.report_submitted_at?.slice(0, 10) ?? order.updated_at.slice(0, 10),
        order.title, "", "", "", "", "", "", "",
        order.employee_materials ?? "", order.work_report ?? "", order.employee_note ?? "",
      ]);
    }
    for (const summary of reportDataType === "ALL" ? filteredReportEmployeeSummary : []) {
      rows.push([
        "Súčet zamestnanca",
        summary.member.full_name || summary.member.email,
        attendanceMonth,
        "", "", "",
        durationLabel(summary.workedMilliseconds),
        "", "",
        summary.distanceKm.toFixed(2),
        `${summary.shiftCount} zmien, ${summary.tripCount} jázd, ${summary.reportCount} výkazov`,
        "", "", "",
      ]);
    }
    for (const summary of reportDataType === "ALL" ? filteredReportOrderSummary : []) {
      rows.push([
        "Súčet zákazky",
        summary.employee?.full_name || summary.employee?.email || "",
        attendanceMonth,
        summary.order.title, "", "", "", "", "",
        summary.distanceKm.toFixed(2),
        `${summary.tripCount} jázd, ${summary.reportCount} výkazov`, "", "", "",
      ]);
    }
    const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const companyFileName = (activeMembership?.company.name ?? "workena").replace(/[^a-z0-9_-]+/gi, "-");
    const employeeFileName = reportEmployeeId === "ALL"
      ? "vsetci-zamestnanci"
      : (roster.find((member) => member.user_id === reportEmployeeId)?.full_name ?? "zamestnanec").replace(/[^a-z0-9_-]+/gi, "-");
    const reportTypeFileName = reportDataType.toLocaleLowerCase("sk");
    link.download = `${companyFileName}-${employeeFileName}-${reportTypeFileName}-${attendanceMonth}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const printDataReport = () => {
    const previousTitle = document.title;
    document.body.classList.add("printing-data-report");
    document.title = `${activeMembership?.company.name ?? "Workena"} - report ${reportEmployeeId} ${reportDataType} ${attendanceMonth}`;
    window.addEventListener("afterprint", () => {
      document.body.classList.remove("printing-data-report");
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
        <footer className="landing-footer">© {new Date().getFullYear()} Workena <span>Navrhnutá pre skutočnú prácu.</span><a href="#obchodne-podmienky">Obchodné podmienky</a></footer>
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

  const renderAttendance = () => (
    <section className="content-page">
      <header className="dashboard-title-row">
        <div><span className="eyebrow">PRACOVNÝ ČAS</span><h1>Dochádzka</h1><p>Začiatok zmeny, prestávky a čistý odpracovaný čas.</p></div>
      </header>
      <section className={`panel attendance-clock ${activeShift ? "attendance-clock-running" : ""}`}>
        <div className="attendance-clock-copy">
          <span className="eyebrow">PRACOVNÁ ZMENA</span>
          <h2>{!activeShift ? "Zatiaľ nemáte spustenú zmenu" : activeBreak ? "Práve máte prestávku" : "Pracovná zmena prebieha"}</h2>
          {activeShift && <p>Začiatok {timeLabel(activeShift.started_at)} · odpracované {durationLabel(attendanceDuration(
            activeShift,
            attendanceBreaks.filter((pause) => pause.shift_id === activeShift.id),
            attendanceNow,
          ))}</p>}
          {activeBreak && <p>Prestávka od {timeLabel(activeBreak.started_at)}</p>}
        </div>
        {!activeShift
          ? <button className="button button-primary" disabled={busy} onClick={() => void attendanceAction("start_attendance")}><Play size={16} /> Začať zmenu</button>
          : activeBreak
            ? <button className="button button-outline" disabled={busy} onClick={() => void attendanceAction("end_attendance_break")}><Coffee size={16} /> Ukončiť prestávku</button>
            : <div className="attendance-clock-actions">
              <button className="button button-outline" disabled={busy} onClick={() => void attendanceAction("start_attendance_break")}><Coffee size={16} /> Začať prestávku</button>
              <button className="button button-danger" disabled={busy} onClick={() => void attendanceAction("end_attendance")}><Square size={15} /> Ukončiť zmenu</button>
            </div>}
      </section>
      <p className="attendance-schedule-note">Prihlásenie zamestnanca zmenu automaticky spustí alebo obnoví. Odhlásenie ani zatvorenie aplikácie časovač nezastaví; na zastavenie použite tlačidlo „Ukončiť zmenu“.</p>
      {notice && <p className="invite-success" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="records-section attendance-history">
        <div className="section-title-row">
          <div><h2><History size={17} /> Mesačný prehľad</h2><p>Súčet skutočne zaznamenaného času vrátane odpočítaných prestávok.</p></div>
          <div className="attendance-month-switch">
            <button className="employee-hours-toggle" aria-label="Predchádzajúci mesiac" onClick={() => {
              const previous = new Date(`${attendanceMonth}-01T12:00:00`);
              previous.setMonth(previous.getMonth() - 1);
              setAttendanceMonth(localDateKey(previous).slice(0, 7));
            }}><ArrowLeft size={16} /></button>
            <strong>{attendanceMonthLabel}</strong>
            <button className="employee-hours-toggle" aria-label="Nasledujúci mesiac" disabled={attendanceMonth >= localDateKey(new Date().toISOString()).slice(0, 7)} onClick={() => {
              const next = new Date(`${attendanceMonth}-01T12:00:00`);
              next.setMonth(next.getMonth() + 1);
              setAttendanceMonth(localDateKey(next).slice(0, 7));
            }}><ArrowRight size={16} /></button>
          </div>
        </div>
        <p className="attendance-schedule-note">Pracovný záznam sa automaticky prenesie ako zmena od zadaného času v dĺžke uvedených hodín, bez prestávky. Ak je v ten deň ručne meraná zmena, má prednosť, aby sa hodiny nedvojili.</p>
        {attendanceSummary.length === 0
          ? <div className="panel employee-hours-empty">Za tento mesiac zatiaľ nie je zaznamenaná dochádzka.</div>
          : <div className="panel employee-hours-list">{attendanceSummary.map(({ member, shifts, totalMilliseconds }) => {
            const expanded = expandedEmployeeId === member.id;
            const memberLabel = member.full_name || member.email;
            return <div className="employee-hours-item" key={member.id}>
              <div className="employee-hours-row history-employee-row">
                <span className="avatar">{initials(memberLabel)}</span>
                <span className="employee-hours-name"><strong>{memberLabel}</strong><small>{member.email}</small></span>
                {!member.active && <span className="former-employee-badge">Bývalý zamestnanec</span>}
                <span className="employee-hours-count">{shifts.length} zmien</span>
                <strong className="employee-hours-total">{durationLabel(totalMilliseconds)}</strong>
                <button className="employee-hours-toggle" aria-label={`${expanded ? "Skryť" : "Zobraziť"} dochádzku: ${memberLabel}`} aria-expanded={expanded} onClick={() => setExpandedEmployeeId(expanded ? null : member.id)}>
                  {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
                </button>
              </div>
              {expanded && <div className="employee-hours-details attendance-details">
                {shifts.length === 0
                  ? <p className="employee-hours-no-entries">Bez dochádzky za tento mesiac.</p>
                  : [...shifts].sort((a, b) => b.started_at.localeCompare(a.started_at)).map((shift) => {
                    const shiftBreaks = attendanceBreaks.filter((pause) => pause.shift_id === shift.id);
                    const runningBreak = shiftBreaks.find((pause) => pause.ended_at === null);
                    return <section className="employee-day attendance-day" key={shift.id}>
                      <div className="employee-day-heading">
                        <strong>{dateLabel(shift.started_at)}</strong>
                        <span>{durationLabel(attendanceDuration(shift, shiftBreaks, attendanceNow))}</span>
                      </div>
                      <div className="attendance-shift-line">
                        <span>{timeLabel(shift.started_at)} – {shift.ended_at ? timeLabel(shift.ended_at) : "prebieha"}</span>
                        {shift.source_work_entry_id
                          ? <span className="status-pill status-approved">Zo záznamu práce</span>
                          : !shift.ended_at && <span className="status-pill status-pending">{runningBreak ? "Prestávka" : "Prebieha"}</span>}
                      </div>
                      {shiftBreaks.map((pause) => <div className="attendance-break-line" key={pause.id}>
                        <Coffee size={13} /><span>Prestávka {timeLabel(pause.started_at)} – {pause.ended_at ? timeLabel(pause.ended_at) : "prebieha"}</span>
                      </div>)}
                    </section>;
                  })}
              </div>}
            </div>;
          })}</div>}
      </section>
    </section>
  );

  const renderWorkOrders = () => {
    const employees = roster.filter((member) => member.active && member.role === "EMPLOYEE");
    const today = localDateKey(new Date().toISOString());
    return (
      <section className="content-page">
        <header className="dashboard-title-row">
          <div><span className="eyebrow">PRÁCA V TERÉNE</span><h1>Úlohy a zákazky</h1><p>Zadania, termíny a aktuálny stav práce na jednotlivých zákazkách.</p></div>
        </header>
        {activeMembership?.role === "OWNER" && <section className="panel work-order-create-panel">
          <div className="panel-heading"><div><h2><Plus size={17} /> Priradiť novú zákazku</h2><p>Zákazka sa zobrazí priradenému pracovníkovi.</p></div></div>
          {employees.length === 0
            ? <p className="muted">Najskôr pridajte do tímu aktívneho zamestnanca.</p>
            : <form className="form-stack work-order-form" onSubmit={(event) => void createWorkOrder(event)}>
              <div className="form-grid">
                <label className="field"><span>Názov zákazky</span><input name="title" minLength={2} maxLength={140} placeholder="napr. Elektroinštalácia rodinného domu" required /></label>
                <label className="field"><span>Priradiť pracovníkovi</span><select name="assignee_id" defaultValue="" required><option value="" disabled>Vyberte zamestnanca</option>{employees.map((employee) => <option key={employee.user_id} value={employee.user_id}>{employee.full_name || employee.email}</option>)}</select></label>
                <label className="field"><span>Adresa zákazky</span><input name="address" minLength={2} maxLength={250} placeholder="Ulica, mesto" required /></label>
                <label className="field"><span>Termín</span><input type="date" name="due_date" required /></label>
              </div>
              <label className="field"><span>Opis práce</span><textarea name="description" rows={4} minLength={2} maxLength={4000} placeholder="Rozsah prác, dôležité pokyny a informácie…" required /></label>
              {error && <p className="form-error" role="alert">{error}</p>}
              {notice && <p className="invite-success" role="status">{notice}</p>}
              <div className="form-actions"><button className="button button-primary" disabled={busy}><Plus size={15} />{busy ? "Priraďujem…" : "Priradiť zákazku"}</button></div>
            </form>}
        </section>}
        {activeMembership?.role !== "OWNER" && notice && <p className="invite-success" role="status">{notice}</p>}
        {activeMembership?.role !== "OWNER" && error && <p className="form-error" role="alert">{error}</p>}
        <section className="records-section">
          <div className="section-title-row"><div><h2><ClipboardList size={17} /> Zoznam zákaziek</h2><p>{isManager ? "Zákazky celej firmy." : "Zákazky priradené vám."}</p></div><span className="count-pill">{workOrders.length} zákaziek</span></div>
          {workOrders.length === 0
            ? <div className="panel empty-state"><span className="soft-icon"><ClipboardList size={19} /></span><strong>Zatiaľ tu nie sú žiadne zákazky</strong><p>{isManager ? "Priraďte prvú zákazku pracovníkovi." : "Keď vám vlastník priradí zákazku, zobrazí sa tu."}</p></div>
            : <div className="work-order-list">{workOrders.map((workOrder) => {
              const assignee = roster.find((member) => member.user_id === workOrder.assignee_id);
              const canUpdate = !isManager && workOrder.assignee_id === session?.user.id;
              const overdue = workOrder.status !== "DONE" && workOrder.due_date < today;
              return <article className="panel work-order-card" key={workOrder.id}>
                <div className="work-order-heading">
                  <div><span className="eyebrow">ZÁKAZKA</span><h2>{workOrder.title}</h2></div>
                  <span className={`status-pill work-order-status work-order-${workOrder.status.toLowerCase()}`}>{workOrderStatusName(workOrder.status)}</span>
                </div>
                <div className="work-order-meta">
                  <span><MapPin size={14} />{workOrder.address}</span>
                  <span className={overdue ? "work-order-overdue" : ""}><Clock3 size={14} />Termín: {dateLabel(`${workOrder.due_date}T12:00:00`)}{overdue ? " · po termíne" : ""}</span>
                  <span><Users size={14} />{assignee?.full_name || assignee?.email || "Bývalý zamestnanec"}</span>
                </div>
                <p className="work-order-description">{workOrder.description}</p>
                {(workOrder.employee_materials || workOrder.work_report || workOrder.employee_note) && <div className="work-order-report">
                  <strong>Výkaz zákazky</strong>
                  {workOrder.report_submitted_at && <small>Odoslaný {dateLabel(workOrder.report_submitted_at)}</small>}
                  {workOrder.employee_materials && <p><b>Použitý materiál:</b> {workOrder.employee_materials}</p>}
                  {workOrder.work_report && <p><b>Opis vykonanej práce:</b> {workOrder.work_report}</p>}
                  {workOrder.employee_note && <p><b>Poznámka:</b> {workOrder.employee_note}</p>}
                </div>}
                <div className="work-order-photo-groups">
                  {(["BEFORE", "AFTER"] as const).map((phase) => {
                    const phasePhotos = workOrderPhotos.filter((photo) => photo.work_order_id === workOrder.id && photo.phase === phase);
                    const pending = pendingWorkOrderPhotos[workOrder.id]?.[phase] ?? [];
                    return <section className="work-order-photo-group" key={phase}>
                      <div className="work-order-photo-heading">
                        <strong>{phase === "BEFORE" ? "Pred prácou" : "Po práci"}</strong>
                        <span>{phasePhotos.length}{pending.length ? ` + ${pending.length} čaká na nahratie` : ""} / {MAX_PHOTOS}</span>
                      </div>
                      {phasePhotos.length > 0 && <div className="work-order-photo-grid">{phasePhotos.map((photo) => <a href={photo.url} target="_blank" rel="noreferrer" key={photo.id} aria-label={`Otvoriť fotografiu ${photo.file_name}`}>
                        <img src={photo.url} alt={`${phase === "BEFORE" ? "Pred prácou" : "Po práci"}: ${photo.file_name}`} loading="lazy" />
                        <span>{photo.file_name}</span>
                      </a>)}</div>}
                      {pending.length > 0 && <ul className="pending-photo-list">{pending.map((file, index) => <li key={`${file.name}-${file.size}-${index}`}>
                        <span><Camera size={14} />{file.name}</span>
                        <button type="button" aria-label={`Odstrániť ${file.name}`} onClick={() => setPendingWorkOrderPhotos((current) => ({
                          ...current,
                          [workOrder.id]: {
                            BEFORE: current[workOrder.id]?.BEFORE ?? [],
                            AFTER: current[workOrder.id]?.AFTER ?? [],
                            [phase]: (current[workOrder.id]?.[phase] ?? []).filter((_, fileIndex) => fileIndex !== index),
                          },
                        }))}><X size={15} /></button>
                      </li>)}</ul>}
                      {canUpdate && <label className="button button-outline button-small entry-photo-button"><Plus size={14} /> Pridať fotografie<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || phasePhotos.length + pending.length >= MAX_PHOTOS} onChange={(event) => chooseWorkOrderPhotos(workOrder, phase, event)} /></label>}
                    </section>;
                  })}
                </div>
                {canUpdate && <form className="work-order-update" onSubmit={(event) => void updateWorkOrder(event, workOrder.id)}>
                  <div className="work-order-update-fields">
                    <label className="field"><span>Stav zákazky</span><select name="status" defaultValue={workOrder.status === "DONE" ? "DONE" : "IN_PROGRESS"}><option value="IN_PROGRESS">Rozpracované</option><option value="DONE">Hotové</option></select></label>
                    <label className="field"><span>Použitý materiál <small>voliteľné</small></span><textarea name="employee_materials" rows={2} maxLength={4000} defaultValue={workOrder.employee_materials ?? ""} placeholder="Materiály a množstvá…" /></label>
                    <label className="field"><span>Výkaz vykonanej práce <small>povinný pri dokončení</small></span><textarea name="work_report" rows={3} maxLength={4000} defaultValue={workOrder.work_report ?? ""} placeholder="Popíšte vykonané práce a výsledok…" /></label>
                    <label className="field"><span>Poznámka pre vlastníka <small>voliteľné</small></span><textarea name="employee_note" rows={2} maxLength={2000} defaultValue={workOrder.employee_note ?? ""} placeholder="Doplňujúca informácia k priebehu…" /></label>
                  </div>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  <div className="form-actions"><button className="button button-primary button-small" disabled={busy}>{busy ? "Ukladám…" : workOrder.status === "DONE" ? "Uložiť výkaz" : "Uložiť výkaz zákazky"}</button></div>
                </form>}
              </article>;
            })}</div>}
        </section>
      </section>
    );
  };

  const renderTrips = () => (
    <section className="content-page">
      <header className="dashboard-title-row">
        <div><span className="eyebrow">CESTOVNÝ VÝKAZ</span><h1>Výkaz jázd</h1><p>Vzdialenosť vypočítaná po cestách na Slovensku; kilometre možno upraviť ručne.</p></div>
      </header>
      <section className="panel trip-create-panel">
        <div className="panel-heading"><div><h2><MapPin size={17} /> Zaznamenať jazdu</h2><p>Vypočítame cestnú vzdialenosť z miesta odchodu a cieľa.</p></div></div>
        <form className="form-stack trip-form" onSubmit={(event) => void saveVehicleTrip(event)}>
          <div className="form-grid">
            <label className="field"><span>Dátum jazdy</span><input type="date" name="trip_date" defaultValue={localDateKey(new Date().toISOString())} required /></label>
            <label className="field"><span>Priradiť k zákazke <small>voliteľné</small></span><select name="work_order_id" defaultValue="" onChange={(event) => {
              const order = workOrders.find((item) => item.id === event.target.value);
              if (order) {
                setTripDestination(order.address);
                setTripMapDistance(null);
                setTripDistanceSource("MANUAL");
                setTripDistance("");
                setTripNotice("");
              }
            }}><option value="">Bez zákazky</option>{workOrders.filter((order) => order.assignee_id === session?.user.id).map((order) => <option key={order.id} value={order.id}>{order.title}</option>)}</select></label>
            <label className="field"><span>Miesto odchodu</span><input value={tripOrigin} onChange={(event) => {
              setTripOrigin(event.target.value);
              setTripMapDistance(null);
              setTripDistanceSource("MANUAL");
              setTripDistance("");
              setTripNotice("");
            }} disabled={tripMapBusy} minLength={2} maxLength={250} placeholder="napr. Hlavná 1, Bratislava" required /></label>
            <label className="field"><span>Cieľ jazdy</span><input value={tripDestination} onChange={(event) => {
              setTripDestination(event.target.value);
              setTripMapDistance(null);
              setTripDistanceSource("MANUAL");
              setTripDistance("");
              setTripNotice("");
            }} disabled={tripMapBusy} minLength={2} maxLength={250} placeholder="napr. Námestie 1, Trnava" required /></label>
          </div>
          <label className="checkbox-line trip-roundtrip"><input type="checkbox" checked={tripRoundTrip} onChange={(event) => {
            const nextRoundTrip = event.target.checked;
            setTripRoundTrip(nextRoundTrip);
            if (tripMapDistance !== null && (tripDistanceSource === "MAP" || tripDistanceSource === "MAP_EDITED")) {
              setTripDistance((nextRoundTrip ? tripMapDistance * 2 : tripMapDistance).toFixed(2));
              setTripDistanceSource("MAP");
            }
          }} disabled={tripMapBusy} /><span>Spiatočná jazda (návrat na miesto odchodu)</span></label>
          <div className="trip-map-controls">
            <button type="button" className="button button-outline" disabled={tripMapBusy || busy} onClick={() => void calculateVehicleTripRoute()}>
              <MapPin size={15} />{tripMapBusy ? "Počítam trasu…" : "Vypočítať trasu cez OpenStreetMap"}
            </button>
            {tripMapDistance !== null && <span>Jednosmerne podľa mapy: {hoursLabel(tripMapDistance)} km</span>}
          </div>
          <div className="form-grid">
            <label className="field"><span>Celková vzdialenosť v km</span><input type="number" min="0.01" max="2000" step="0.01" value={tripDistance} onChange={(event) => {
              setTripDistance(event.target.value);
              setTripDistanceSource(tripMapDistance === null ? "MANUAL" : "MAP_EDITED");
            }} placeholder="Vypočítajte alebo zadajte ručne" required /></label>
            <label className="field"><span>Poznámka <small>voliteľné</small></span><input name="note" maxLength={2000} placeholder="Účel jazdy alebo doplňujúce informácie" /></label>
          </div>
          <p className="trip-map-notice">Pri výpočte odošleme zadané adresy službám OpenStreetMap Nominatim a OSRM na vyhľadanie miesta a cestnej trasy. Ak mapa zlyhá, kilometre možno zadať alebo opraviť ručne. Mapové údaje: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          {tripNotice && <p className="invite-success" role="status">{tripNotice}</p>}
          <div className="form-actions"><button className="button button-primary" disabled={busy || tripMapBusy}><Plus size={15} />{busy ? "Ukladám…" : "Uložiť jazdu"}</button></div>
        </form>
      </section>
      <section className="records-section">
        <div className="section-title-row">
          <div><h2><Clock3 size={17} /> Moje jazdy</h2><p>Spolu za mesiac: <strong>{hoursLabel(monthVehicleTrips.reduce((sum, trip) => sum + Number(trip.distance_km), 0))} km</strong></p></div>
          <label className="field history-month-field"><span>Mesiac</span><input type="month" value={tripMonth} max={localDateKey(new Date().toISOString()).slice(0, 7)} onChange={(event) => setTripMonth(event.target.value)} /></label>
        </div>
        {monthVehicleTrips.length === 0
          ? <div className="panel empty-state"><span className="soft-icon"><MapPin size={19} /></span><strong>Za tento mesiac tu nie sú jazdy</strong><p>Pridajte prvú jazdu na cestovný výkaz.</p></div>
          : <div className="trip-list">{monthVehicleTrips.map((trip) => {
            const order = workOrders.find((item) => item.id === trip.work_order_id);
            return <article className="panel trip-card" key={trip.id}>
              <div className="trip-card-heading"><strong>{dateLabel(`${trip.trip_date}T12:00:00`)}</strong><strong>{hoursLabel(Number(trip.distance_km))} km</strong></div>
              <p>{trip.origin} <ArrowRight size={14} /> {trip.destination}</p>
              <div className="trip-card-footer"><span>{trip.is_round_trip ? "Spiatočná jazda" : "Jednosmerná jazda"} · {trip.distance_source === "MANUAL" ? "Zadané ručne" : trip.distance_source === "MAP_EDITED" ? "Mapa · ručne upravené" : "OpenStreetMap"}</span>{order && <span>{order.title}</span>}</div>
              {trip.note && <small>{trip.note}</small>}
            </article>;
          })}</div>}
      </section>
    </section>
  );

  const renderReports = () => {
    const attendanceHours = filteredReportAttendanceShifts.reduce((sum, shift) => sum + attendanceDuration(
      shift,
      attendanceBreaks.filter((pause) => pause.shift_id === shift.id),
      attendanceNow,
      monthBounds(attendanceMonth).start.getTime(),
      monthBounds(attendanceMonth).end.getTime(),
    ), 0);
    const mileageTotal = filteredReportVehicleTrips.reduce((sum, trip) => sum + Number(trip.distance_km), 0);
    const selectedEmployeeName = reportEmployeeId === "ALL"
      ? "Všetci zamestnanci"
      : roster.find((member) => member.user_id === reportEmployeeId)?.full_name
        || roster.find((member) => member.user_id === reportEmployeeId)?.email
        || "Zamestnanec";
    return (
      <section className="content-page">
        <header className="dashboard-title-row">
          <div><span className="eyebrow">MESAČNÝ REPORT</span><h1>Exporty a reporty</h1><p>Vyberte jedného zamestnanca a druh údajov pre samostatný export.</p></div>
          <div className="report-heading-actions">
            <button className="button button-outline" onClick={exportMonthlyCsv}><Download size={16} /> Exportovať do Excelu (CSV)</button>
            <button className="button button-primary" onClick={printDataReport}><Printer size={16} /> Exportovať PDF</button>
          </div>
        </header>
        <section className="report-filter panel">
          <label className="field"><span>Obdobie reportu</span><input type="month" value={attendanceMonth} max={localDateKey(new Date().toISOString()).slice(0, 7)} onChange={(event) => setAttendanceMonth(event.target.value)} /></label>
          <label className="field"><span>Zamestnanec</span><select value={reportEmployeeId} onChange={(event) => setReportEmployeeId(event.target.value)}><option value="ALL">Všetci zamestnanci</option>{roster.filter((member) => member.role === "EMPLOYEE").map((member) => <option key={member.id} value={member.user_id}>{member.full_name || member.email}</option>)}</select></label>
          <label className="field"><span>Druh údajov</span><select value={reportDataType} onChange={(event) => {
            const value = event.target.value;
            if (value === "ALL" || value === "ATTENDANCE" || value === "TRIPS" || value === "WORK_ORDERS") setReportDataType(value);
          }}><option value="ALL">Všetky údaje</option><option value="ATTENDANCE">Dochádzka</option><option value="TRIPS">Výkazy jázd</option><option value="WORK_ORDERS">Výkazy zákaziek</option></select></label>
          <div><small>Odpracovaný čas</small><strong>{durationLabel(attendanceHours)}</strong></div>
          <div><small>Najazdené kilometre</small><strong>{hoursLabel(mileageTotal)} km</strong></div>
          <div><small>Výkazy zákaziek</small><strong>{filteredReportWorkOrders.length}</strong></div>
        </section>
        {reportDataType === "ALL" && <section className="records-section">
          <div className="section-title-row"><div><h2><Users size={17} /> Súhrn podľa zamestnanca</h2><p>{attendanceMonthLabel}</p></div><span className="count-pill">{filteredReportEmployeeSummary.length} zamestnancov</span></div>
          {filteredReportEmployeeSummary.length
            ? <div className="panel report-table-wrap"><table className="report-table"><thead><tr><th>Zamestnanec</th><th>Zmeny</th><th>Odpracovaný čas</th><th>Jazdy</th><th>Km</th><th>Výkazy</th></tr></thead><tbody>{filteredReportEmployeeSummary.map((summary) => <tr key={summary.member.id}>
              <td>{summary.member.full_name || summary.member.email}</td><td>{summary.shiftCount}</td><td>{durationLabel(summary.workedMilliseconds)}</td><td>{summary.tripCount}</td><td>{hoursLabel(summary.distanceKm)}</td><td>{summary.reportCount}</td>
            </tr>)}</tbody></table></div>
            : <div className="panel employee-hours-empty">Za vybraný mesiac nie sú údaje.</div>}
        </section>}
        {reportDataType === "ATTENDANCE" && <section className="records-section">
          <div className="section-title-row"><div><h2><Clock3 size={17} /> Dochádzka zamestnancov</h2><p>{attendanceMonthLabel}</p></div><span className="count-pill">{filteredReportAttendanceShifts.length} zmien</span></div>
          {filteredReportAttendanceShifts.length
            ? <div className="panel report-table-wrap"><table className="report-table"><thead><tr><th>Zamestnanec</th><th>Dátum</th><th>Od – do</th><th>Prestávky</th><th>Čistý čas</th></tr></thead><tbody>{filteredReportAttendanceShifts.map((shift) => {
              const member = roster.find((item) => item.user_id === shift.user_id);
              const pauses = attendanceBreaks.filter((pause) => pause.shift_id === shift.id);
              return <tr key={shift.id}><td>{member?.full_name || member?.email || ""}</td><td>{dateLabel(shift.started_at)}</td><td>{timeLabel(shift.started_at)} – {shift.ended_at ? timeLabel(shift.ended_at) : "Prebieha"}</td><td>{pauses.map((pause) => `${timeLabel(pause.started_at)}–${pause.ended_at ? timeLabel(pause.ended_at) : "prebieha"}`).join(", ") || "—"}</td><td>{durationLabel(attendanceDuration(shift, pauses, attendanceNow, monthBounds(attendanceMonth).start.getTime(), monthBounds(attendanceMonth).end.getTime()))}</td></tr>;
            })}</tbody></table></div>
            : <div className="panel employee-hours-empty">Za vybraný mesiac nie je dochádzka.</div>}
        </section>}
        {reportDataType !== "ATTENDANCE" && <section className="records-section">
          <div className="section-title-row"><div><h2><ClipboardList size={17} /> Súhrn podľa zákazky</h2><p>Kilometre viazané na zákazku a odovzdané výkazy.</p></div><span className="count-pill">{filteredReportOrderSummary.length} zákaziek</span></div>
          {filteredReportOrderSummary.length
            ? <div className="panel report-table-wrap"><table className="report-table"><thead><tr><th>Zákazka</th><th>Pracovník</th>{reportDataType !== "WORK_ORDERS" && <><th>Jazdy</th><th>Km</th></>}{reportDataType !== "TRIPS" && <th>Výkazy</th>}</tr></thead><tbody>{filteredReportOrderSummary.map((summary) => <tr key={summary.order.id}>
              <td>{summary.order.title}</td><td>{summary.employee?.full_name || summary.employee?.email || "Bývalý zamestnanec"}</td>{reportDataType !== "WORK_ORDERS" && <><td>{summary.tripCount}</td><td>{hoursLabel(summary.distanceKm)}</td></>}{reportDataType !== "TRIPS" && <td>{summary.reportCount}</td>}
            </tr>)}</tbody></table></div>
            : <div className="panel employee-hours-empty">V tomto mesiaci nie sú zákazky s výkazom ani priradenými jazdami.</div>}
        </section>
        {reportDataType !== "ATTENDANCE" && reportDataType !== "TRIPS" && <section className="records-section">
          <div className="section-title-row"><div><h2><ClipboardList size={17} /> Výkazy odovzdané v mesiaci</h2><p>Materiál a vykonaná práca zákaziek.</p></div><span className="count-pill">{filteredReportWorkOrders.length} výkazov</span></div>
          {filteredReportWorkOrders.length
            ? <div className="work-order-list">{filteredReportWorkOrders.map((order) => {
              const employee = roster.find((member) => member.user_id === order.assignee_id);
              return <article className="panel work-order-report-card" key={order.id}>
                <div><strong>{order.title}</strong><small>{employee?.full_name || employee?.email || "Bývalý zamestnanec"} · {dateLabel(order.updated_at)}</small></div>
                {order.employee_materials && <p><b>Použitý materiál:</b> {order.employee_materials}</p>}
                {order.work_report && <p><b>Výkaz práce:</b> {order.work_report}</p>}
                {order.employee_note && <p><b>Poznámka:</b> {order.employee_note}</p>}
              </article>;
            })}</div>
            : <div className="panel employee-hours-empty">Za tento mesiac neboli odovzdané pracovné výkazy.</div>}
        </section>
        }
      </section>
    );
  };

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
        <div className="plan-card-price"><strong>{activeMembership.company.plan === "PRO" ? "Pro" : "Free"}</strong><span>{activeMembership.company.plan === "PRO" ? "stav účtu" : "aktuálny účet"}</span></div>
        <p className="plan-card-note">Toto je aktuálny technický stav účtu. Platené predplatné ani automatická aktivácia zatiaľ nie sú zapnuté.</p>
      </section>}
      {activeMembership?.role === "OWNER" && <section className="pricing-proposal">
        <header className="pricing-proposal-heading">
          <div><span className="eyebrow">NA TESTOVANIE SO ZÁKAZNÍKMI</span><h2>Návrh balíkov a cien</h2></div>
          <p>Navrhované ceny na overenie záujmu. Nejde o potvrdený priemer slovenského trhu ani o aktuálne dostupné predplatné.</p>
        </header>
        <div className="pricing-proposal-grid">
          <article className="panel pricing-proposal-card">
            <div><span className="pricing-proposal-name">Basic</span><strong>19 €<small> / mes.</small></strong></div>
            <p>Zamestnanci, úlohy a základná evidencia.</p>
            <button className="button button-outline button-small" onClick={() => void createPaymentRequest("BASIC")} disabled={busy}>Zobraziť platobné údaje</button>
          </article>
          <article className="panel pricing-proposal-card pricing-proposal-featured">
            <div><span className="pricing-proposal-name">Pro</span><strong>39 €<small> / mes.</small></strong></div>
            <p>Dochádzka, výkazy, exporty a reporty.</p>
            <button className="button button-outline button-small" onClick={() => void createPaymentRequest("PRO")} disabled={busy}>Zobraziť platobné údaje</button>
          </article>
          <article className="panel pricing-proposal-card">
            <div><span className="pricing-proposal-name">Team</span><strong>69 €<small> / mes.</small></strong></div>
            <p>Viac tímov, zákazky, pokročilé reporty a oprávnenia.</p>
            <button className="button button-outline button-small" onClick={() => void createPaymentRequest("TEAM")} disabled={busy}>Zobraziť platobné údaje</button>
          </article>
        </div>
        {selectedPaymentRequest && <section className="panel payment-instructions">
          <div className="payment-instructions-copy">
            <span className="eyebrow">BANKOVÝ PREVOD · {PAYMENT_PLAN_DETAILS[selectedPaymentRequest.plan].name.toUpperCase()}</span>
            <h3>Dokončite platbu prevodom</h3>
            <p>Údaje z QR kódu si pred odoslaním skontrolujte v bankovej aplikácii.</p>
            <dl>
              <div><dt>Príjemca</dt><dd>{PAYMENT_BENEFICIARY}</dd></div>
              <div><dt>IBAN</dt><dd>{PAYMENT_IBAN}</dd></div>
              <div><dt>Suma za 1 mesiac</dt><dd>{Number(selectedPaymentRequest.amount_eur).toFixed(2).replace(".", ",")} €</dd></div>
              <div><dt>Variabilný symbol</dt><dd>{selectedPaymentRequest.variable_symbol}</dd></div>
              <div><dt>Správa</dt><dd>Workena {PAYMENT_PLAN_DETAILS[selectedPaymentRequest.plan].name}</dd></div>
            </dl>
            <p className="payment-pending-note">Ide o jednorazový prevod za jeden mesiac, nie o opakované strhávanie. Stav: {selectedPaymentRequest.status === "PENDING" ? "Čaká na ručné potvrdenie správcom Workena." : selectedPaymentRequest.status === "CONFIRMED" ? "Platba bola potvrdená správcom Workena." : "Žiadosť bola zamietnutá."} Vytvorenie QR kódu ani odoslanie prevodu automaticky nemení váš plán.</p>
          </div>
          <div className="payment-qr">
            <QRCodeSVG
              value={`SPD*1.0*ACC:${PAYMENT_IBAN}*AM:${Number(selectedPaymentRequest.amount_eur).toFixed(2)}*CC:EUR*X-VS:${selectedPaymentRequest.variable_symbol}*MSG:Workena ${PAYMENT_PLAN_DETAILS[selectedPaymentRequest.plan].name}*RN:${PAYMENT_BENEFICIARY}`}
              size={192}
              level="M"
              marginSize={4}
              title="QR platba Workena"
            />
            <span>QR platba (SPAYD)</span>
          </div>
        </section>}
        {paymentRequests.length > 0 && <div className="payment-request-list" aria-label="Žiadosti o platbu">
          <strong>Žiadosti o platbu</strong>
          {paymentRequests.map((request) => <button key={request.id} className={`payment-request-item ${request.id === selectedPaymentRequestId ? "active" : ""}`} onClick={() => setSelectedPaymentRequestId(request.id)}>
            <span>{PAYMENT_PLAN_DETAILS[request.plan].name} · VS {request.variable_symbol}</span>
            <span>{request.status === "PENDING" ? "Čaká na potvrdenie" : request.status === "CONFIRMED" ? "Potvrdená" : "Zamietnutá"}</span>
          </button>)}
        </div>}
        <p className="pricing-proposal-note">Ceny sú naďalej návrhom na testovanie, nie aktívnou ponukou. Platbu overuje správca Workena ručne; automatická aktivácia predplatného nie je zapnutá.</p>
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
          <button className={`nav-link ${page === "attendance" ? "active" : ""}`} onClick={() => { setPage("attendance"); setError(""); }}><Clock3 size={18} /> Dochádzka</button>
          <button className={`nav-link ${page === "workOrders" ? "active" : ""}`} onClick={() => { setPage("workOrders"); setError(""); setNotice(""); }}><ClipboardList size={18} /> Zákazky</button>
          <button className={`nav-link ${page === "trips" ? "active" : ""}`} onClick={() => { setPage("trips"); setError(""); setTripNotice(""); }}><MapPin size={18} /> Výkaz jázd</button>
          <button className={`nav-link ${page === "entry" ? "active" : ""}`} onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setPage("entry"); }}><ClipboardList size={18} /> Nový záznam</button>
          {isManager && <button className={`nav-link ${page === "reports" ? "active" : ""}`} onClick={() => { setPage("reports"); setError(""); }}><Download size={18} /> Exporty a reporty</button>}
          {isManager && <button className={`nav-link ${page === "team" ? "active" : ""}`} onClick={() => setPage("team")}><Users size={18} /> Tím</button>}
          {isManager && <button className={`nav-link ${page === "history" ? "active" : ""}`} onClick={() => setPage("history")}><History size={18} /> História</button>}
          <button className="nav-link" onClick={() => { window.location.hash = "obchodne-podmienky"; }}><ShieldCheck size={18} /> Obchodné podmienky</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row"><span className="avatar">{initials(profileName)}</span><span className="profile-name"><strong>{profileName}</strong><small>{activeMembership ? roleName(activeMembership.role) : "Bez firmy"}</small></span></div>
          <button className="logout-button" aria-label="Odhlásiť sa" onClick={() => void signOut()}><LogOut size={17} /></button>
        </div>
      </aside>
      <div className="main-area">
        <header className="mobile-top"><Brand /><span className="mobile-company">{activeMembership?.company.name}</span><a className="mobile-terms" href="#obchodne-podmienky">Podmienky</a><button className="logout-button" aria-label="Odhlásiť sa" onClick={() => void signOut()}><LogOut size={17} /></button></header>
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
          ) : page === "entry" ? renderEntryForm() : page === "attendance" ? renderAttendance() : page === "workOrders" ? renderWorkOrders() : page === "trips" ? renderTrips() : page === "reports" && isManager ? renderReports() : page === "team" ? renderTeam() : page === "history" && isManager ? renderHistory() : (
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
          <button className={`mobile-nav-link ${page === "attendance" ? "active" : ""}`} aria-current={page === "attendance" ? "page" : undefined} onClick={() => { setPage("attendance"); setError(""); }}>
            <Clock3 size={19} /><span>Dochádzka</span>
          </button>
          <button className={`mobile-nav-link ${page === "workOrders" ? "active" : ""}`} aria-current={page === "workOrders" ? "page" : undefined} onClick={() => { setPage("workOrders"); setError(""); setNotice(""); }}>
            <ClipboardList size={19} /><span>Zákazky</span>
          </button>
          <button className={`mobile-nav-link ${page === "trips" ? "active" : ""}`} aria-current={page === "trips" ? "page" : undefined} onClick={() => { setPage("trips"); setError(""); setTripNotice(""); }}>
            <MapPin size={19} /><span>Jazdy</span>
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
          {isManager && <button className={`mobile-nav-link ${page === "reports" ? "active" : ""}`} aria-current={page === "reports" ? "page" : undefined} onClick={() => setPage("reports")}>
            <Download size={19} /><span>Reporty</span>
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
      {isManager && <section className="print-report data-print-report">
        <header className="print-report-header"><span className="brand"><span className="brand-mark">w</span> workena</span><span>Dochádzka, jazdy a výkazy</span></header>
        <h1>Mesačný report — {attendanceMonthLabel} · {reportEmployeeId === "ALL" ? "všetci zamestnanci" : roster.find((member) => member.user_id === reportEmployeeId)?.full_name || roster.find((member) => member.user_id === reportEmployeeId)?.email} · {reportDataType === "ALL" ? "všetky údaje" : reportDataType === "ATTENDANCE" ? "dochádzka" : reportDataType === "TRIPS" ? "jazdy" : "výkazy zákaziek"}</h1>
        <p className="print-report-company">{activeMembership?.company.name} · Vygenerované {dateLabel(new Date().toISOString())}</p>
        <div className="data-print-total">
          {(reportDataType === "ALL" || reportDataType === "ATTENDANCE") && <strong>Odpracovaný čas: {durationLabel(filteredReportAttendanceShifts.reduce((sum, shift) => sum + attendanceDuration(shift, attendanceBreaks.filter((pause) => pause.shift_id === shift.id), attendanceNow, monthBounds(attendanceMonth).start.getTime(), monthBounds(attendanceMonth).end.getTime()), 0))}</strong>}
          {(reportDataType === "ALL" || reportDataType === "TRIPS") && <strong>Najazdené: {hoursLabel(filteredReportVehicleTrips.reduce((sum, trip) => sum + Number(trip.distance_km), 0))} km</strong>}
          {(reportDataType === "ALL" || reportDataType === "WORK_ORDERS") && <strong>Výkazy: {filteredReportWorkOrders.length}</strong>}
        </div>
        {reportDataType === "ALL" && <><h2>Súhrn podľa zamestnanca</h2>
        <table><thead><tr><th>Zamestnanec</th><th>Zmeny</th><th>Čas</th><th>Jazdy</th><th>Km</th><th>Výkazy</th></tr></thead><tbody>{filteredReportEmployeeSummary.map((summary) => <tr key={summary.member.id}>
          <td>{summary.member.full_name || summary.member.email}</td><td>{summary.shiftCount}</td><td>{durationLabel(summary.workedMilliseconds)}</td><td>{summary.tripCount}</td><td>{hoursLabel(summary.distanceKm)}</td><td>{summary.reportCount}</td>
        </tr>)}</tbody></table>
        </>}
        {reportDataType !== "ATTENDANCE" && <><h2>Súhrn podľa zákazky</h2>
        <table><thead><tr><th>Zákazka</th><th>Pracovník</th>{reportDataType !== "WORK_ORDERS" && <><th>Jazdy</th><th>Km</th></>}{reportDataType !== "TRIPS" && <th>Výkazy</th>}</tr></thead><tbody>{filteredReportOrderSummary.map((summary) => <tr key={summary.order.id}>
          <td>{summary.order.title}</td><td>{summary.employee?.full_name || summary.employee?.email || "Bývalý zamestnanec"}</td>{reportDataType !== "WORK_ORDERS" && <><td>{summary.tripCount}</td><td>{hoursLabel(summary.distanceKm)}</td></>}{reportDataType !== "TRIPS" && <td>{summary.reportCount}</td>}
        </tr>)}</tbody></table>
        </>}
        {(reportDataType === "ALL" || reportDataType === "ATTENDANCE") && <><h2>Dochádzka</h2>
        <table><thead><tr><th>Zamestnanec</th><th>Dátum</th><th>Od – do</th><th>Prestávky</th><th>Čistý čas</th></tr></thead><tbody>{filteredReportAttendanceShifts.map((shift) => {
          const member = roster.find((item) => item.user_id === shift.user_id);
          const pauses = attendanceBreaks.filter((pause) => pause.shift_id === shift.id);
          return <tr key={shift.id}><td>{member?.full_name || member?.email || ""}</td><td>{dateLabel(shift.started_at)}</td><td>{timeLabel(shift.started_at)} – {shift.ended_at ? timeLabel(shift.ended_at) : "Prebieha"}</td><td>{pauses.map((pause) => `${timeLabel(pause.started_at)}–${pause.ended_at ? timeLabel(pause.ended_at) : "prebieha"}`).join(", ")}</td><td>{durationLabel(attendanceDuration(shift, pauses, attendanceNow, monthBounds(attendanceMonth).start.getTime(), monthBounds(attendanceMonth).end.getTime()))}</td></tr>;
        })}</tbody></table>
        </>}
        {(reportDataType === "ALL" || reportDataType === "WORK_ORDERS") && <><h2>Výkazy a materiál</h2>
        {filteredReportWorkOrders.map((order) => {
          const employee = roster.find((item) => item.user_id === order.assignee_id);
          return <section className="data-print-details" key={order.id}>
            <strong>{order.title} · {employee?.full_name || employee?.email || ""}</strong>
            {order.employee_materials && <p>Použitý materiál: {order.employee_materials}</p>}
            {order.work_report && <p>Vykonaná práca: {order.work_report}</p>}
            {order.employee_note && <p>Poznámka: {order.employee_note}</p>}
          </section>;
        })}
        </>}
        {(reportDataType === "ALL" || reportDataType === "TRIPS") && <><h2>Výkaz jázd</h2>
        <table><thead><tr><th>Zamestnanec</th><th>Dátum</th><th>Zákazka</th><th>Trasa</th><th>Km</th></tr></thead><tbody>{filteredReportVehicleTrips.map((trip) => {
          const member = roster.find((item) => item.user_id === trip.user_id);
          const order = workOrders.find((item) => item.id === trip.work_order_id);
          return <tr key={trip.id}><td>{member?.full_name || member?.email || ""}</td><td>{trip.trip_date}</td><td>{order?.title ?? "—"}</td><td>{trip.origin} → {trip.destination}{trip.is_round_trip ? " (spiatočne)" : ""}</td><td>{hoursLabel(Number(trip.distance_km))}</td></tr>;
        })}</tbody></table>
        </>}
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
