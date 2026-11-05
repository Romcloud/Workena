import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Camera,
  CheckCircle2,
  CircleHelp,
  Clock3,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Coffee,
  Copy,
  Download,
  FileSpreadsheet,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  MapPin,
  MessageCircle,
  Navigation,
  Paperclip,
  Palmtree,
  Pencil,
  Phone,
  Plane,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Search,
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
import type { AbsenceRequest, AbsenceStatus, AbsenceType, AdminCompanyRow, AttendanceBreak, AttendanceShift, Company, CompanyJoinRequest, CompanyPlan, CompanySearchResult, Customer, CustomerStatus, EntryStatus, Membership, PaymentPlan, PaymentRequest, Photo, Role, VehicleTrip, WorkEntry, WorkOrder, WorkOrderAssignment, WorkOrderPhoto, WorkOrderStatus } from "./lib/types";
import { TermsOfService } from "./TermsOfService";
import { PrivacyPolicy } from "./PrivacyPolicy";
import { GOOGLE_SHEETS_APPS_SCRIPT } from "./lib/googleSheetsAppsScript";

type WorkspaceMembership = Membership & { company: Company };
type Page = "dashboard" | "attendance" | "workOrders" | "customers" | "trips" | "reports" | "team" | "history" | "profile" | "terms" | "privacy" | "admin";
type PhotoView = Photo & { url: string };
type GoogleCalendarDisplayEvent = {
  id: string;
  summary: string;
  description: string;
  location: string;
  htmlLink: string;
  workOrderId?: string | null;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
};
type GoogleSheetsConnectionStatus = {
  connected: boolean;
  configured: boolean;
  lastSyncAt: string | null;
  webAppUrl: string | null;
};

const PHOTO_BUCKET = "work-photos";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 10;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const WORK_ORDER_PHOTO_BUCKET = "work-order-photos";
const ABSENCE_ATTACHMENT_BUCKET = "absence-attachments";
const GOPAY_TEST_MODE = import.meta.env.VITE_GOPAY_TEST_MODE === "true";
const PAYMENT_IBAN = "SK5811000000002948309028";
const PAYMENT_BENEFICIARY = "Roman Chlebovec - ROVOLT";
const PAYMENT_PLAN_DETAILS: Record<PaymentPlan, { name: string; amount: number }> = {
  BASIC: { name: "Basic", amount: 19 },
  PRO: { name: "Pro", amount: 39 },
  TEAM: { name: "Team", amount: 69 },
};
const COMPANY_PLAN_LABELS: Record<CompanyPlan, string> = {
  FREE: "Free",
  BASIC: "Basic",
  PRO: "Pro",
  TEAM: "Team",
};
const PLAN_COMPANY_LIMIT: Record<CompanyPlan, number> = {
  FREE: 2,
  BASIC: 2,
  PRO: 3,
  TEAM: 5,
};
const PLAN_EMPLOYEE_LIMIT: Record<CompanyPlan, number | null> = {
  FREE: 2,
  BASIC: 10,
  PRO: 30,
  TEAM: null,
};
const PLAN_FEATURE_NOTES: Record<CompanyPlan, string> = {
  FREE: "Max. 2 zamestnanci, bez možnosti prideľovať zákazky.",
  BASIC: "Max. 10 zamestnancov, bez možnosti prideľovať zákazky.",
  PRO: "Max. 30 zamestnancov a možnosť prideľovať zákazky.",
  TEAM: "Neobmedzený počet zamestnancov, zákazky a všetky výhody.",
};

type WorkOrderPhotoView = WorkOrderPhoto & { url: string };
type WorkOrderPhotoFiles = Record<string, { BEFORE: File[]; AFTER: File[] }>;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Požiadavku sa nepodarilo dokončiť. Skúste to znova.";
}

async function functionErrorText(error: unknown) {
  if (error instanceof Error && "context" in error && error.context instanceof Response) {
    const responseText = await error.context.clone().text();
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return responseText || error.message;
    }
    if (typeof payload !== "object" || payload === null) return responseText || error.message;
    const body = payload as { error?: unknown; failures?: unknown };
    const message = typeof body.error === "string" ? body.error : error.message;
    const failures = Array.isArray(body.failures)
      ? body.failures.filter((failure): failure is string => typeof failure === "string")
      : [];
    return failures.length ? `${message} ${failures.join("; ")}` : message;
  }
  return errorText(error);
}

function googleSheetsErrorMessage(message: string) {
  if (/Unexpected token ['"]?</i.test(message) || /<!doctype html|<html[\s>]/i.test(message)) {
    return "Google vrátil prihlasovaciu alebo chybovú stránku namiesto odpovede skriptu. V Apps Scripte otvorte Nasadiť → Spravovať nasadenia → Upraviť (ceruzka), nastavte „Spúšťať ako: Ja“ a „Kto má prístup: Všetci (Anyone)“, vyberte „Nová verzia“ a kliknite Nasadiť. Potom skopírujte novú URL webovej aplikácie končiacu na /exec a nahraďte ňou URL vo Workene. Ak možnosť „Všetci (Anyone)“ chýba, musí ju povoliť správca Google Workspace.";
  }
  if (/Google Apps Script vrátil chybu (401|403)/.test(message)) {
    return "Google odmietol prístup k skriptu. V Apps Scripte otvorte Nasadiť → Spravovať nasadenia → Upraviť (ceruzka), nastavte „Spúšťať ako: Ja“ a „Kto má prístup: Všetci (Anyone)“, vyberte „Nová verzia“ a kliknite Nasadiť. Potom v Workene použite URL webovej aplikácie končiacu na /exec. Ak možnosť „Všetci (Anyone)“ chýba, blokuje ju nastavenie Google Workspace.";
  }
  return message;
}

type EmailTemplate = "company_welcome" | "company_join_request" | "license_requested" | "payment_confirmed" | "payment_reminder" | "admin_custom" | "maintenance_notice";

async function sendTransactionalEmail(
  client: typeof supabase,
  template: EmailTemplate,
  to: string,
  data: Record<string, string | number | undefined>,
) {
  if (!client || !to) return;
  try {
    await client.functions.invoke("send-email", { body: { template, to, data } });
  } catch {
    // Email delivery is best-effort and should never block the main action.
  }
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

function googleCalendarEventDateRange(event: GoogleCalendarDisplayEvent) {
  const start = event.start.date ?? (event.start.dateTime ? localDateKey(event.start.dateTime) : "");
  const endDate = event.end.date ?? (event.end.dateTime ? localDateKey(new Date(new Date(event.end.dateTime).getTime() - 1)) : start);
  if (event.end.date) {
    return { start, end: previousCalendarDate(endDate) };
  }
  return { start, end: endDate };
}

function googleCalendarEventTime(event: GoogleCalendarDisplayEvent) {
  if (event.start.date) return "Celý deň";
  if (!event.start.dateTime) return "";
  const formatTime = (value: string) => new Intl.DateTimeFormat("sk-SK", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  return `${formatTime(event.start.dateTime)} – ${event.end.dateTime ? formatTime(event.end.dateTime) : "—"}`;
}

function previousCalendarDate(day: string) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return localDateKey(date);
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
  return role === "OWNER" ? "Vlastník" : role === "MANAGER" ? "Vedúci" : role === "ACCOUNTANT" ? "Účtovník" : "Zamestnanec";
}

function statusName(status: EntryStatus) {
  return status === "APPROVED" ? "Schválené" : status === "REJECTED" ? "Vrátené" : "Čaká na kontrolu";
}

function workOrderStatusName(status: WorkOrderStatus) {
  return status === "DONE"
    ? "Dokončené"
    : status === "WORKING"
      ? "Pracuje sa"
      : status === "MEASURED"
        ? "Zamerané"
        : status === "IN_PROGRESS"
          ? "Rozpracované"
          : "Pridelené";
}

function customerStatusName(status: CustomerStatus) {
  return status === "APPROVED" ? "Schválená" : status === "REJECTED" ? "Zamietnutá" : "Bez odpovede";
}

const ABSENCE_TYPE_LABELS: Record<AbsenceType, string> = {
  VACATION: "Dovolenka",
  HOME_OFFICE: "Home office",
  OUT_OF_OFFICE: "Mimo práce",
  OTHER: "Iné",
};

const ABSENCE_TYPE_ICONS: Record<AbsenceType, typeof Palmtree> = {
  VACATION: Palmtree,
  HOME_OFFICE: Home,
  OUT_OF_OFFICE: Plane,
  OTHER: CircleHelp,
};

function absenceStatusName(status: AbsenceStatus) {
  return status === "APPROVED" ? "Schválené" : status === "REJECTED" ? "Zamietnuté" : status === "CANCELLED" ? "Zrušené" : "Čaká na schválenie";
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

async function openStreetMapMultiLegDistance(points: string[]) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    if (index > 0) await sleep(1100);
    total += await openStreetMapRoadDistance(points[index], points[index + 1]);
  }
  return Math.round(total * 100) / 100;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [companyJoinMode, setCompanyJoinMode] = useState<"create" | "join">("create");
  const [companySearchName, setCompanySearchName] = useState("");
  const [companySearchResults, setCompanySearchResults] = useState<CompanySearchResult[]>([]);
  const [joinRequests, setJoinRequests] = useState<CompanyJoinRequest[]>([]);
  const [entries, setEntries] = useState<WorkEntry[]>([]);
  const [roster, setRoster] = useState<Membership[]>([]);
  const [attendanceShifts, setAttendanceShifts] = useState<AttendanceShift[]>([]);
  const [attendanceBreaks, setAttendanceBreaks] = useState<AttendanceBreak[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [workOrderPhotos, setWorkOrderPhotos] = useState<WorkOrderPhotoView[]>([]);
  const [pendingWorkOrderPhotos, setPendingWorkOrderPhotos] = useState<WorkOrderPhotoFiles>({});
  const [vehicleTrips, setVehicleTrips] = useState<VehicleTrip[]>([]);
  const [absenceRequests, setAbsenceRequests] = useState<AbsenceRequest[]>([]);
  const [absenceType, setAbsenceType] = useState<AbsenceType>("VACATION");
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [selectedPaymentRequestId, setSelectedPaymentRequestId] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [adminCompanies, setAdminCompanies] = useState<AdminCompanyRow[]>([]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminNotice, setAdminNotice] = useState("");
  const [tripMonth, setTripMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [tripOrigin, setTripOrigin] = useState("");
  const [tripDestination, setTripDestination] = useState("");
  const [tripRoundTrip, setTripRoundTrip] = useState(false);
  const [tripDistance, setTripDistance] = useState("");
  const [tripMapDistance, setTripMapDistance] = useState<number | null>(null);
  const [tripDistanceSource, setTripDistanceSource] = useState<"MAP" | "MANUAL" | "MAP_EDITED">("MANUAL");
  const [tripMapBusy, setTripMapBusy] = useState(false);
  const [tripNotice, setTripNotice] = useState("");
  const [tripStops, setTripStops] = useState<string[]>([]);
  const [tripReturnDestination, setTripReturnDestination] = useState("");
  const [tripDifferentReturn, setTripDifferentReturn] = useState(false);
  const [attendanceMonth, setAttendanceMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [workOrderMonth, setWorkOrderMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [reportEmployeeId, setReportEmployeeId] = useState("ALL");
  const [reportDataType, setReportDataType] = useState<"ALL" | "ATTENDANCE" | "TRIPS" | "WORK_ORDERS">("ALL");
  const [attendanceNow, setAttendanceNow] = useState(Date.now());
  const [page, setPage] = useState<Page>(() => {
    if (window.location.hash === "#obchodne-podmienky") return "terms";
    if (window.location.hash === "#ochrana-osobnych-udajov") return "privacy";
    const savedPage = window.localStorage.getItem("workena-page");
    const pages: Page[] = ["dashboard", "attendance", "workOrders", "customers", "trips", "reports", "team", "history", "profile", "terms", "privacy", "admin"];
    return pages.includes(savedPage as Page) ? savedPage as Page : "dashboard";
  });
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOwnerId, setCustomerOwnerId] = useState("ALL");
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [expandedWorkOrderId, setExpandedWorkOrderId] = useState<string | null>(null);
  const [workOrderTab, setWorkOrderTab] = useState("SENT");
  const [workOrderSort, setWorkOrderSort] = useState<"DUE" | "ASSIGNED">("DUE");
  const [workOrderDateFilter, setWorkOrderDateFilter] = useState("");
  const [showWorkOrderForm, setShowWorkOrderForm] = useState(false);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<string[]>([""]);
  const [expandedDashboardOrderId, setExpandedDashboardOrderId] = useState<string | null>(null);
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [calendarEmployeeFilter, setCalendarEmployeeFilter] = useState("ALL");
  const [selectedCalendarOrder, setSelectedCalendarOrder] = useState<WorkOrder | null>(null);
  const [selectedGoogleCalendarEvent, setSelectedGoogleCalendarEvent] = useState<GoogleCalendarDisplayEvent | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingAttendanceShift, setEditingAttendanceShift] = useState<{ id: string; startedAt: string; endedAt: string } | null>(null);
  const [showLunchBreakPrompt, setShowLunchBreakPrompt] = useState(false);
  const [editingScheduleOrderId, setEditingScheduleOrderId] = useState<string | null>(null);
  const [profileFullName, setProfileFullName] = useState("");
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<WorkEntry | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<File[]>([]);
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [attendanceEmployeeFilter, setAttendanceEmployeeFilter] = useState("ALL");
  const [newMemberType, setNewMemberType] = useState("EMPLOYEE");
  const [pendingAbsenceAttachment, setPendingAbsenceAttachment] = useState<File | null>(null);
  const [previewPlan, setPreviewPlan] = useState<PaymentPlan | "">("");
  const [gopayTestMessage, setGopayTestMessage] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [billingName, setBillingName] = useState("");
  const [billingIco, setBillingIco] = useState("");
  const [billingDic, setBillingDic] = useState("");
  const [billingIcDph, setBillingIcDph] = useState("");
  const [billingAddress, setBillingAddress] = useState("");
  const [adminEmailTargetId, setAdminEmailTargetId] = useState<string | null>(null);
  const [adminMaintenanceOpen, setAdminMaintenanceOpen] = useState(false);
  const [historyMonth, setHistoryMonth] = useState(() => localDateKey(new Date().toISOString()).slice(0, 7));
  const [googleCalendarConnected, setGoogleCalendarConnected] = useState(false);
  const [googleCalendarBusy, setGoogleCalendarBusy] = useState(false);
  const [googleCalendarLastSync, setGoogleCalendarLastSync] = useState("");
  const [googleCalendarMessage, setGoogleCalendarMessage] = useState("");
  const [googleCalendarEvents, setGoogleCalendarEvents] = useState<GoogleCalendarDisplayEvent[]>([]);
  const [googleCalendarEventsMonth, setGoogleCalendarEventsMonth] = useState("");
  const [googleCalendarEventsLoading, setGoogleCalendarEventsLoading] = useState(false);
  const [googleCalendarEventsError, setGoogleCalendarEventsError] = useState("");
  const [googleSheetsConnection, setGoogleSheetsConnection] = useState<GoogleSheetsConnectionStatus | null>(null);
  const [googleSheetsBusy, setGoogleSheetsBusy] = useState(false);
  const [googleSheetsWebAppUrl, setGoogleSheetsWebAppUrl] = useState("");
  const [googleSheetsSecret, setGoogleSheetsSecret] = useState("");
  const [googleSheetsError, setGoogleSheetsError] = useState("");
  const [googleSheetsMessage, setGoogleSheetsMessage] = useState("");
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attendanceRequest = useRef(0);
  const authUserId = useRef<string | null>(null);
  const workOrderRequest = useRef(0);
  const workOrdersCompany = useRef("");
  const workOrderPhotosRequest = useRef(0);
  const vehicleTripsRequest = useRef(0);
  const absenceRequestsRequest = useRef(0);
  const adminCompaniesRequest = useRef(0);

  useEffect(() => {
    window.localStorage.setItem("workena-page", page);
  }, [page]);

  useEffect(() => {
    const updateAttendanceClock = () => setAttendanceNow(Date.now());
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") updateAttendanceClock();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", updateAttendanceClock);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", updateAttendanceClock);
    };
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash === "#obchodne-podmienky") setPage("terms");
      else if (window.location.hash === "#ochrana-osobnych-udajov") setPage("privacy");
      else setPage((current) => current === "terms" || current === "privacy" ? "dashboard" : current);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const activeMembership = memberships.find((membership) => membership.company_id === companyId) ?? memberships[0];
  const activeCompanyId = activeMembership?.company_id ?? "";
  const isManager = activeMembership?.role === "OWNER" || activeMembership?.role === "MANAGER";
  const isCompanyOwner = activeMembership?.role === "OWNER";
  const isEmployeeUser = activeMembership?.role === "EMPLOYEE" || activeMembership?.is_employee === true;
  const isExternalEmployee = Boolean(activeMembership?.is_external);
  const attendanceBreakThresholdMs = activeMembership?.is_minor ? 4.5 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const canAccessCustomers = isCompanyOwner || activeMembership?.is_salesperson === true;
  const canManageAttendance = isManager || activeMembership?.role === "ACCOUNTANT";
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const visibleCustomers = useMemo(() => {
    const query = customerSearch.trim().toLocaleLowerCase("sk");
    return customers.filter((customer) =>
      (isCompanyOwner ? customerOwnerId === "ALL" || customer.salesperson_id === customerOwnerId : customer.salesperson_id === session?.user.id)
      && (!query || [
        customer.full_name,
        customer.location,
        customer.lead_source,
        customer.product,
        customer.contact_details,
      ].some((value) => value.toLocaleLowerCase("sk").includes(query))),
    );
  }, [customerOwnerId, customerSearch, customers, isCompanyOwner, session?.user.id]);
  const selectedPaymentRequest = paymentRequests.find((request) => request.id === selectedPaymentRequestId) ?? null;
  const profileName =
    session?.user.user_metadata.full_name ??
    session?.user.user_metadata.name ??
    session?.user.email?.split("@")[0] ??
    "Používateľ";
  const client = supabase;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!GOPAY_TEST_MODE || params.get("gopay_test") !== "return") return;
    setPage("profile");

    const orderNumber = params.get("order_number");
    if (!orderNumber) {
      setGopayTestMessage("Návrat z testovacej platby nemá číslo objednávky.");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (!client || !session) return;

    let active = true;
    void client.functions.invoke<{ status: string }>("gopay-test", {
      body: { action: "status", orderNumber },
    }).then(({ data, error: paymentError }) => {
      if (!active) return;
      setGopayTestMessage(paymentError
        ? `Stav testovacej platby sa nepodarilo overiť: ${paymentError.message}`
        : data?.status === "PAID"
          ? "Prvá testovacia platba GoPay bola úspešne dokončená. Mesačné opakovanie bolo odoslané iba do sandboxu; licencia ani produkčné predplatné sa neaktivovali."
          : `Prvá testovacia GoPay platba má stav: ${data?.status ?? "neznámy"}. Licencia ani produkčné predplatné sa neaktivovali.`);
      window.history.replaceState({}, "", window.location.pathname);
    }).catch((paymentError: unknown) => {
      if (!active) return;
      setGopayTestMessage(`Stav testovacej platby sa nepodarilo overiť: ${errorText(paymentError)}`);
      window.history.replaceState({}, "", window.location.pathname);
    });

    return () => {
      active = false;
    };
  }, [client, session]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!client || !session || !activeCompanyId || !activeMembership?.active || params.get("google_calendar") !== "connect") return;
    if (!session.provider_token || !session.provider_refresh_token) {
      setGoogleCalendarMessage("Google neposkytol obnovovací token. Skúste pripojenie zopakovať a potvrďte požadované prístupy.");
      return;
    }

    let alive = true;
    setGoogleCalendarBusy(true);
    void client.functions.invoke<{ connected: boolean }>("google-calendar", {
      body: {
        action: "connect",
        companyId: activeCompanyId,
        accessToken: session.provider_token,
        refreshToken: session.provider_refresh_token,
      },
    }).then(async ({ data, error: connectionError }) => {
      if (!alive) return;
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete("google_calendar");
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      if (connectionError) {
        setGoogleCalendarMessage(await functionErrorText(connectionError));
        return;
      }
      if (!data?.connected) {
        setGoogleCalendarMessage("Google Kalendár sa nepodarilo pripojiť.");
        return;
      }
      setGoogleCalendarConnected(true);
      setGoogleCalendarMessage("Google Kalendár je prepojený. Zmeny sa synchronizujú automaticky.");
    }).finally(() => {
      if (alive) setGoogleCalendarBusy(false);
    });
    return () => { alive = false; };
  }, [activeCompanyId, activeMembership?.active, client, session]);

  useEffect(() => {
    if (!client || !session || !activeCompanyId || !activeMembership?.active) {
      setGoogleCalendarConnected(false);
      setGoogleCalendarLastSync("");
      return;
    }
    if (new URLSearchParams(window.location.search).get("google_calendar") === "connect") return;

    let alive = true;
    void client.functions.invoke<{ connected: boolean; lastSyncAt?: string | null }>("google-calendar", {
      body: { action: "status", companyId: activeCompanyId },
    }).then(async ({ data, error: statusError }) => {
      if (!alive) return;
      if (statusError) {
        setGoogleCalendarMessage(await functionErrorText(statusError));
        return;
      }
      setGoogleCalendarConnected(Boolean(data?.connected));
      setGoogleCalendarLastSync(data?.lastSyncAt ?? "");
    });
    return () => { alive = false; };
  }, [activeCompanyId, activeMembership?.active, client, session]);

  useEffect(() => {
    if (!client || !session || !activeCompanyId || !activeMembership?.active || !googleCalendarConnected || page !== "workOrders") {
      setGoogleCalendarEvents([]);
      setGoogleCalendarEventsMonth("");
      setGoogleCalendarEventsLoading(false);
      setGoogleCalendarEventsError("");
      return;
    }

    let alive = true;
    let requestInProgress = false;
    setGoogleCalendarEventsMonth("");
    setGoogleCalendarEventsLoading(true);
    setGoogleCalendarEventsError("");
    const loadEvents = async () => {
      if (requestInProgress) return;
      requestInProgress = true;
      try {
        const { data, error: eventsError } = await client.functions.invoke<{ events?: GoogleCalendarDisplayEvent[] }>("google-calendar", {
          body: { action: "events", companyId: activeCompanyId, month: workOrderMonth },
        });
        if (eventsError) throw new Error(await functionErrorText(eventsError));
        if (!Array.isArray(data?.events)) throw new Error("Google Kalendár nevrátil platný zoznam udalostí.");
        if (!alive) return;
        setGoogleCalendarEvents(data.events);
        setGoogleCalendarEventsMonth(workOrderMonth);
        setGoogleCalendarEventsError("");
      } catch (reason: unknown) {
        if (alive) setGoogleCalendarEventsError(errorText(reason));
      } finally {
        requestInProgress = false;
        if (alive) setGoogleCalendarEventsLoading(false);
      }
    };
    void loadEvents();
    const interval = window.setInterval(() => void loadEvents(), 60_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadEvents();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      alive = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeCompanyId, activeMembership?.active, client, googleCalendarConnected, page, session, workOrderMonth]);

  useEffect(() => {
    if (activeCompanyId) window.localStorage.setItem("workena-company", activeCompanyId);
  }, [activeCompanyId]);

  useEffect(() => {
    setProfileFullName(profileName);
    setBillingName(activeMembership?.company.billing_name ?? "");
    setBillingIco(activeMembership?.company.billing_ico ?? "");
    setBillingDic(activeMembership?.company.billing_dic ?? "");
    setBillingIcDph(activeMembership?.company.billing_ic_dph ?? "");
    setBillingAddress(activeMembership?.company.billing_address ?? "");
  }, [activeCompanyId, profileName, activeMembership?.company.selected_plan, activeMembership?.company.billing_name, activeMembership?.company.billing_ico, activeMembership?.company.billing_dic, activeMembership?.company.billing_ic_dph, activeMembership?.company.billing_address]);

  useEffect(() => {
    if (!client) {
      setAuthReady(true);
      return;
    }

    let alive = true;
    const { data } = client.auth.onAuthStateChange((event, nextSession) => {
      const previousUserId = authUserId.current;
      const nextUserId = nextSession?.user.id ?? null;
      authUserId.current = nextUserId;
      setSession(nextSession);
      const signedOut = event === "SIGNED_OUT";
      const switchedUser = event === "SIGNED_IN" && previousUserId !== null && nextUserId !== previousUserId;
      if (!signedOut && !switchedUser) return;
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
      setIsPlatformAdmin(false);
      setAdminCompanies([]);
      workOrdersCompany.current = "";
      workOrderRequest.current += 1;
      workOrderPhotosRequest.current += 1;
      setSelectedId(null);
      setPage(window.location.hash === "#obchodne-podmienky" ? "terms" : "dashboard");
    });
    void client.auth.getSession().then(({ data: sessionData, error: sessionError }) => {
      if (!alive) return;
      if (sessionError) setError(sessionError.message);
      authUserId.current = sessionData.session?.user.id ?? null;
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
      const invitationId = new URLSearchParams(window.location.search).get("invite");
      if (invitationId) {
        const { data: invitedCompanyId, error: invitationError } = await client.rpc("claim_company_invitation", {
          p_invitation_id: invitationId,
        });
        if (!alive) return;
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.delete("invite");
        window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
        if (invitationError) {
          setError(invitationError.message);
        } else if (invitedCompanyId) {
          window.localStorage.setItem("workena-company", invitedCompanyId);
          setNotice("Pozvanie bolo prijaté. Ste členom firemného tímu.");
        }
      }

      const { data: memberRows, error: memberError } = await client
        .from("memberships")
        .select("id, company_id, user_id, email, full_name, role, is_employee, is_salesperson, is_external, is_minor, active, deactivated_at, created_at")
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
      const activeCompanyIds = [...new Set(memberList.filter((member) => member.active).map((member) => member.company_id))];
      const trialSyncResults = await Promise.all(activeCompanyIds.map((companyId) =>
        client.rpc("sync_company_pro_trial", { p_company_id: companyId }),
      ));
      if (!alive) return;
      const trialSyncError = trialSyncResults.find((result) => result.error)?.error;
      if (trialSyncError) {
        setError(trialSyncError.message);
        return;
      }
      const { data: companyRows, error: companyError } = await client
        .from("companies")
        .select("id, name, plan, pro_trial_started_at, pro_trial_ends_at, selected_plan, billing_name, billing_ico, billing_dic, billing_ic_dph, billing_address")
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
      const savedCompanyId = window.localStorage.getItem("workena-company");
      setCompanyId((current) =>
        workspaces.some((membership) => membership.company_id === current)
          ? current
          : workspaces.some((membership) => membership.company_id === savedCompanyId)
            ? savedCompanyId ?? ""
          : workspaces[0]?.company_id ?? "",
      );
    })();

    return () => {
      alive = false;
    };
  }, [client, session]);

  useEffect(() => {
    const trialEndsAt = activeMembership?.company.pro_trial_ends_at;
    if (!client || !activeCompanyId || !activeMembership?.active || !trialEndsAt) return;

    let alive = true;
    const refreshAtExpiry = async () => {
      const { error: syncError } = await client.rpc("sync_company_pro_trial", {
        p_company_id: activeCompanyId,
      });
      if (!alive) return;
      if (syncError) {
        setError(syncError.message);
        return;
      }
      const { data, error: companyError } = await client
        .from("companies")
        .select("plan, pro_trial_started_at, pro_trial_ends_at")
        .eq("id", activeCompanyId)
        .single();
      if (!alive) return;
      if (companyError) {
        setError(companyError.message);
        return;
      }
      setMemberships((current) => current.map((membership) =>
        membership.company_id === activeCompanyId
          ? { ...membership, company: { ...membership.company, ...data } }
          : membership,
      ));
    };

    const timeout = window.setTimeout(
      () => void refreshAtExpiry(),
      Math.max(0, new Date(trialEndsAt).getTime() - Date.now() + 1000),
    );
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [activeCompanyId, activeMembership?.active, activeMembership?.company.pro_trial_ends_at, client]);

  useEffect(() => {
    if (!client || !activeCompanyId || !isManager) {
      setJoinRequests([]);
      return;
    }
    let alive = true;
    void client
      .from("company_join_requests")
      .select("id, company_id, user_id, email, full_name, status, created_at")
      .eq("company_id", activeCompanyId)
      .eq("status", "PENDING")
      .order("created_at", { ascending: true })
      .then(({ data, error: requestsError }) => {
        if (!alive) return;
        if (requestsError) {
          setError(requestsError.message);
          return;
        }
        setJoinRequests((data ?? []) as CompanyJoinRequest[]);
      });
    return () => { alive = false; };
  }, [activeCompanyId, client, isManager]);

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
        .select("id, company_id, user_id, email, full_name, role, is_employee, is_salesperson, is_external, is_minor, active, deactivated_at, created_at")
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
    if (session?.user.email) {
      void sendTransactionalEmail(client, "license_requested", session.user.email, {
        companyName: activeMembership?.company.name ?? "",
        planName: PAYMENT_PLAN_DETAILS[plan].name,
        amount: PAYMENT_PLAN_DETAILS[plan].amount.toFixed(2).replace(".", ","),
        variableSymbol: request.variable_symbol,
      });
    }
  };

  const startGoPayTestPayment = async (plan: PaymentPlan) => {
    if (!client || !activeCompanyId) return;
    setError("");
    setBusy(true);
    const { data, error: paymentError } = await client.functions.invoke<{ paymentUrl: string }>("gopay-test", {
      body: { action: "create", companyId: activeCompanyId, plan },
    });
    setBusy(false);
    if (paymentError) {
      setError(paymentError.message);
      return;
    }
    if (!data?.paymentUrl) {
      setError("GoPay testovacia platba nevrátila odkaz na platobnú bránu.");
      return;
    }
    window.location.assign(data.paymentUrl);
  };

  const startProTrial = async () => {
    if (!client || !activeCompanyId || !isCompanyOwner || !activeMembership?.active) return;
    setError("");
    setNotice("");
    setBusy(true);
    const { error: trialError } = await client.rpc("start_company_pro_trial", {
      p_company_id: activeCompanyId,
    });
    if (trialError) {
      setError(trialError.message);
      setBusy(false);
      return;
    }

    const { data, error: companyError } = await client
      .from("companies")
      .select("plan, pro_trial_started_at, pro_trial_ends_at")
      .eq("id", activeCompanyId)
      .single();
    if (companyError) {
      setError(companyError.message);
    } else {
      setMemberships((current) => current.map((membership) =>
        membership.company_id === activeCompanyId
          ? { ...membership, company: { ...membership.company, ...data } }
          : membership,
      ));
      setNotice("Skúšobná verzia Workena Pro je aktívna 30 dní. Po jej skončení sa firma automaticky vráti na Free.");
    }
    setBusy(false);
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
    const orders = (data ?? []) as WorkOrder[];
    if (orders.length === 0) {
      setWorkOrders([]);
      return;
    }
    const { data: assignmentRows, error: assignmentError } = await client
      .from("work_order_assignees")
      .select("work_order_id, company_id, user_id, accepted_at, declined_at, reassigned_at, created_at")
      .in("work_order_id", orders.map((order) => order.id));
    if (request !== workOrderRequest.current) return;
    if (assignmentError) throw assignmentError;
    const assignments = (assignmentRows ?? []) as WorkOrderAssignment[];
    setWorkOrders(orders.map((order) => ({
      ...order,
      assignees: assignments.filter((assignment) => assignment.work_order_id === order.id),
    })));
  }, [activeCompanyId, client]);

  const syncGoogleCalendarNow = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const { data, error: syncError } = await client.functions.invoke<{ syncedAt?: string; skipped?: boolean }>("google-calendar", {
      body: { action: "sync", companyId: activeCompanyId },
    });
    if (syncError) throw new Error(await functionErrorText(syncError));
    if (data?.skipped) {
      setGoogleCalendarMessage("Synchronizácia už prebieha.");
      return;
    }
    if (!data?.syncedAt) throw new Error("Google Kalendár nepotvrdil synchronizáciu.");
    setGoogleCalendarLastSync(data.syncedAt);
    setGoogleCalendarMessage("");
    await refreshWorkOrders();
  }, [activeCompanyId, client, refreshWorkOrders]);

  useEffect(() => {
    if (!client || !session || !activeCompanyId || !activeMembership?.active || !googleCalendarConnected) return;
    let alive = true;
    const syncCalendar = async () => {
      try {
        await syncGoogleCalendarNow();
      } catch (reason: unknown) {
        if (alive) setGoogleCalendarMessage(errorText(reason));
      }
    };
    void syncCalendar();
    const interval = window.setInterval(() => void syncCalendar(), 60_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void syncCalendar();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      alive = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeCompanyId, activeMembership?.active, client, googleCalendarConnected, session, syncGoogleCalendarNow]);

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

  const refreshAbsenceRequests = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const request = ++absenceRequestsRequest.current;
    const { data, error: absenceError } = await client
      .from("absence_requests")
      .select("*")
      .eq("company_id", activeCompanyId)
      .order("start_date", { ascending: true });
    if (request !== absenceRequestsRequest.current) return;
    if (absenceError) throw absenceError;
    setAbsenceRequests((data ?? []) as AbsenceRequest[]);
  }, [activeCompanyId, client]);

  const refreshCustomers = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const { data, error: customerError } = await client
      .from("customers")
      .select("*")
      .eq("company_id", activeCompanyId)
      .order("customer_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (customerError) throw customerError;
    setCustomers((data ?? []) as Customer[]);
  }, [activeCompanyId, client]);

  const refreshAdminCompanies = useCallback(async () => {
    if (!client || !isPlatformAdmin) {
      setAdminCompanies([]);
      return;
    }
    const request = ++adminCompaniesRequest.current;
    const { data, error: adminListError } = await client.rpc("admin_list_companies");
    if (request !== adminCompaniesRequest.current) return;
    if (adminListError) throw adminListError;
    setAdminCompanies((data ?? []) as AdminCompanyRow[]);
  }, [client, isPlatformAdmin]);

  const refreshAttendance = useCallback(async () => {
    if (!client || !activeCompanyId) return;
    const request = ++attendanceRequest.current;
    const monthStart = new Date(`${attendanceMonth}-01T00:00:00`);
    const nextMonthStart = new Date(monthStart);
    nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
    const [{ data: monthRows, error: monthError }, { data: openRows, error: openError }] = await Promise.all([
      client
        .from("attendance_shifts")
        .select("id, company_id, user_id, started_at, ended_at, source_work_entry_id, note")
        .eq("company_id", activeCompanyId)
        .lt("started_at", nextMonthStart.toISOString())
        .or(`ended_at.is.null,ended_at.gt.${monthStart.toISOString()}`)
        .order("started_at", { ascending: false }),
      client
        .from("attendance_shifts")
        .select("id, company_id, user_id, started_at, ended_at, source_work_entry_id, note")
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
    void refreshWorkOrders().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshWorkOrders]);

  useEffect(() => {
    void refreshWorkOrderPhotos().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshWorkOrderPhotos]);

  useEffect(() => {
    void refreshVehicleTrips().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshVehicleTrips]);

  useEffect(() => {
    void refreshAbsenceRequests().catch((reason: unknown) => setError(errorText(reason)));
  }, [refreshAbsenceRequests]);

  useEffect(() => {
    if (!canAccessCustomers) {
      setCustomers([]);
      return;
    }
    void refreshCustomers().catch((reason: unknown) => setError(errorText(reason)));
  }, [canAccessCustomers, refreshCustomers]);

  useEffect(() => {
    if (!client || !session || !activeCompanyId || !activeMembership?.active || !activeMembership.is_salesperson) {
      setGoogleSheetsConnection(null);
      setGoogleSheetsWebAppUrl("");
      setGoogleSheetsSecret("");
      setGoogleSheetsError("");
      setGoogleSheetsMessage("");
      return;
    }
    let alive = true;
    setGoogleSheetsError("");
    setGoogleSheetsMessage("");
    void client.functions.invoke<GoogleSheetsConnectionStatus>("google-sheets-sync", {
      body: { action: "status", companyId: activeCompanyId },
    }).then(async ({ data, error: statusError }) => {
      if (!alive) return;
      if (statusError) {
        setGoogleSheetsError(googleSheetsErrorMessage(await functionErrorText(statusError)));
        return;
      }
      setGoogleSheetsError("");
      setGoogleSheetsConnection(data ?? null);
      setGoogleSheetsWebAppUrl(data?.webAppUrl ?? "");
    }).catch((reason: unknown) => {
      if (alive) setGoogleSheetsError(googleSheetsErrorMessage(errorText(reason)));
    });
    return () => { alive = false; };
  }, [activeCompanyId, activeMembership?.active, activeMembership?.is_salesperson, client, session]);

  useEffect(() => {
    if (!client || !session) {
      setIsPlatformAdmin(false);
      return;
    }
    let alive = true;
    void client.rpc("is_platform_admin").then(({ data, error: adminCheckError }) => {
      if (!alive) return;
      if (adminCheckError) return;
      setIsPlatformAdmin(Boolean(data));
    });
    return () => {
      alive = false;
    };
  }, [client, session]);

  useEffect(() => {
    void refreshAdminCompanies().catch((reason: unknown) => setAdminError(errorText(reason)));
  }, [refreshAdminCompanies]);

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

  const signIn = async (selectAccount = false) => {
    if (!client) return;
    setBusy(true);
    setError("");
    const { error: signInError } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
        ...(selectAccount ? { queryParams: { prompt: "select_account" } } : {}),
      },
    });
    if (signInError) {
      setError(signInError.message);
      setBusy(false);
    }
  };

  const connectGoogleCalendar = async () => {
    if (!client) return;
    setGoogleCalendarBusy(true);
    setGoogleCalendarMessage("");
    const redirectUrl = new URL(window.location.origin);
    redirectUrl.searchParams.set("google_calendar", "connect");
    const { error: connectionError } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectUrl.toString(),
        scopes: "https://www.googleapis.com/auth/calendar.events.owned",
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
    if (connectionError) {
      setGoogleCalendarMessage(connectionError.message);
      setGoogleCalendarBusy(false);
    }
  };

  const switchAccount = async () => {
    await signIn(true);
  };

  const signOut = async () => {
    if (!client) return;
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) setError(signOutError.message);
  };

  const searchCompaniesForJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setError("");
    setCompanySearchResults([]);
    const { data, error: searchError } = await client.rpc("search_companies_for_join", {
      p_name: companySearchName.trim(),
    });
    if (searchError) setError(searchError.message);
    else if (!data?.length) setNotice("Firmu s takýmto názvom sme nenašli.");
    else {
      setCompanySearchResults(data as CompanySearchResult[]);
      setNotice("");
    }
    setBusy(false);
  };

  const requestCompanyJoin = async (company: CompanySearchResult) => {
    if (!client) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { data: requestId, error: requestError } = await client.rpc("request_company_join", {
        p_company_id: company.company_id,
      });
      if (requestError) throw requestError;
      const { error: emailError } = await client.functions.invoke("send-email", {
        body: { template: "company_join_request", to: "", data: { requestId } },
      });
      if (emailError) {
        setNotice("Žiadosť bola zaevidovaná, ale e-mail vedeniu sa nepodarilo odoslať. Skúste to neskôr alebo kontaktujte firmu priamo.");
        setError(emailError.message);
      } else {
        setNotice(`Žiadosť o vstup do firmy ${company.company_name} bola odoslaná vedeniu.`);
      }
      setCompanySearchResults([]);
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const reviewCompanyJoinRequest = async (request: CompanyJoinRequest, approve: boolean) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      const { error: reviewError } = await client.rpc("review_company_join_request", {
        p_request_id: request.id,
        p_approve: approve,
      });
      if (reviewError) throw reviewError;
      setJoinRequests((current) => current.filter((item) => item.id !== request.id));
      setNotice(approve ? `${request.full_name || request.email} bol pridaný do firmy.` : "Žiadosť bola odstránená.");
      if (approve) await refreshWorkspace();
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const createCompany = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    const { error: createError } = await client.rpc("create_company", {
      p_name: String(form.get("name") ?? ""),
      p_billing_name: String(form.get("billing_name") ?? ""),
      p_billing_ico: String(form.get("billing_ico") ?? ""),
      p_billing_dic: String(form.get("billing_dic") ?? ""),
      p_billing_ic_dph: String(form.get("billing_ic_dph") ?? ""),
      p_billing_address: String(form.get("billing_address") ?? ""),
    });
    if (createError) setError(createError.message);
    else {
      const { data: refreshed, error: refreshError } = await client
        .from("memberships")
        .select("id, company_id, user_id, email, full_name, role, is_employee, is_salesperson, is_external, is_minor, active, deactivated_at, created_at")
        .eq("user_id", session?.user.id ?? "");
      if (refreshError) setError(refreshError.message);
      else {
        const memberRows = (refreshed ?? []) as Membership[];
        const { data: companyRows, error: companyError } = await client
          .from("companies")
          .select("id, name, plan, pro_trial_started_at, pro_trial_ends_at, selected_plan, billing_name, billing_ico, billing_dic, billing_ic_dph, billing_address")
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
          if (session?.user.email) {
            void sendTransactionalEmail(client, "company_welcome", session.user.email, {
              companyName: String(form.get("name") ?? ""),
              fullName: session.user.user_metadata?.full_name ?? "",
            });
          }
        }
      }
    }
    setBusy(false);
  };

  const saveEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeMembership || !session) return;
    if (!isEmployeeUser) {
      setError("Pracovné záznamy môže pridávať iba člen s právom zamestnanca.");
      return;
    }
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
      setShowEntryForm(false);
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
    const memberType = String(form.get("member_type") ?? "EMPLOYEE");
    const isExternal = memberType === "EXTERNAL_EMPLOYEE";
    const isEmployee = memberType === "EMPLOYEE" || isExternal || memberType === "EMPLOYED_ACCOUNTANT";
    const role = memberType === "EMPLOYEE" || isExternal
      ? "EMPLOYEE"
      : memberType === "MANAGER"
        ? "MANAGER"
        : "ACCOUNTANT";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { data: result, error: addError } = await client.rpc("add_or_invite_company_member", {
        p_company_id: activeCompanyId,
        p_email: String(form.get("email") ?? ""),
        p_full_name: String(form.get("full_name") ?? ""),
        p_role: role,
        p_is_employee: isEmployee,
        p_is_external: isExternal,
        p_is_minor: isEmployee && !isExternal && form.get("is_minor") === "on",
      });
      if (addError) throw addError;

      if (result?.status === "invited") {
        const { error: emailError } = await client.functions.invoke("send-email", {
          body: {
            template: "company_invitation",
            to: "",
            data: { invitationId: result.invitation_id },
          },
        });
        if (emailError) {
          setError(emailError.message);
          setNotice("Pozvanie je uložené, ale e-mail sa nepodarilo odoslať. Skúste ho odoslať znova.");
          return;
        }
        setNotice(`Pozvánka bola odoslaná na ${String(form.get("email") ?? "")}. Po prihlásení sa člen automaticky pridá do firmy.`);
      } else {
        setNotice("Člen bol pridaný do firemného priestoru.");
      }
      formElement.reset();
      setNewMemberType("EMPLOYEE");
      await refreshWorkspace();
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
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

  const updateMemberRole = async (membership: Membership, role: Role) => {
    if (!client) return;
    setBusy(true);
    setError("");
    const { error: roleError } = await client.rpc("update_member_role", {
      p_membership_id: membership.id,
      p_new_role: role,
    });
    if (roleError) setError(roleError.message);
    else setRoster((current) => current.map((member) => member.id === membership.id ? { ...member, role } : member));
    setBusy(false);
  };

  const updateMemberPermissions = async (
    membership: Membership,
    permission: "is_employee" | "is_salesperson" | "is_external" | "is_minor",
    enabled: boolean,
  ) => {
    if (!client) return;
    const nextEmployee = permission === "is_employee" ? enabled : Boolean(membership.is_employee);
    const nextSalesperson = permission === "is_salesperson" ? enabled : Boolean(membership.is_salesperson);
    const nextExternal = permission === "is_external" ? enabled : Boolean(membership.is_external);
    const nextMinor = permission === "is_minor"
      ? enabled
      : (permission === "is_external" && enabled) || (permission === "is_employee" && !enabled)
        ? false
        : Boolean(membership.is_minor);
    setBusy(true);
    setError("");
    try {
      const { error: permissionError } = await client.rpc("update_member_permissions", {
        p_membership_id: membership.id,
        p_is_employee: nextEmployee,
        p_is_salesperson: nextSalesperson,
        p_is_external: nextExternal,
        p_is_minor: nextMinor,
      });
      if (permissionError) throw permissionError;
      setRoster((current) => current.map((member) => member.id === membership.id
        ? { ...member, is_employee: nextEmployee, is_salesperson: nextSalesperson, is_external: nextExternal, is_minor: nextMinor }
        : member));
      setMemberships((current) => current.map((member) => member.id === membership.id
        ? { ...member, is_employee: nextEmployee, is_salesperson: nextSalesperson, is_external: nextExternal, is_minor: nextMinor }
        : member));
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const createWorkOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const selectedAssigneeIds = form.getAll("assignee_ids").map(String).filter(Boolean);
    const assigneeIds = isManager ? selectedAssigneeIds : session?.user.id ? [session.user.id] : [];
    const timeToArrange = form.get("time_to_arrange") === "on";
    const startsAt = timeToArrange ? "" : String(form.get("starts_at") ?? "");
    const endsAt = timeToArrange ? "" : String(form.get("ends_at") ?? "");
    if (assigneeIds.length === 0) {
      setError("Vyberte aspoň jedného zamestnanca.");
      return;
    }
    if (Boolean(startsAt) !== Boolean(endsAt) || (startsAt && endsAt && endsAt <= startsAt)) {
      setError("Vyplňte začiatok aj koniec zákazky a skontrolujte časový interval.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: createError } = await client.rpc("create_work_order_with_details", {
        p_company_id: activeCompanyId,
        p_assignee_ids: assigneeIds,
        p_title: String(form.get("title") ?? ""),
        p_address: String(form.get("address") ?? ""),
        p_due_date: String(form.get("due_date") ?? ""),
        p_description: String(form.get("description") ?? ""),
        p_contact_phone: String(form.get("contact_phone") ?? ""),
        p_starts_at: startsAt || null,
        p_ends_at: endsAt || null,
        p_time_to_arrange: timeToArrange,
      });
      if (createError) {
        setError(createError.message);
        return;
      }
      await refreshWorkOrders();
      formElement.reset();
      setSelectedAssigneeIds([""]);
      setShowWorkOrderForm(false);
      setNotice(isManager
        ? "Zákazka bola priradená vybraným zamestnancom. Po prijatí sa zobrazí jej potvrdený stav."
        : "Zákazka bola pridaná do vášho kalendára.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const acceptWorkOrder = async (workOrderId: string) => {
    if (!client) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: acceptError } = await client.rpc("accept_work_order_assignment", {
        p_work_order_id: workOrderId,
      });
      if (acceptError) throw acceptError;
      await refreshWorkOrders();
      setNotice("Zákazku ste prijali.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const rejectWorkOrder = async (workOrderId: string) => {
    if (!client) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: rejectError } = await client.rpc("reject_work_order_assignment", {
        p_work_order_id: workOrderId,
      });
      if (rejectError) throw rejectError;
      await refreshWorkOrders();
      setNotice("Zákazku ste odmietli a vlastníkovi alebo vedúcemu sa zobrazí medzi vrátenými.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const reassignDeclinedWorkOrder = async (event: FormEvent<HTMLFormElement>, order: WorkOrder) => {
    event.preventDefault();
    if (!client) return;
    const assigneeId = String(new FormData(event.currentTarget).get("assignee_id") ?? "");
    if (!assigneeId) {
      setError("Vyberte zamestnanca, ktorému chcete zákazku prideliť.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: reassignError } = await client.rpc("reassign_declined_work_order", {
        p_work_order_id: order.id,
        p_assignee_id: assigneeId,
      });
      if (reassignError) throw reassignError;
      await refreshWorkOrders();
      setNotice("Zákazka bola pridelená ďalšiemu zamestnancovi.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const createGoogleSheetsScript = async () => {
    if (!client || !activeCompanyId) return;
    if (googleSheetsConnection?.configured && !window.confirm("Vytvorením nového kľúča prestane fungovať aktuálny skript, kým doň nevložíte nový kľúč a znovu ho nenasadíte. Pokračovať?")) return;
    setGoogleSheetsBusy(true);
    setGoogleSheetsError("");
    setGoogleSheetsMessage("");
    setNotice("");
    try {
      const { data, error: createError } = await client.functions.invoke<{ secret?: string }>("google-sheets-sync", {
        body: { action: "create", companyId: activeCompanyId },
      });
      if (createError) throw new Error(await functionErrorText(createError));
      if (!data?.secret) throw new Error("Bezpečnostný kľúč sa nepodarilo vytvoriť.");
      setGoogleSheetsSecret(data.secret);
      setGoogleSheetsWebAppUrl("");
      setGoogleSheetsConnection((current) => ({
        connected: false,
        configured: true,
        lastSyncAt: current?.lastSyncAt ?? null,
        webAppUrl: null,
      }));
      setNotice("Kľúč je pripravený. Skopírujte celý skript do editora Google Apps Script.");
    } catch (reason: unknown) {
      setGoogleSheetsError(googleSheetsErrorMessage(errorText(reason)));
    } finally {
      setGoogleSheetsBusy(false);
    }
  };

  const copyGoogleSheetsScript = async () => {
    try {
      await navigator.clipboard.writeText(GOOGLE_SHEETS_APPS_SCRIPT.replace("__WORKENA_SHARED_SECRET__", googleSheetsSecret));
      setNotice("Skript bol skopírovaný. Vložte ho v editore Apps Script.");
    } catch (reason: unknown) {
      setGoogleSheetsError(`Skript sa nepodarilo skopírovať: ${errorText(reason)}`);
    }
  };

  const configureGoogleSheets = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId) return;
    setGoogleSheetsBusy(true);
    setGoogleSheetsError("");
    setGoogleSheetsMessage("");
    setNotice("");
    try {
      const { data, error: configureError } = await client.functions.invoke<{ connected: boolean; webAppUrl?: string }>("google-sheets-sync", {
        body: { action: "configure", companyId: activeCompanyId, webAppUrl: googleSheetsWebAppUrl },
      });
      if (configureError) throw new Error(await functionErrorText(configureError));
      if (!data?.connected) throw new Error("Google Tabuľku sa nepodarilo prepojiť.");
      setGoogleSheetsConnection((current) => ({
        connected: true,
        configured: true,
        lastSyncAt: current?.lastSyncAt ?? null,
        webAppUrl: data.webAppUrl ?? googleSheetsWebAppUrl.trim(),
      }));
      setNotice("Google Tabuľka je prepojená. Synchronizáciu spustíte tlačidlom.");
    } catch (reason: unknown) {
      setGoogleSheetsError(googleSheetsErrorMessage(errorText(reason)));
    } finally {
      setGoogleSheetsBusy(false);
    }
  };

  const syncGoogleSheetsCustomers = async () => {
    if (!client || !activeCompanyId) return;
    setGoogleSheetsBusy(true);
    setGoogleSheetsError("");
    setGoogleSheetsMessage("Synchronizácia prebieha…");
    setNotice("");
    try {
      const { data, error: syncError } = await client.functions.invoke<{
        syncedAt: string;
        createdFromSheet: number;
        createdInSheet: number;
        updatedInWorkena: number;
        updatedInSheet: number;
        deletedInWorkena: number;
        deletedInSheet: number;
      }>("google-sheets-sync", { body: { action: "sync", companyId: activeCompanyId } });
      if (syncError) throw new Error(await functionErrorText(syncError));
      if (!data?.syncedAt) throw new Error("Synchronizácia nevrátila potvrdený výsledok.");
      await refreshCustomers();
      setGoogleSheetsConnection((current) => current ? { ...current, connected: true, lastSyncAt: data.syncedAt } : current);
      setGoogleSheetsMessage(
        `Synchronizácia dokončená. Nové z tabuľky: ${data.createdFromSheet}; nové v tabuľke: ${data.createdInSheet}; zmenené v Workene: ${data.updatedInWorkena}; zmenené v tabuľke: ${data.updatedInSheet}; vymazané v Workene: ${data.deletedInWorkena}; vymazané v tabuľke: ${data.deletedInSheet}.`,
      );
    } catch (reason: unknown) {
      setGoogleSheetsError(googleSheetsErrorMessage(errorText(reason)));
      setGoogleSheetsMessage("");
    } finally {
      setGoogleSheetsBusy(false);
    }
  };

  const disconnectGoogleSheets = async () => {
    if (!client || !activeCompanyId || !window.confirm("Odpojiť Google Tabuľku? Ďalšie zmeny sa už nebudú synchronizovať.")) return;
    setGoogleSheetsBusy(true);
    setGoogleSheetsError("");
    setGoogleSheetsMessage("");
    setNotice("");
    try {
      const { error: disconnectError } = await client.functions.invoke("google-sheets-sync", {
        body: { action: "disconnect", companyId: activeCompanyId },
      });
      if (disconnectError) throw new Error(await functionErrorText(disconnectError));
      setGoogleSheetsConnection({ connected: false, configured: false, lastSyncAt: null, webAppUrl: null });
      setGoogleSheetsWebAppUrl("");
      setGoogleSheetsSecret("");
      setNotice("Google Tabuľka bola odpojená.");
    } catch (reason: unknown) {
      setGoogleSheetsError(googleSheetsErrorMessage(errorText(reason)));
    } finally {
      setGoogleSheetsBusy(false);
    }
  };

  const saveCustomer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId || !canAccessCustomers) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const salespersonId = isCompanyOwner
      ? String(form.get("salesperson_id") ?? "")
      : session?.user.id ?? "";
    const priceValue = String(form.get("estimated_price") ?? "").trim();
    const payload = {
      company_id: activeCompanyId,
      salesperson_id: salespersonId,
      customer_date: String(form.get("customer_date") ?? ""),
      full_name: String(form.get("full_name") ?? "").trim(),
      location: String(form.get("location") ?? "").trim(),
      lead_source: String(form.get("lead_source") ?? "").trim(),
      product: String(form.get("product") ?? "").trim(),
      quote_sent_date: String(form.get("quote_sent_date") ?? "") || null,
      contact_details: String(form.get("contact_details") ?? "").trim(),
      estimated_price: priceValue ? Number(priceValue) : null,
      status: String(form.get("status") ?? "NO_RESPONSE") as CustomerStatus,
      updated_at: new Date().toISOString(),
    };
    if (isCompanyOwner && !roster.some((member) => member.user_id === salespersonId && member.is_salesperson)) {
      setError("Vyberte aktívneho člena s právom obchodníka.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: customerError } = editingCustomer
        ? await client.from("customers").update(payload).eq("id", editingCustomer.id).eq("company_id", activeCompanyId).select("id").single()
        : await client.from("customers").insert(payload).select("id").single();
      if (customerError) throw customerError;
      await refreshCustomers();
      setEditingCustomer(null);
      setShowCustomerForm(false);
      setNotice(editingCustomer ? "Zákazník bol upravený." : "Zákazník bol pridaný.");
      formElement.reset();
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeCustomerStatus = async (customer: Customer, status: CustomerStatus) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      const { error: statusError } = await client.from("customers").update({ status, updated_at: new Date().toISOString() }).eq("id", customer.id).select("id").single();
      if (statusError) throw statusError;
      await refreshCustomers();
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteCustomer = async (customer: Customer) => {
    if (!client || !window.confirm(`Naozaj chcete vymazať zákazníka „${customer.full_name}“?`)) return;
    setBusy(true);
    setError("");
    try {
      const { error: deleteError } = await client.from("customers").delete().eq("id", customer.id).select("id").single();
      if (deleteError) throw deleteError;
      await refreshCustomers();
      setNotice("Zákazník bol vymazaný.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveWorkOrderDetails = async (event: FormEvent<HTMLFormElement>, order: WorkOrder) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const timeToArrange = form.get("time_to_arrange") === "on";
    const startsAt = timeToArrange ? "" : String(form.get("starts_at") ?? "");
    const endsAt = timeToArrange ? "" : String(form.get("ends_at") ?? "");
    if (Boolean(startsAt) !== Boolean(endsAt) || (startsAt && endsAt && endsAt <= startsAt)) {
      setError("Vyplňte začiatok aj koniec zákazky a skontrolujte časový interval.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: saveError } = await client.rpc("update_work_order_details", {
        p_work_order_id: order.id,
        p_title: String(form.get("title") ?? ""),
        p_address: String(form.get("address") ?? ""),
        p_due_date: String(form.get("due_date") ?? ""),
        p_description: String(form.get("description") ?? ""),
        p_contact_phone: String(form.get("contact_phone") ?? ""),
        p_starts_at: startsAt || null,
        p_ends_at: endsAt || null,
        p_time_to_arrange: timeToArrange,
      });
      if (saveError) throw saveError;
      await refreshWorkOrders();
      setEditingOrderId(null);
      setNotice("Zákazka bola upravená.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const completeWorkOrder = async (order: WorkOrder) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      const { error: completeError } = await client.rpc("complete_work_order", { p_work_order_id: order.id });
      if (completeError) throw completeError;
      await refreshWorkOrders();
      setNotice("Zákazka bola označená ako dokončená.");
      setSelectedCalendarOrder(null);
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveWorkOrderSchedule = async (event: FormEvent<HTMLFormElement>, order: WorkOrder) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const timeToArrange = form.get("time_to_arrange") === "on";
    const startsAt = timeToArrange ? "" : String(form.get("starts_at") ?? "");
    const endsAt = timeToArrange ? "" : String(form.get("ends_at") ?? "");
    if (Boolean(startsAt) !== Boolean(endsAt) || (startsAt && endsAt && endsAt <= startsAt)) {
      setError("Vyplňte začiatok aj koniec zákazky a skontrolujte časový interval.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: scheduleError } = await client.rpc("update_work_order_schedule", {
        p_work_order_id: order.id,
        p_due_date: String(form.get("due_date") ?? ""),
        p_starts_at: startsAt || null,
        p_ends_at: endsAt || null,
        p_time_to_arrange: timeToArrange,
      });
      if (scheduleError) throw scheduleError;
      await refreshWorkOrders();
      setEditingScheduleOrderId(null);
      setNotice("Termín zákazky bol upravený.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkOrder = async (order: WorkOrder) => {
    if (!client || !window.confirm(`Naozaj chcete vymazať zákazku „${order.title}“?`)) return;
    setBusy(true);
    setError("");
    try {
      const { error: deleteError } = await client.rpc("delete_work_order", { p_work_order_id: order.id });
      if (deleteError) throw deleteError;
      await refreshWorkOrders();
      setNotice("Zákazka bola vymazaná.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const createAbsenceRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { data: absenceId, error: createError } = await client.rpc("create_absence_request", {
        p_company_id: activeCompanyId,
        p_type: String(form.get("type") ?? ""),
        p_start_date: String(form.get("start_date") ?? ""),
        p_end_date: String(form.get("end_date") ?? ""),
        p_note: String(form.get("note") ?? ""),
      });
      if (createError) {
        setError(createError.message);
        return;
      }
      if (pendingAbsenceAttachment && absenceId) {
        const file = pendingAbsenceAttachment;
        const path = `${activeCompanyId}/${absenceId}/${Date.now()}-${file.name}`;
        const { error: uploadError } = await client.storage.from(ABSENCE_ATTACHMENT_BUCKET).upload(path, file, {
          contentType: file.type,
        });
        if (uploadError) {
          setError(uploadError.message);
          return;
        }
        const { error: attachError } = await client.rpc("attach_absence_file", {
          p_absence_id: absenceId,
          p_storage_path: path,
          p_file_name: file.name,
          p_mime_type: file.type,
          p_size_bytes: file.size,
        });
        if (attachError) {
          setError(attachError.message);
          return;
        }
      }
      await refreshAbsenceRequests();
      formElement.reset();
      setAbsenceType("VACATION");
      setPendingAbsenceAttachment(null);
      setNotice("Žiadosť o neprítomnosť bola odoslaná na schválenie.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancelAbsenceRequest = async (absenceId: string) => {
    if (!client) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: cancelError } = await client.rpc("cancel_absence_request", { p_absence_id: absenceId });
      if (cancelError) throw cancelError;
      await refreshAbsenceRequests();
      setNotice("Žiadosť bola zrušená.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const reviewAbsenceRequest = async (absenceId: string, status: "APPROVED" | "REJECTED") => {
    if (!client) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: reviewError } = await client.rpc("review_absence_request", {
        p_absence_id: absenceId,
        p_status: status,
        p_review_note: null,
      });
      if (reviewError) throw reviewError;
      await refreshAbsenceRequests();
      setNotice(status === "APPROVED" ? "Neprítomnosť bola schválená." : "Neprítomnosť bola zamietnutá.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const openAbsenceAttachment = async (path: string) => {
    if (!client) return;
    const { data, error: signedError } = await client.storage.from(ABSENCE_ATTACHMENT_BUCKET).createSignedUrl(path, 60 * 10);
    if (signedError || !data) {
      setError(signedError?.message ?? "Prílohu sa nepodarilo otvoriť.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noreferrer");
  };

  const adminSetCompanyPlan = async (companyId: string, plan: CompanyPlan) => {
    if (!client) return;
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      const { error: setPlanError } = await client.rpc("admin_set_company_plan", {
        p_company_id: companyId,
        p_plan: plan,
      });
      if (setPlanError) throw setPlanError;
      await refreshAdminCompanies();
      setAdminNotice("Licencia bola upravená.");
    } catch (reason: unknown) {
      setAdminError(errorText(reason));
    } finally {
      setAdminBusy(false);
    }
  };

  const adminDeleteCompany = async (companyId: string, companyName: string) => {
    if (!client) return;
    if (!window.confirm(`Naozaj natrvalo vymazať firmu „${companyName}“ a všetky jej dáta (zákazky, dochádzku, platby...)? Tento krok je nevratný.`)) return;
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      const { error: deleteError } = await client.rpc("admin_delete_company", {
        p_company_id: companyId,
      });
      if (deleteError) throw deleteError;
      await refreshAdminCompanies();
      setAdminNotice("Firma bola vymazaná.");
    } catch (reason: unknown) {
      setAdminError(errorText(reason));
    } finally {
      setAdminBusy(false);
    }
  };

  const adminReviewPaymentRequest = async (company: AdminCompanyRow, approve: boolean) => {
    if (!client || !company.pending_payment_id) return;
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      const { error: reviewPaymentError } = await client.rpc("admin_review_payment_request", {
        p_request_id: company.pending_payment_id,
        p_approve: approve,
      });
      if (reviewPaymentError) throw reviewPaymentError;
      await refreshAdminCompanies();
      setAdminNotice(approve ? "Platba bola potvrdená a licencia pridelená." : "Platba bola zamietnutá.");
      if (approve && company.owner_email && company.pending_payment_plan) {
        void sendTransactionalEmail(client, "payment_confirmed", company.owner_email, {
          companyName: company.name,
          fullName: company.owner_name ?? "",
          planName: PAYMENT_PLAN_DETAILS[company.pending_payment_plan].name,
        });
      }
    } catch (reason: unknown) {
      setAdminError(errorText(reason));
    } finally {
      setAdminBusy(false);
    }
  };

  const adminSendPaymentReminder = async (company: AdminCompanyRow) => {
    if (!client || !company.owner_email || !company.pending_payment_plan) return;
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      await sendTransactionalEmail(client, "payment_reminder", company.owner_email, {
        companyName: company.name,
        fullName: company.owner_name ?? "",
        planName: PAYMENT_PLAN_DETAILS[company.pending_payment_plan].name,
        amount: Number(company.pending_payment_amount).toFixed(2).replace(".", ","),
        variableSymbol: company.pending_payment_variable_symbol ?? "",
      });
      setAdminNotice("Upomienka bola odoslaná.");
    } catch (reason: unknown) {
      setAdminError(errorText(reason));
    } finally {
      setAdminBusy(false);
    }
  };

  const adminSendCustomEmail = async (company: AdminCompanyRow, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !company.owner_email) return;
    const form = new FormData(event.currentTarget);
    const subject = String(form.get("subject") ?? "").trim();
    const message = String(form.get("message") ?? "").trim();
    if (subject.length < 2 || message.length < 2) {
      setAdminError("Vyplňte predmet aj text správy.");
      return;
    }
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      await sendTransactionalEmail(client, "admin_custom", company.owner_email, {
        companyName: company.name,
        fullName: company.owner_name ?? "",
        subject,
        message,
      });
      setAdminNotice(`E-mail bol odoslaný firme ${company.name}.`);
      setAdminEmailTargetId(null);
    } catch (reason: unknown) {
      setAdminError(errorText(reason));
    } finally {
      setAdminBusy(false);
    }
  };

  const adminBroadcastMaintenance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const startsAt = String(form.get("starts_at") ?? "");
    const endsAt = String(form.get("ends_at") ?? "");
    const reason = String(form.get("reason") ?? "").trim();
    if (!startsAt || !endsAt) {
      setAdminError("Vyplňte začiatok aj koniec odstávky.");
      return;
    }
    const recipients = adminCompanies
      .map((company) => company.owner_email)
      .filter((email): email is string => Boolean(email));
    const uniqueRecipients = Array.from(new Set(recipients));
    if (uniqueRecipients.length === 0) {
      setAdminError("Zatiaľ nie sú žiadne firmy s e-mailom vlastníka.");
      return;
    }
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      const startsLabel = new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(startsAt));
      const endsLabel = new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(endsAt));
      await Promise.all(uniqueRecipients.map((email) => sendTransactionalEmail(client, "maintenance_notice", email, {
        startsAt: startsLabel,
        endsAt: endsLabel,
        reason: reason || undefined,
      })));
      setAdminNotice(`Oznámenie o odstávke bolo odoslané ${uniqueRecipients.length} firmám.`);
      setAdminMaintenanceOpen(false);
    } catch (reason: unknown) {
      setAdminError(errorText(reason));
    } finally {
      setAdminBusy(false);
    }
  };

  const saveAttendanceShift = async (shift: AttendanceShift) => {
    if (!client || !editingAttendanceShift || editingAttendanceShift.id !== shift.id) return;
    const started = new Date(editingAttendanceShift.startedAt);
    const ended = editingAttendanceShift.endedAt ? new Date(editingAttendanceShift.endedAt) : null;
    if (Number.isNaN(started.getTime()) || (ended && (Number.isNaN(ended.getTime()) || ended <= started))) {
      setError("Skontrolujte začiatok a koniec zmeny.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: saveError } = await client.rpc("update_attendance_shift", {
        p_shift_id: shift.id,
        p_started_at: started.toISOString(),
        p_ended_at: ended?.toISOString() ?? null,
      });
      if (saveError) throw saveError;
      await refreshAttendance();
      setEditingAttendanceShift(null);
      setNotice("Dochádzkový záznam bol upravený.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAttendanceShift = async (shiftId: string) => {
    if (!client || !window.confirm("Naozaj chcete vymazať tento dochádzkový záznam?")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: deleteError } = await client.rpc("delete_attendance_shift", { p_shift_id: shiftId });
      if (deleteError) throw deleteError;
      if (editingAttendanceShift?.id === shiftId) setEditingAttendanceShift(null);
      await refreshAttendance();
      setNotice("Dochádzkový záznam bol vymazaný.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const fullName = profileFullName.trim();
    if (fullName.length < 2 || fullName.length > 120) {
      setError("Meno musí mať 2 až 120 znakov.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { data, error: profileError } = await client.auth.updateUser({ data: { full_name: fullName } });
    if (profileError) setError(profileError.message);
    else {
      if (data.user) setSession((current) => current ? { ...current, user: data.user } : current);
      setNotice("Profil bol uložený.");
    }
    setBusy(false);
  };

  const saveCompanyBillingDetails = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !activeCompanyId || !isManager) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: billingError } = await client.rpc("update_company_billing_details", {
        p_company_id: activeCompanyId,
        p_billing_name: billingName,
        p_billing_ico: billingIco,
        p_billing_dic: billingDic,
        p_billing_ic_dph: billingIcDph,
        p_billing_address: billingAddress,
      });
      if (billingError) throw billingError;
      setMemberships((current) => current.map((membership) =>
        membership.company_id === activeCompanyId
          ? { ...membership, company: { ...membership.company, billing_name: billingName || null, billing_ico: billingIco || null, billing_dic: billingDic || null, billing_ic_dph: billingIcDph || null, billing_address: billingAddress || null } }
          : membership,
      ));
      setNotice("Fakturačné údaje boli uložené.");
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const createAdditionalCompany = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const companyName = String(form.get("name") ?? "");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: createError } = await client.rpc("create_company", {
        p_name: companyName,
        p_billing_name: String(form.get("billing_name") ?? ""),
        p_billing_ico: String(form.get("billing_ico") ?? ""),
        p_billing_dic: String(form.get("billing_dic") ?? ""),
        p_billing_ic_dph: String(form.get("billing_ic_dph") ?? ""),
        p_billing_address: String(form.get("billing_address") ?? ""),
      });
      if (createError) throw createError;
      const { data: refreshed, error: refreshError } = await client
        .from("memberships")
        .select("id, company_id, user_id, email, full_name, role, is_employee, is_salesperson, is_external, is_minor, active, deactivated_at, created_at")
        .eq("user_id", session?.user.id ?? "");
      if (refreshError) throw refreshError;
      const memberRows = (refreshed ?? []) as Membership[];
      const { data: companyRows, error: companyError } = await client
        .from("companies")
        .select("id, name, plan, pro_trial_started_at, pro_trial_ends_at, selected_plan, billing_name, billing_ico, billing_dic, billing_ic_dph, billing_address")
        .in("id", memberRows.map((membership) => membership.company_id));
      if (companyError) throw companyError;
      const companyById = new Map(((companyRows ?? []) as Company[]).map((company) => [company.id, company]));
      const workspaces = memberRows.flatMap((membership) => {
        const company = companyById.get(membership.company_id);
        return company ? [{ ...membership, company }] : [];
      });
      setMemberships(workspaces);
      setNewCompanyName("");
      setNotice("Nová firma bola založená.");
      if (session?.user.email) {
        void sendTransactionalEmail(client, "company_welcome", session.user.email, {
          companyName,
          fullName: session.user.user_metadata?.full_name ?? "",
        });
      }
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
      setNotice(status === "DONE"
        ? "Zákazka a výkaz boli označené ako dokončené."
        : status === "MEASURED" && activeMembership?.is_salesperson
          ? "Zákazka je zameraná a presunula sa medzi vybavené."
          : status === "MEASURED"
            ? "Zákazka bola označená ako zameraná."
            : status === "WORKING"
              ? "Stav zákazky je Pracuje sa."
              : "Stav zákazky je Rozpracované.");
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
      .filter((member) => member.role === "EMPLOYEE" || member.is_employee)
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
      .filter((member) => member.role === "EMPLOYEE" || member.is_employee)
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
    const members = canManageAttendance
      ? roster.filter((member) => (member.role === "EMPLOYEE" || member.is_employee) && (attendanceEmployeeFilter === "ALL" || member.user_id === attendanceEmployeeFilter))
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
  }, [attendanceBreaks, attendanceEmployeeFilter, attendanceNow, canManageAttendance, monthAttendanceShifts, roster, session?.user.id]);
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
    const members = roster.filter((member) => member.role === "EMPLOYEE" || member.is_employee);
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
    lunchBreakTaken: boolean | null = null,
  ) => {
    if (!client || !activeCompanyId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: actionError } = await client.rpc(action, {
        p_company_id: activeCompanyId,
        ...(action === "end_attendance" ? { p_lunch_break: lunchBreakTaken } : {}),
      });
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

  const requestEndAttendance = () => {
    if (!activeShift) return;
    const recordedBreaks = attendanceBreaks.some((pause) => pause.shift_id === activeShift.id);
    const elapsed = attendanceNow - new Date(activeShift.started_at).getTime();
    if (isEmployeeUser && !isExternalEmployee && !recordedBreaks && elapsed >= attendanceBreakThresholdMs) {
      setShowLunchBreakPrompt(true);
      return;
    }
    void attendanceAction("end_attendance");
  };

  const calculateVehicleTripRoute = async () => {
    if (!tripOrigin.trim() || !tripDestination.trim()) {
      setError("Zadajte miesto odchodu aj cieľ jazdy.");
      return;
    }
    if (tripRoundTrip && tripDifferentReturn && !tripReturnDestination.trim()) {
      setError("Zadajte iný cieľ spiatočnej jazdy, alebo zrušte túto voľbu.");
      return;
    }
    setTripMapBusy(true);
    setError("");
    setTripNotice("");
    try {
      const validStops = tripStops.map((stop) => stop.trim()).filter((stop) => stop.length > 0);
      const forwardPoints = [tripOrigin.trim(), ...validStops, tripDestination.trim()];
      const forwardKm = await openStreetMapMultiLegDistance(forwardPoints);
      let totalKm = forwardKm;
      if (tripRoundTrip) {
        if (tripDifferentReturn && tripReturnDestination.trim()) {
          await sleep(1100);
          const returnKm = await openStreetMapRoadDistance(tripDestination.trim(), tripReturnDestination.trim());
          totalKm = forwardKm + returnKm;
        } else {
          totalKm = forwardKm * 2;
        }
      }
      setTripMapDistance(forwardKm);
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
      const validStops = tripStops.map((stop) => stop.trim()).filter((stop) => stop.length > 0);
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
        p_stops: validStops,
        p_return_destination: tripRoundTrip && tripDifferentReturn && tripReturnDestination.trim() ? tripReturnDestination.trim() : null,
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
      setTripStops([]);
      setTripReturnDestination("");
      setTripDifferentReturn(false);
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

  const downloadCustomersCsv = () => {
    const rows = [
      ["Dátum", "Meno", "Lokalita", "Odkiaľ prišiel dopyt", "Produkt", "CP poslaná dňa", "Kontaktné údaje", "Približná cena", "Stav", "Obchodník"],
      ...visibleCustomers.map((customer) => [
        customer.customer_date,
        customer.full_name,
        customer.location,
        customer.lead_source,
        customer.product,
        customer.quote_sent_date ?? "",
        customer.contact_details,
        customer.estimated_price === null ? "" : Number(customer.estimated_price).toFixed(2),
        customerStatusName(customer.status),
        roster.find((member) => member.user_id === customer.salesperson_id)?.full_name
          || roster.find((member) => member.user_id === customer.salesperson_id)?.email
          || "",
      ]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(activeMembership?.company.name ?? "workena").replace(/[^a-z0-9_-]+/gi, "-")}-zakaznici.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const printCustomers = () => {
    const previousTitle = document.title;
    document.body.classList.add("printing-customer-report");
    document.title = `${activeMembership?.company.name ?? "Workena"} - zákazníci`;
    window.addEventListener("afterprint", () => {
      document.body.classList.remove("printing-customer-report");
      document.title = previousTitle;
    }, { once: true });
    window.print();
  };

  if (page === "terms") {
    return <TermsOfService onBack={() => {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setPage("dashboard");
    }} />;
  }

  if (page === "privacy") {
    return <PrivacyPolicy onBack={() => {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setPage("dashboard");
    }} />;
  }

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
          <div className="landing-nav-links"><a href="#ponuka">Služba a ceny</a><a href="#kontakt">Kontakt</a></div>
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
        <section className="landing-offer" id="ponuka">
          <header className="pricing-proposal-heading">
            <div><span className="eyebrow">SLUŽBA A CENY</span><h2>Workena — evidencia práce online</h2></div>
            <p>Webová aplikácia na evidenciu pracovného času, dochádzky, zákaziek, jázd a súvisiacich tímových údajov. Digitálna služba sa používa cez webové rozhranie.</p>
          </header>
          <div className="sales-pricing-grid">
            <article className="panel pricing-proposal-card">
              <div><span className="pricing-proposal-name">Free</span><strong>0,00 €<small> / mesiac</small></strong></div>
              <p>Bezplatné používanie Workeny na základnú evidenciu práce.</p>
              <p className="muted"><small>Maximálne 2 zamestnanci; bez priraďovania zákaziek.</small></p>
              <small className="price-tax-note">Cena bez poplatku.</small>
            </article>
            <article className="panel pricing-proposal-card">
              <div><span className="pricing-proposal-name">Basic</span><strong>19,00 €<small> / mesiac</small></strong></div>
              <p>Zamestnanci, úlohy a základná evidencia.</p>
              <p className="muted"><small>Maximálne 10 zamestnancov.</small></p>
              <small className="price-tax-note">Konečná cena vrátane DPH 23 %.</small>
            </article>
            <article className="panel pricing-proposal-card">
              <div><span className="pricing-proposal-name">Pro</span><strong>39,00 €<small> / mesiac</small></strong></div>
              <p>Dochádzka, výkazy, exporty, reporty a priraďovanie zákaziek.</p>
              <p className="muted"><small>Maximálne 30 zamestnancov.</small></p>
              <small className="price-tax-note">Konečná cena vrátane DPH 23 %.</small>
            </article>
            <article className="panel pricing-proposal-card">
              <div><span className="pricing-proposal-name">Team</span><strong>69,00 €<small> / mesiac</small></strong></div>
              <p>Viac tímov, zákazky, pokročilé reporty a oprávnenia.</p>
              <p className="muted"><small>Neobmedzený počet zamestnancov.</small></p>
              <small className="price-tax-note">Konečná cena vrátane DPH 23 %.</small>
            </article>
          </div>
          <p className="sales-price-disclaimer">Platené sumy Basic, Pro a Team sú návrhové ceny a momentálne nie sú záväznou ponukou na objednanie. Zobrazené sumy sú konečné vrátane DPH 23 %: Basic 19,00 €, Pro 39,00 € a Team 69,00 € mesačne.</p>
        </section>
        <section className="landing-contact" id="kontakt">
          <div>
            <span className="eyebrow">KONTAKT A PREVÁDZKOVATEĽ</span>
            <h2>ROVOLT</h2>
            <p>Roman Chlebovec — obchodné označenie ROVOLT</p>
          </div>
          <address>
            <span>IČO: 57875189 · DIČ: 1121595376</span>
            <span>IČ DPH: SK1121595376</span>
            <span>MPČĽ 3053/11, 058 01 Poprad, Slovensko</span>
            <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>
            <a href="tel:+421904826557">0904 826 557</a>
          </address>
        </section>
        <section className="landing-payments">
          <strong>Testovacia verzia GoPay a platobné podklady</strong>
          <p>GoPay sandbox integrácia sa pripravuje na schválenie vrátane testu mesačného opakovania platieb. Checkout bude dostupný vlastníkovi firmy po nakonfigurovaní GoPay testovacích údajov; testovacia platba neaktivuje licenciu. Produkčné platby zatiaľ nie sú zapnuté.</p>
          <div className="payment-brand-assets" aria-label="Grafické podklady GoPay a platobných značiek">
            <img className="payment-brand-gopay" src="/bannerr3D/gopay-banner-colorfull.svg" alt="GoPay" />
            <img src="/bannerr3D/mastercard.png" alt="Mastercard" />
            <img className="payment-brand-secure" src="/bannerr3D/mastercard-securecode.png" alt="Mastercard SecureCode" />
          </div>
          <p className="payment-brand-source-links">Pôvodné vektorové podklady: <a href="/bannerr3D/visa-full-colour-rgb.eps" download>Visa</a>, <a href="/bannerr3D/visa_electron_2015.eps" download>Visa Electron</a>, <a href="/bannerr3D/verified_by_visa-full-colour.eps" download>Verified by Visa</a> a <a href="/bannerr3D/me_accpt_match_eps.eps" download>ďalší podklad Mastercard</a>.</p>
        </section>
        <footer className="landing-footer">
          <span>© {new Date().getFullYear()} Workena · Navrhnutá pre skutočnú prácu.</span>
          <nav aria-label="Právne a kontaktné informácie">
            <a href="#kontakt">Kontakt</a>
            <a href="#obchodne-podmienky">Obchodné podmienky</a>
            <a href="#ochrana-osobnych-udajov">Ochrana osobných údajov</a>
          </nav>
        </footer>
      </main>
    );
  }

  const renderEntryFormModal = () => showEntryForm && (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) {
        setShowEntryForm(false);
        setEditingEntry(null);
        setPendingPhotos([]);
      }
    }}>
      <section className="panel detail-modal work-order-create-modal entry-form" role="dialog" aria-modal="true" aria-labelledby="entry-form-title">
        <div className="modal-heading">
          <div><span className="eyebrow">{editingEntry ? "ÚPRAVA ZÁZNAMU" : "NOVÝ ZÁZNAM"}</span><h2 id="entry-form-title">{editingEntry ? "Upraviť odpracovaný čas" : "Zapísať odpracovaný čas"}</h2><p>Údaje sú viditeľné iba členom firmy {activeMembership?.company.name}.</p></div>
          <button type="button" className="logout-button" aria-label="Zavrieť formulár" disabled={busy} onClick={() => { setShowEntryForm(false); setEditingEntry(null); setPendingPhotos([]); }}><X size={18} /></button>
        </div>
        <form className="form-stack" onSubmit={(event) => void saveEntry(event)}>
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
          <div className="form-actions"><button type="button" className="button button-quiet" disabled={busy} onClick={() => { setShowEntryForm(false); setEditingEntry(null); setPendingPhotos([]); }}>Zrušiť</button><button className="button button-primary" disabled={busy}>{busy ? "Ukladám…" : editingEntry ? "Uložiť zmeny" : "Uložiť záznam"}</button></div>
        </form>
      </section>
    </div>
  );

  const renderAttendance = () => (
    <section className="content-page">
      <header className="dashboard-title-row">
        <div><span className="eyebrow">PRACOVNÝ ČAS</span><h1>Dochádzka</h1><p>Začiatok zmeny, prestávky a čistý odpracovaný čas.</p></div>
        {isEmployeeUser && <button className="button button-outline" onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setShowEntryForm(true); }}>
          <Plus size={15} /> Nový záznam
        </button>}
      </header>
      {canManageAttendance && <section className="panel">
        <label className="field"><span>Zobraziť dochádzku zamestnanca</span>
          <select value={attendanceEmployeeFilter} onChange={(event) => setAttendanceEmployeeFilter(event.target.value)}>
            <option value="ALL">Všetci zamestnanci</option>
            {roster.filter((member) => member.role === "EMPLOYEE" || member.is_employee).map((member) => <option key={member.user_id} value={member.user_id}>{member.full_name || member.email}</option>)}
          </select>
        </label>
      </section>}
      {isEmployeeUser && <section className={`panel attendance-clock ${activeShift ? "attendance-clock-running" : ""}`}>
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
              <button className="button button-danger" disabled={busy} onClick={requestEndAttendance}><Square size={15} /> Ukončiť zmenu</button>
            </div>}
      </section>}
      {isEmployeeUser && <p className="attendance-schedule-note">Prihlásenie zamestnanca zmenu automaticky spustí alebo obnoví. Odhlásenie ani zatvorenie aplikácie časovač nezastaví; na zastavenie použite tlačidlo „Ukončiť zmenu“.</p>}
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
                    const sourceEntry = shift.source_work_entry_id ? entries.find((entry) => entry.id === shift.source_work_entry_id) : undefined;
                    const canEditSourceEntry = !!sourceEntry && (canManageAttendance || (sourceEntry.user_id === session?.user.id && sourceEntry.status !== "APPROVED"));
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
                        {shift.note && <small className="attendance-shift-note">{shift.note}</small>}
                        {!shift.source_work_entry_id && (canManageAttendance || shift.user_id === session?.user.id) && <button
                          className="button button-outline button-small"
                          onClick={() => {
                            setEditingAttendanceShift({
                              id: shift.id,
                              startedAt: dateTimeLocal(shift.started_at),
                              endedAt: shift.ended_at ? dateTimeLocal(shift.ended_at) : "",
                            });
                            setError("");
                          }}
                        ><Pencil size={13} /> Upraviť</button>}
                        {!shift.source_work_entry_id && (canManageAttendance || shift.user_id === session?.user.id) && <button
                          className="button button-outline button-small"
                          disabled={busy}
                          onClick={() => void deleteAttendanceShift(shift.id)}
                        ><Trash2 size={13} /> Vymazať</button>}
                        {canEditSourceEntry && <button
                          className="button button-outline button-small"
                          onClick={() => { setEditingEntry(sourceEntry ?? null); setPendingPhotos([]); setShowEntryForm(true); setError(""); }}
                        ><Pencil size={13} /> Upraviť</button>}
                        {canEditSourceEntry && <button
                          className="button button-outline button-small"
                          disabled={busy}
                          onClick={() => sourceEntry && void removeEntry(sourceEntry)}
                        ><Trash2 size={13} /> Vymazať</button>}
                      </div>
                      {editingAttendanceShift?.id === shift.id && <div className="attendance-edit-form">
                        <label className="field"><span>Začiatok</span><input type="datetime-local" value={editingAttendanceShift.startedAt} onChange={(event) => setEditingAttendanceShift({ ...editingAttendanceShift, startedAt: event.target.value })} required /></label>
                        <label className="field"><span>Koniec <small>prázdne = zmena stále prebieha</small></span><input type="datetime-local" value={editingAttendanceShift.endedAt} onChange={(event) => setEditingAttendanceShift({ ...editingAttendanceShift, endedAt: event.target.value })} /></label>
                        <div className="form-actions"><button className="button button-quiet button-small" onClick={() => setEditingAttendanceShift(null)}>Zrušiť</button><button className="button button-primary button-small" disabled={busy} onClick={() => void saveAttendanceShift(shift)}>{busy ? "Ukladám…" : "Uložiť zmenu"}</button></div>
                      </div>}
                      {shiftBreaks.map((pause) => <div className="attendance-break-line" key={pause.id}>
                        <Coffee size={13} /><span>Prestávka {timeLabel(pause.started_at)} – {pause.ended_at ? timeLabel(pause.ended_at) : "prebieha"}</span>
                      </div>)}
                    </section>;
                  })}
              </div>}
            </div>;
          })}</div>}
      </section>
      <section className="panel work-order-create-panel">
        <div className="panel-heading"><div><h2><Palmtree size={17} /> Nahlásiť neprítomnosť</h2><p>Dovolenka, home office alebo iná neprítomnosť čaká na schválenie vedením.</p></div></div>
        <form className="form-stack work-order-form" onSubmit={(event) => void createAbsenceRequest(event)}>
          <div className="form-grid">
            <label className="field"><span>Typ neprítomnosti</span><select name="type" value={absenceType} onChange={(event) => setAbsenceType(event.target.value as AbsenceType)} required>
              {(Object.keys(ABSENCE_TYPE_LABELS) as AbsenceType[]).map((type) => <option key={type} value={type}>{ABSENCE_TYPE_LABELS[type]}</option>)}
            </select></label>
            <label className="field"><span>Od</span><input type="date" name="start_date" required /></label>
            <label className="field"><span>Do</span><input type="date" name="end_date" required /></label>
          </div>
          <label className="field"><span>Poznámka {absenceType === "OTHER" ? <small>povinné pri type „Iné“</small> : <small>voliteľné</small>}</span><textarea name="note" rows={2} maxLength={1000} placeholder="Doplňujúca informácia…" required={absenceType === "OTHER"} /></label>
          <label className="field"><span>Príloha <small>voliteľné, napr. potvrdenie od lekára</small></span><input type="file" accept="image/*,application/pdf" onChange={(event) => setPendingAbsenceAttachment(event.target.files?.[0] ?? null)} disabled={busy} /></label>
          {pendingAbsenceAttachment && <p className="muted">Vybraná príloha: {pendingAbsenceAttachment.name}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="invite-success" role="status">{notice}</p>}
          <div className="form-actions"><button className="button button-primary" disabled={busy}><Plus size={15} />{busy ? "Odosielam…" : "Odoslať žiadosť"}</button></div>
        </form>
      </section>
      <section className="records-section">
        <div className="section-title-row"><div><h2><ClipboardList size={17} /> Neprítomnosti</h2><p>{isManager ? "Žiadosti celého tímu." : "Vaše žiadosti o neprítomnosť."}</p></div><span className="count-pill">{(isManager ? absenceRequests : absenceRequests.filter((request) => request.user_id === session?.user.id)).length} žiadostí</span></div>
        {(() => {
          const visibleAbsences = (isManager ? absenceRequests : absenceRequests.filter((request) => request.user_id === session?.user.id))
            .slice()
            .sort((a, b) => (a.status === "PENDING") === (b.status === "PENDING") ? b.start_date.localeCompare(a.start_date) : a.status === "PENDING" ? -1 : 1);
          if (visibleAbsences.length === 0) {
            return <div className="panel empty-state"><span className="soft-icon"><Palmtree size={19} /></span><strong>Zatiaľ žiadne žiadosti o neprítomnosť</strong><p>{isManager ? "Keď niekto nahlási neprítomnosť, zobrazí sa tu." : "Nahláste dovolenku, home office alebo inú neprítomnosť vyššie."}</p></div>;
          }
          return <div className="work-order-list">{visibleAbsences.map((request) => {
            const member = roster.find((person) => person.user_id === request.user_id);
            const AbsenceIcon = ABSENCE_TYPE_ICONS[request.type];
            return <article className="panel work-order-card" id={`absence-${request.id}`} key={request.id}>
              <div className="work-order-heading">
                <div><span className="eyebrow">NEPRÍTOMNOSŤ</span><h2><AbsenceIcon size={16} /> {ABSENCE_TYPE_LABELS[request.type]}</h2></div>
                <span className={`status-pill status-${request.status.toLowerCase()}`}>{absenceStatusName(request.status)}</span>
              </div>
              <div className="work-order-meta">
                {isManager && <span><Users size={14} />{member?.full_name || member?.email || "Bývalý zamestnanec"}</span>}
                <span><Clock3 size={14} />{dateLabel(`${request.start_date}T12:00:00`)} – {dateLabel(`${request.end_date}T12:00:00`)}</span>
              </div>
              {request.note && <p className="work-order-description">{request.note}</p>}
              {request.review_note && <p className="work-order-description"><b>Poznámka vedenia:</b> {request.review_note}</p>}
              {request.attachment_path && <button type="button" className="button button-outline button-small" onClick={() => void openAbsenceAttachment(request.attachment_path!)}><Paperclip size={13} /> {request.attachment_file_name || "Príloha"}</button>}
              {isManager && request.status === "PENDING" && <div className="absence-actions">
                <button className="button button-primary button-small" disabled={busy} onClick={() => void reviewAbsenceRequest(request.id, "APPROVED")}>Schváliť</button>
                <button className="button button-outline button-small" disabled={busy} onClick={() => void reviewAbsenceRequest(request.id, "REJECTED")}>Zamietnuť</button>
              </div>}
              {!isManager && request.status === "PENDING" && <div className="absence-actions">
                <button className="button button-outline button-small" disabled={busy} onClick={() => void cancelAbsenceRequest(request.id)}>Zrušiť žiadosť</button>
              </div>}
            </article>;
          })}</div>;
        })()}
      </section>
    </section>
  );

  const renderCustomers = () => {
    const salespeople = roster.filter((member) => member.active && member.is_salesperson);
    return (
      <section className="content-page">
        <header className="dashboard-title-row">
          <div><span className="eyebrow">OBCHODNÁ EVIDENCIA</span><h1>Zákazníci</h1><p>Každý obchodník spravuje svoju databázu zákazníkov.</p></div>
          <div className="customer-export-actions">
            <button className="button button-primary button-small" onClick={() => { setEditingCustomer(null); setError(""); setNotice(""); setShowCustomerForm(true); }}><Plus size={14} /> Nový zákazník</button>
            <button className="button button-outline button-small" onClick={downloadCustomersCsv}><Download size={14} /> Excel (CSV)</button>
            <button className="button button-outline button-small" onClick={printCustomers}><Printer size={14} /> Exportovať PDF</button>
          </div>
        </header>
        <section className="panel customer-toolbar">
          <label className="field customer-search"><span>Vyhľadávanie</span><span className="search-input"><Search size={16} /><input type="search" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Meno, lokalita, produkt alebo kontakt" /></span></label>
          {isCompanyOwner && <label className="field"><span>Obchodník</span><select value={customerOwnerId} onChange={(event) => setCustomerOwnerId(event.target.value)}><option value="ALL">Všetci obchodníci</option>{salespeople.map((member) => <option key={member.user_id} value={member.user_id}>{member.full_name || member.email}</option>)}</select></label>}
        </section>
        {activeMembership?.is_salesperson && <section className="panel customer-sheets-panel">
          <div className="customer-sheets-heading">
            <div><span className="eyebrow">GOOGLE TABUĽKY</span><h2><FileSpreadsheet size={18} /> Synchronizácia zákazníkov</h2>
              <p>{googleSheetsConnection?.connected
                ? `Tabuľka je prepojená${googleSheetsConnection.lastSyncAt ? ` · naposledy synchronizovaná ${new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(googleSheetsConnection.lastSyncAt))}` : ""}.`
                : "Prepojte svoju tabuľku. Synchronizácia zmien aj vymazaní sa spúšťa ručne."}</p>
            </div>
            <div className="calendar-google-actions">
              {googleSheetsConnection?.connected && <button className="button button-outline button-small" disabled={googleSheetsBusy} onClick={() => void syncGoogleSheetsCustomers()}><RefreshCw size={13} /> {googleSheetsBusy ? "Synchronizujem…" : "Synchronizovať"}</button>}
              {googleSheetsConnection?.configured && <button className="button button-quiet button-small" disabled={googleSheetsBusy} onClick={() => void disconnectGoogleSheets()}>Odpojiť</button>}
            </div>
          </div>
          {googleSheetsError && <p className="form-error" role="alert">{googleSheetsError}</p>}
          {googleSheetsMessage && <p className="invite-success" role="status">{googleSheetsMessage}</p>}
          <details className="customer-sheets-guide" open={!googleSheetsConnection?.connected}>
            <summary>Návod na prepojenie Google Tabuľky</summary>
            <ol>
              <li>Otvorte svoju existujúcu Google Tabuľku a kliknite na <strong>Rozšírenia → Apps Script</strong>.</li>
              <li>Nižšie kliknite na <strong>Vytvoriť bezpečný kľúč a skript</strong>, skopírujte skript, vložte ho do editora a uložte. Ak ste už skript vložili, nahraďte celý starý kód novým.</li>
              <li>Spustite <code>setupWorkena</code> a povoľte prístup. Skript vyberie hárok s hlavičkami a zákazníckymi riadkami (aj keď existuje prázdny hárok „Workena“); vaše údaje nemaže ani nepresúva. Potom zvoľte <strong>Nasadiť → Nové nasadenie → Webová aplikácia</strong>: „Spúšťať ako: Ja“, „Kto má prístup: Všetci (Anyone)“. Kliknite <strong>Nasadiť</strong> a povoľte prístup.</li>
              <li>Skopírujte <strong>URL webovej aplikácie</strong> (končí na <code>/exec</code>), vložte ju nižšie a kliknite na <strong>Prepojiť tabuľku</strong>. Potom už stačí kliknúť na <strong>Synchronizovať</strong>.</li>
            </ol>
            <p className="muted">Ak ste webovú aplikáciu už nasadili, otvorte <strong>Nasadiť → Spravovať nasadenia → Upraviť</strong> (ceruzka), nastavte prístup na <strong>Všetci (Anyone)</strong>, zvoľte <strong>Nová verzia</strong> a znova kliknite na <strong>Nasadiť</strong>. Bez tohto nastavenia Google vráti chybu 401. Ak možnosť „Všetci (Anyone)“ chýba, musí ju povoliť správca Google Workspace.</p>
            <p className="muted">Existujúce stĺpce „Dátum“, „Meno“, „Lokalita“, „Odkiaľ prišiel dopyt“, „Produkty“, dátum CP, kontakty, „Cca bez DPH“ a zaškrtávacie polia stavov sa rozpoznajú. Pomocné ID stĺpce pridá skript a skryje ich. „Poznámky“ zostanú v tabuľke zachované, ale nezobrazia sa vo Workene.</p>
            <p className="muted">Prázdne bunky sa pri synchronizácii považujú za „bez zmeny“ a nevymažú existujúcu hodnotu na druhej strane. Ak chcete odstrániť zákazníka, vymažte celý riadok v tabuľke.</p>
            <p className="muted">Každý obchodník pripája svoju tabuľku a synchronizujú sa iba jeho zákazníci. Zmeny a vymazania sa prenesú podľa času poslednej úpravy. Zákazníka v tabuľke vymažte odstránením celého riadka, nie vymazaním jeho buniek. Skryté stĺpce s ID a časom úpravy aj skrytý pomocný hárok ponechajte zachované.</p>
            <div className="customer-sheets-setup">
              <button className="button button-outline button-small" disabled={googleSheetsBusy} onClick={() => void createGoogleSheetsScript()}>
                <Copy size={13} /> {googleSheetsConnection?.configured ? "Vytvoriť nový kľúč a skript" : "Vytvoriť bezpečný kľúč a skript"}
              </button>
              {googleSheetsSecret && <>
                <label className="field"><span>Skript s vaším jedinečným kľúčom</span><textarea className="customer-sheets-script" readOnly value={GOOGLE_SHEETS_APPS_SCRIPT.replace("__WORKENA_SHARED_SECRET__", googleSheetsSecret)} /></label>
                <button className="button button-outline button-small" onClick={() => void copyGoogleSheetsScript()}><Copy size={13} /> Skopírovať celý skript</button>
              </>}
              <form className="customer-sheets-url" onSubmit={(event) => void configureGoogleSheets(event)}>
                <label className="field"><span>URL nasadenej webovej aplikácie</span><input type="url" value={googleSheetsWebAppUrl} onChange={(event) => setGoogleSheetsWebAppUrl(event.target.value)} placeholder="https://script.google.com/macros/s/…/exec" required /></label>
                <button className="button button-primary button-small" disabled={googleSheetsBusy || !googleSheetsConnection?.configured}>{googleSheetsBusy ? "Overujem…" : "Prepojiť tabuľku"}</button>
              </form>
            </div>
          </details>
        </section>}
        {notice && <p className="invite-success" role="status">{notice}</p>}
        {showCustomerForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) {
            setShowCustomerForm(false);
            setEditingCustomer(null);
          }
        }}>
        <section className="panel detail-modal work-order-create-modal" role="dialog" aria-modal="true" aria-labelledby="customer-form-title">
          <div className="modal-heading"><div><span className="eyebrow">ZÁKAZNÍCI</span><h2 id="customer-form-title">{editingCustomer ? "Upraviť zákazníka" : "Pridať zákazníka"}</h2><p>Kontaktné a obchodné údaje sú viditeľné iba pridelenému obchodníkovi a vedeniu.</p></div><button type="button" className="logout-button" aria-label="Zavrieť formulár" disabled={busy} onClick={() => { setShowCustomerForm(false); setEditingCustomer(null); }}><X size={18} /></button></div>
          <form key={editingCustomer?.id ?? "new-customer"} className="form-stack" onSubmit={(event) => void saveCustomer(event)}>
            <div className="form-grid">
              <label className="field"><span>Dátum</span><input type="date" name="customer_date" defaultValue={editingCustomer?.customer_date ?? localDateKey(new Date())} required /></label>
              <label className="field"><span>Meno</span><input name="full_name" defaultValue={editingCustomer?.full_name ?? ""} minLength={2} maxLength={160} required /></label>
              <label className="field"><span>Lokalita</span><input name="location" defaultValue={editingCustomer?.location ?? ""} minLength={2} maxLength={250} required /></label>
              <label className="field"><span>Odkiaľ prišiel dopyt</span><input name="lead_source" defaultValue={editingCustomer?.lead_source ?? ""} maxLength={160} placeholder="Odporúčanie, web, reklama…" required /></label>
              <label className="field"><span>Produkt</span><input name="product" defaultValue={editingCustomer?.product ?? ""} maxLength={200} required /></label>
              <label className="field"><span>CP poslaná dňa <small>voliteľné</small></span><input type="date" name="quote_sent_date" defaultValue={editingCustomer?.quote_sent_date ?? ""} /></label>
              <label className="field"><span>Kontaktné údaje</span><input name="contact_details" defaultValue={editingCustomer?.contact_details ?? ""} maxLength={400} placeholder="Telefón, e-mail…" required /></label>
              <label className="field"><span>Približná cena (€) <small>voliteľné</small></span><input type="number" name="estimated_price" min="0" step="0.01" defaultValue={editingCustomer?.estimated_price ?? ""} /></label>
              <label className="field"><span>Stav</span><select name="status" defaultValue={editingCustomer?.status ?? "NO_RESPONSE"}><option value="APPROVED">Schválená</option><option value="REJECTED">Zamietnutá</option><option value="NO_RESPONSE">Bez odpovede</option></select></label>
              {isCompanyOwner && <label className="field"><span>Obchodník</span><select name="salesperson_id" defaultValue={editingCustomer?.salesperson_id ?? (activeMembership?.is_salesperson ? session?.user.id : salespeople[0]?.user_id)} required>{salespeople.map((member) => <option key={member.user_id} value={member.user_id}>{member.full_name || member.email}</option>)}</select></label>}
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="form-actions">
              <button type="button" className="button button-quiet" disabled={busy} onClick={() => { setShowCustomerForm(false); setEditingCustomer(null); }}>Zrušiť</button>
              <button className="button button-primary" disabled={busy || salespeople.length === 0}>{busy ? "Ukladám…" : editingCustomer ? "Uložiť zmeny" : "Pridať zákazníka"}</button>
            </div>
            {salespeople.length === 0 && <p className="muted">Najskôr v časti Tím udeľte aspoň jednému členovi právo Obchodník.</p>}
          </form>
        </section></div>}
        <section className="records-section">
          <div className="section-title-row"><div><h2><Users size={17} /> Databáza zákazníkov</h2><p>{visibleCustomers.length} záznamov</p></div></div>
          {visibleCustomers.length === 0
            ? <div className="panel empty-state"><span className="soft-icon"><Users size={19} /></span><strong>Žiadni zákazníci</strong><p>Pridajte prvý záznam alebo upravte filter vyhľadávania.</p></div>
            : <div className="panel customer-table-wrap"><table className="customer-table">
              <thead><tr><th>Dátum</th><th>Meno</th><th>Lokalita</th><th>Dopyt</th><th>Produkt</th><th>CP poslaná</th><th>Kontakt</th><th>Približná cena</th><th>Stav</th>{isCompanyOwner && <th>Obchodník</th>}<th>Akcie</th></tr></thead>
              <tbody>{visibleCustomers.map((customer) => {
                const salesperson = roster.find((member) => member.user_id === customer.salesperson_id);
                return <tr key={customer.id}>
                  <td>{dateLabel(`${customer.customer_date}T12:00:00`)}</td><td><strong>{customer.full_name}</strong></td><td>{customer.location}</td><td>{customer.lead_source}</td><td>{customer.product}</td><td>{customer.quote_sent_date ? dateLabel(`${customer.quote_sent_date}T12:00:00`) : "—"}</td><td>{customer.contact_details}</td><td>{customer.estimated_price === null ? "—" : `${hoursLabel(Number(customer.estimated_price))} €`}</td>
                  <td><select aria-label={`Stav zákazníka ${customer.full_name}`} value={customer.status} disabled={busy} onChange={(event) => void changeCustomerStatus(customer, event.target.value as CustomerStatus)}><option value="APPROVED">Schválená</option><option value="REJECTED">Zamietnutá</option><option value="NO_RESPONSE">Bez odpovede</option></select><small className={`customer-status customer-status-${customer.status.toLowerCase()}`}>{customerStatusName(customer.status)}</small></td>
                  {isCompanyOwner && <td>{salesperson?.full_name || salesperson?.email || "—"}</td>}
                  <td><div className="customer-row-actions"><button className="button button-outline button-small" onClick={() => { setEditingCustomer(customer); setError(""); setNotice(""); setShowCustomerForm(true); }}><Pencil size={13} /> Upraviť</button><button className="button button-danger button-small" disabled={busy} onClick={() => void deleteCustomer(customer)}><Trash2 size={13} /> Vymazať</button></div></td>
                </tr>;
              })}</tbody>
            </table></div>}
        </section>
      </section>
    );
  };

  const renderWorkOrders = () => {
    const employees = roster.filter((member) => member.active && (member.role === "EMPLOYEE" || member.is_employee));
    const today = localDateKey(new Date().toISOString());
    const measuredBySalesperson = (order: WorkOrder) => order.status === "MEASURED"
      && (order.assignees ?? []).some((assignment) => assignment.accepted_at && !assignment.declined_at
        && roster.some((member) => member.user_id === assignment.user_id && member.is_salesperson));
    const categories = isManager
      ? [
        { id: "SENT", label: "Poslané zamestnancom", count: workOrders.filter((order) => order.status !== "DONE" && (order.assignees ?? []).some((assignment) => !assignment.accepted_at && !assignment.declined_at)).length },
        { id: "RETURNED", label: "Vrátené", count: workOrders.filter((order) => order.status !== "DONE" && (order.assignees ?? []).some((assignment) => assignment.declined_at && !assignment.reassigned_at)).length },
        { id: "ACCEPTED", label: "Prijaté", count: workOrders.filter((order) => order.status === "ASSIGNED" && (order.assignees ?? []).some((assignment) => assignment.accepted_at && !assignment.declined_at)).length },
        { id: "WORKING", label: "Pracuje sa", count: workOrders.filter((order) => ["IN_PROGRESS", "WORKING"].includes(order.status) || order.status === "MEASURED" && !measuredBySalesperson(order)).length },
        { id: "DONE", label: "Vybavené", count: workOrders.filter((order) => order.status === "DONE" || measuredBySalesperson(order)).length },
      ]
      : [
        { id: "SENT", label: "Pridelené", count: workOrders.filter((order) => (order.assignees ?? []).some((assignment) => assignment.user_id === session?.user.id && !assignment.accepted_at && !assignment.declined_at)).length },
        { id: "MINE", label: "Moje", count: workOrders.filter((order) => (order.assignees ?? []).some((assignment) => assignment.user_id === session?.user.id && assignment.accepted_at && !assignment.declined_at) && order.status !== "DONE" && !(activeMembership?.is_salesperson && order.status === "MEASURED")).length },
        { id: "RETURNED", label: "Odmietnuté", count: workOrders.filter((order) => (order.assignees ?? []).some((assignment) => assignment.user_id === session?.user.id && assignment.declined_at)).length },
        { id: "DONE", label: "Vybavené", count: workOrders.filter((order) => ((order.assignees ?? []).some((assignment) => assignment.user_id === session?.user.id && !assignment.declined_at) && order.status === "DONE") || (activeMembership?.is_salesperson && (order.assignees ?? []).some((assignment) => assignment.user_id === session?.user.id && assignment.accepted_at && !assignment.declined_at) && order.status === "MEASURED")).length },
      ];
    const filteredWorkOrders = workOrders.filter((order) => {
      const currentAssignment = (order.assignees ?? []).find((assignment) => assignment.user_id === session?.user.id);
      if (workOrderDateFilter && order.due_date !== workOrderDateFilter) return false;
      if (workOrderTab === "ALL") return true;
      if (workOrderTab === "SENT") return isManager
        ? order.status !== "DONE" && (order.assignees ?? []).some((assignment) => !assignment.accepted_at && !assignment.declined_at)
        : Boolean(currentAssignment && !currentAssignment.accepted_at && !currentAssignment.declined_at);
      if (workOrderTab === "RETURNED") return isManager
        ? order.status !== "DONE" && (order.assignees ?? []).some((assignment) => assignment.declined_at && !assignment.reassigned_at)
        : Boolean(currentAssignment?.declined_at);
      if (workOrderTab === "ACCEPTED") return order.status === "ASSIGNED" && (order.assignees ?? []).some((assignment) => assignment.accepted_at && !assignment.declined_at);
      if (workOrderTab === "WORKING") return ["IN_PROGRESS", "WORKING"].includes(order.status) || order.status === "MEASURED" && !measuredBySalesperson(order);
      if (workOrderTab === "MINE") return Boolean(currentAssignment?.accepted_at && !currentAssignment.declined_at) && order.status !== "DONE" && !(activeMembership?.is_salesperson && order.status === "MEASURED");
      if (workOrderTab === "DONE") return isManager
        ? order.status === "DONE" || measuredBySalesperson(order)
        : Boolean(currentAssignment && !currentAssignment.declined_at && (order.status === "DONE" || currentAssignment.accepted_at && activeMembership?.is_salesperson && order.status === "MEASURED"));
      return true;
    }).sort((left, right) => {
      if (workOrderSort === "DUE") {
        return left.due_date.localeCompare(right.due_date) || (left.starts_at ?? "").localeCompare(right.starts_at ?? "");
      }
      const getAssignmentDate = (order: WorkOrder) => {
        const matchingAssignments = (order.assignees ?? []).filter((assignment) => isManager || assignment.user_id === session?.user.id);
        return matchingAssignments.map((assignment) => assignment.created_at).sort()[0] ?? order.created_at;
      };
      return getAssignmentDate(left).localeCompare(getAssignmentDate(right));
    });
    const calendarOrders = workOrders.flatMap((order) => {
      if (order.status === "DONE") return [];
      const assignments = order.assignees ?? [];
      const assigneeIds = assignments.length
        ? assignments
          .filter((assignment) => !assignment.declined_at && !assignment.reassigned_at)
          .map((assignment) => assignment.user_id)
        : [order.assignee_id];
      return [...new Set(assigneeIds)]
        .filter((userId) => isCompanyOwner
          ? calendarEmployeeFilter === "ALL" || calendarEmployeeFilter === userId
          : userId === session?.user.id)
        .map((userId) => ({
          order,
          userId,
          member: roster.find((person) => person.user_id === userId),
        }));
    });
    const getCalendarEmployeeColor = (userId: string) => {
      const rosterIndex = roster.findIndex((member) => member.user_id === userId);
      const stableIndex = rosterIndex >= 0
        ? rosterIndex
        : [...userId].reduce((total, character) => total + character.charCodeAt(0), 0);
      const hue = (stableIndex * 137.508 + 24) % 360;
      return {
        backgroundColor: `hsl(${hue} 70% 92%)`,
        borderLeft: `3px solid hsl(${hue} 55% 48%)`,
        color: `hsl(${hue} 45% 28%)`,
      };
    };
    const calendarEmployees = roster
      .filter((member) => member.active && (member.role === "EMPLOYEE" || member.is_employee))
      .map((member) => ({ userId: member.user_id, member }));
    const calendarMonthStart = new Date(`${workOrderMonth}-01T12:00:00`);
    const calendarOffset = (calendarMonthStart.getDay() + 6) % 7;
    const calendarDayCount = new Date(calendarMonthStart.getFullYear(), calendarMonthStart.getMonth() + 1, 0).getDate();
    const calendarCellCount = Math.ceil((calendarOffset + calendarDayCount) / 7) * 7;
    const calendarCells = Array.from({ length: calendarCellCount }, (_, index) => {
      const day = index - calendarOffset + 1;
      return day > 0 && day <= calendarDayCount
        ? `${workOrderMonth}-${String(day).padStart(2, "0")}`
        : null;
    });
    const visibleCalendarWorkOrderIds = new Set(calendarOrders.map(({ order }) => order.id));
    const displayedGoogleCalendarEvents = googleCalendarEventsMonth === workOrderMonth
      ? googleCalendarEvents.filter((event) => !event.workOrderId || !visibleCalendarWorkOrderIds.has(event.workOrderId))
      : [];
    const getCalendarDayItems = (day: string) => {
      const dayOrders = calendarOrders.filter(({ order }) => order.due_date === day);
      return [
        ...dayOrders.map(({ order, userId, member }) => ({
          kind: "order" as const,
          order,
          userId,
          member,
          sortAt: new Date(`${order.due_date}T${order.starts_at ?? "00:00:00"}`).getTime(),
        })),
        ...displayedGoogleCalendarEvents.flatMap((event) => {
          const range = googleCalendarEventDateRange(event);
          if (day < range.start || day > range.end) return [];
          const eventStartsToday = range.start === day;
          return [{
            kind: "google" as const,
            event,
            continues: !eventStartsToday,
            sortAt: eventStartsToday
              ? event.start.dateTime
                ? new Date(event.start.dateTime).getTime()
                : new Date(`${day}T00:00:00`).getTime()
              : new Date(`${day}T00:00:00`).getTime(),
          }];
        }),
      ].sort((left, right) => left.sortAt - right.sortAt);
    };
    const calendarDaysWithEvents = calendarCells.flatMap((day) => {
      if (!day) return [];
      const items = getCalendarDayItems(day);
      return items.length ? [{ day, items }] : [];
    });
    const renderCalendarItem = (item: ReturnType<typeof getCalendarDayItems>[number], day: string) => item.kind === "order" ? <button
      className="calendar-order"
      style={getCalendarEmployeeColor(item.userId)}
      key={`order-${item.order.id}-${item.userId}`}
      title={`${item.member?.full_name || item.member?.email || "Zamestnanec"} · ${item.order.title} · ${workOrderStatusName(item.order.status)}`}
      onClick={() => setSelectedCalendarOrder(item.order)}
    >{item.order.time_to_arrange ? "Dohodnúť čas · " : item.order.starts_at ? `${item.order.starts_at.slice(0, 5)} · ` : "Bez času · "}{isCompanyOwner ? `${item.member?.full_name || item.member?.email || "Zamestnanec"} · ` : ""}{item.order.title}</button> : <button
      className="calendar-google-event"
      key={`google-${day}-${item.event.id}`}
      title={`${googleCalendarEventTime(item.event)} · ${item.event.summary || "Udalosť Google Kalendára"}`}
      onClick={() => setSelectedGoogleCalendarEvent(item.event)}
    >{item.continues ? "Pokračuje · " : `${googleCalendarEventTime(item.event)} · `}{item.event.summary || "Udalosť Google Kalendára"}</button>;
    return (
      <section className="content-page">
        <header className="dashboard-title-row">
          <div><span className="eyebrow">PRÁCA V TERÉNE</span><h1>Zákazky</h1><p>Priraďovanie, termíny a priebeh práce na jednotlivých zákazkách.</p></div>
          <button className="button button-primary" onClick={() => setShowWorkOrderForm(true)}><Plus size={16} /> Nová zákazka</button>
        </header>
        {showWorkOrderForm && <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowWorkOrderForm(false);
        }}>
          <section className="panel work-order-create-panel work-order-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-work-order-title">
            <div className="modal-heading"><div><span className="eyebrow">ZÁKAZKY</span><h2 id="new-work-order-title">{isManager ? "Priradiť novú zákazku" : "Pridať vlastnú zákazku"}</h2><p>{isManager ? "Zamestnanec zákazku prijme alebo odmietne." : "Nová zákazka sa pridá do vášho zoznamu."}</p></div><button type="button" className="logout-button" aria-label="Zavrieť formulár" onClick={() => setShowWorkOrderForm(false)}><X size={18} /></button></div>
          {isManager && employees.length === 0
            ? <p className="muted">Najskôr pridajte do tímu aktívneho zamestnanca.</p>
            : <form className="form-stack work-order-form" onSubmit={(event) => void createWorkOrder(event)}>
              <div className="form-grid">
                <label className="field"><span>Názov zákazky</span><input name="title" minLength={2} maxLength={140} placeholder="napr. Elektroinštalácia rodinného domu" required /></label>
                {isManager && <div className="field">
                  <span>Priradiť zamestnancom</span>
                  <div className="assignee-picker">
                    {selectedAssigneeIds.map((assigneeId, index) => <div className="assignee-picker-row" key={`assignee-${index}`}>
                      <select name="assignee_ids" value={assigneeId} required onChange={(event) => setSelectedAssigneeIds((current) => current.map((id, row) => row === index ? event.target.value : id))}>
                        <option value="">Vybrať zamestnanca</option>
                        {employees.filter((employee) => !selectedAssigneeIds.includes(employee.user_id) || employee.user_id === assigneeId).map((employee) => <option key={employee.user_id} value={employee.user_id}>{employee.full_name || employee.email}</option>)}
                      </select>
                      {selectedAssigneeIds.length > 1 && <button type="button" className="button button-outline button-small" aria-label="Odobrať zamestnanca" onClick={() => setSelectedAssigneeIds((current) => current.filter((_, row) => row !== index))}><X size={14} /></button>}
                    </div>)}
                    <button type="button" className="button button-outline button-small" onClick={() => setSelectedAssigneeIds((current) => current.length < employees.length ? [...current, ""] : current)} disabled={selectedAssigneeIds.length >= employees.length}><Plus size={14} /> Ďalší zamestnanec</button>
                  </div>
                </div>}
                <label className="field"><span>Adresa zákazky</span><input name="address" minLength={2} maxLength={250} placeholder="Ulica, mesto" required /></label>
                <label className="field"><span>Dátum</span><input type="date" name="due_date" defaultValue={today} required /></label>
                <label className="field"><span>Čas od <small>voliteľné</small></span><input type="time" name="starts_at" /></label>
                <label className="field"><span>Čas do <small>voliteľné</small></span><input type="time" name="ends_at" /></label>
                <label className="permission-toggle"><input type="checkbox" name="time_to_arrange" /> Čas treba dohodnúť</label>
                <label className="field"><span>Telefón <small>voliteľné</small></span><input type="tel" name="contact_phone" maxLength={40} placeholder="+421 900 000 000" /></label>
              </div>
              <label className="field"><span>Opis práce</span><textarea name="description" rows={4} minLength={2} maxLength={4000} placeholder="Rozsah prác, dôležité pokyny a informácie…" required /></label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setShowWorkOrderForm(false)}>Zrušiť</button><button className="button button-primary" disabled={busy}><Plus size={15} />{busy ? "Ukladám…" : "Uložiť zákazku"}</button></div>
            </form>}
          </section>
        </div>}
        <section className="records-section">
          <div className="section-title-row">
            <div><h2><CalendarDays size={17} /> Kalendár zákaziek</h2><p>Aktívne zákazky s termínom v mesiaci.</p></div>
            <div className="calendar-heading-actions">
              <button className="button button-outline button-small" onClick={() => setCalendarExpanded((expanded) => !expanded)}>{calendarExpanded ? "Zmenšiť kalendár" : "Roztiahnuť kalendár"}</button>
              <div className="attendance-month-switch">
              <button className="employee-hours-toggle" aria-label="Predchádzajúci mesiac" onClick={() => {
                const previous = new Date(`${workOrderMonth}-01T12:00:00`);
                previous.setMonth(previous.getMonth() - 1);
                setWorkOrderMonth(localDateKey(previous).slice(0, 7));
              }}><ArrowLeft size={16} /></button>
              <strong>{new Intl.DateTimeFormat("sk-SK", { month: "long", year: "numeric" }).format(calendarMonthStart)}</strong>
              <button className="employee-hours-toggle" aria-label="Nasledujúci mesiac" onClick={() => {
                const next = new Date(`${workOrderMonth}-01T12:00:00`);
                next.setMonth(next.getMonth() + 1);
                setWorkOrderMonth(localDateKey(next).slice(0, 7));
              }}><ArrowRight size={16} /></button>
              </div>
            </div>
          </div>
          {activeMembership?.active && <div className="calendar-google-sync">
            <div><strong>Google Kalendár</strong><small>{googleCalendarConnected
              ? `Prepojený · udalosti sa zobrazujú iba na čítanie${googleCalendarLastSync ? ` · zákazky synchronizované ${timeLabel(googleCalendarLastSync)}` : ""}`
              : "Prepojte svoj Google účet na zobrazenie udalostí a obojsmernú synchronizáciu priradených zákaziek."}</small></div>
            <div className="calendar-google-actions">
              {googleCalendarConnected && <button className="button button-outline button-small" disabled={googleCalendarBusy} onClick={() => {
                setGoogleCalendarBusy(true);
                void syncGoogleCalendarNow().catch((reason: unknown) => setGoogleCalendarMessage(errorText(reason))).finally(() => setGoogleCalendarBusy(false));
              }}>{googleCalendarBusy ? "Synchronizujem…" : "Synchronizovať teraz"}</button>}
              <button className="button button-outline button-small" disabled={googleCalendarBusy} onClick={() => void connectGoogleCalendar()}>
                {googleCalendarBusy ? "Pripájam…" : googleCalendarConnected ? "Znovu pripojiť účet" : "Prepojiť Google"}
              </button>
            </div>
            {googleCalendarMessage && <p className="form-error" role="alert">{googleCalendarMessage}</p>}
            {googleCalendarEventsLoading && <p className="calendar-google-events-status" role="status">Načítavam udalosti Google Kalendára…</p>}
            {googleCalendarEventsError && <p className="form-error" role="alert">{googleCalendarEventsError}</p>}
          </div>}
          {googleCalendarConnected && <div className="calendar-legend">
            <span className="calendar-legend-item"><i className="calendar-google-event-swatch" />Osobné udalosti z Google Kalendára</span>
          </div>}
          {isCompanyOwner && calendarEmployees.length > 0 && <div className="calendar-legend" aria-label="Farby zákaziek podľa zamestnanca">
            <label className="calendar-employee-filter"><span>Zamestnanec</span><select value={calendarEmployeeFilter} onChange={(event) => setCalendarEmployeeFilter(event.target.value)}>
              <option value="ALL">Všetci zamestnanci</option>
              {calendarEmployees.map(({ userId, member }) => <option key={userId} value={userId}>{member?.full_name || member?.email}</option>)}
            </select></label>
            {calendarEmployees.map(({ userId, member }) => <span className="calendar-legend-item" key={userId}>
              <i style={getCalendarEmployeeColor(userId)} />
              {member?.full_name || member?.email}
            </span>)}
          </div>}
          <div className={`work-order-calendar ${calendarExpanded ? "work-order-calendar-expanded" : ""}`} role="grid" aria-label="Kalendár zákaziek">
            {["Po", "Ut", "St", "Št", "Pi", "So", "Ne"].map((weekday) => <div className="calendar-weekday" role="columnheader" key={weekday}>{weekday}</div>)}
            {calendarCells.map((day, index) => {
              const dayItems = day ? getCalendarDayItems(day) : [];
              return <div className={`calendar-day ${day ? "" : "calendar-day-empty"}`} role="gridcell" key={`${day ?? "empty"}-${index}`}>
                {day && <><strong className="calendar-day-number">{Number(day.slice(-2))}</strong>{dayItems.map((item) => renderCalendarItem(item, day))}</>}
              </div>;
            })}
          </div>
          <div className="calendar-agenda" aria-label="Udalosti kalendára zoradené podľa dňa">
            {calendarDaysWithEvents.length
              ? calendarDaysWithEvents.map(({ day, items }) => <section className="calendar-agenda-day" key={day}>
                <header className="calendar-agenda-date">
                  <strong>{Number(day.slice(-2))}</strong>
                  <span>{new Intl.DateTimeFormat("sk-SK", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00`))}</span>
                </header>
                <div className="calendar-agenda-items">{items.map((item) => item.kind === "order" ? <button
                  className="calendar-agenda-item calendar-agenda-order"
                  style={getCalendarEmployeeColor(item.userId)}
                  key={`agenda-order-${item.order.id}-${item.userId}`}
                  onClick={() => setSelectedCalendarOrder(item.order)}
                >
                  <strong>{item.order.time_to_arrange ? "Dohodnúť čas" : item.order.starts_at ? item.order.starts_at.slice(0, 5) : "Bez času"}</strong>
                  <span>{item.order.title}</span>
                  {isCompanyOwner && <small>{item.member?.full_name || item.member?.email || "Zamestnanec"}</small>}
                </button> : <button
                  className="calendar-agenda-item calendar-agenda-google"
                  key={`agenda-google-${day}-${item.event.id}`}
                  onClick={() => setSelectedGoogleCalendarEvent(item.event)}
                >
                  <strong>{item.continues ? "Pokračuje" : googleCalendarEventTime(item.event)}</strong>
                  <span>{item.event.summary || "Udalosť Google Kalendára"}</span>
                  <small>Google Kalendár</small>
                </button>)}</div>
              </section>)
              : <p className="calendar-agenda-empty">V tomto mesiaci zatiaľ nie sú naplánované žiadne udalosti ani zákazky.</p>}
          </div>
        </section>
        <nav className="work-order-tabs" aria-label="Podkarty zákaziek">
          {categories.map((category) => <button key={category.id} type="button" className={`work-order-tab ${workOrderTab === category.id ? "active" : ""}`} onClick={() => setWorkOrderTab(category.id)}>
            <span>{category.label}</span><b>{category.count}</b>
          </button>)}
        </nav>
        <section className="records-section">
          <div className="section-title-row"><div><h2><ClipboardList size={17} /> Zoznam zákaziek</h2><p>{isManager ? "Zákazky celej firmy." : "Zákazky priradené vám."}</p></div><span className="count-pill">{filteredWorkOrders.length} zákaziek</span></div>
          <div className="panel work-order-filter-bar">
            <label className="field"><span>Usporiadať podľa</span><select value={workOrderSort} onChange={(event) => setWorkOrderSort(event.target.value as "DUE" | "ASSIGNED")}><option value="DUE">Najbližšieho termínu</option><option value="ASSIGNED">Dátumu pridelenia</option></select></label>
            <label className="field"><span>Filtrovať podľa termínu</span><input type="date" value={workOrderDateFilter} onChange={(event) => setWorkOrderDateFilter(event.target.value)} /></label>
            {workOrderDateFilter && <button className="button button-quiet button-small" onClick={() => setWorkOrderDateFilter("")}>Zrušiť filter</button>}
          </div>
          {workOrders.length === 0
            ? <div className="panel empty-state"><span className="soft-icon"><ClipboardList size={19} /></span><strong>Zatiaľ tu nie sú žiadne zákazky</strong><p>{isManager ? "Priraďte prvú zákazku pracovníkovi." : "Keď vám vlastník priradí zákazku, zobrazí sa tu."}</p></div>
            : filteredWorkOrders.length === 0
              ? <div className="panel empty-state"><strong>V tejto podkarte nie sú zákazky</strong><p>Zmeňte filter alebo vyberte inú podkartu.</p></div>
              : <div className="work-order-list">{filteredWorkOrders.map((workOrder) => {
              const assignments = workOrder.assignees ?? [];
              const assigneeMembers = assignments.map((assignment) => ({
                assignment,
                member: roster.find((person) => person.user_id === assignment.user_id),
              }));
              const currentAssignment = assignments.find((assignment) => assignment.user_id === session?.user.id);
              const canUpdate = currentAssignment?.accepted_at !== null && currentAssignment !== undefined && !currentAssignment.declined_at;
              const needsAcceptance = currentAssignment && workOrder.status !== "DONE" && !currentAssignment.accepted_at && !currentAssignment.declined_at;
              const overdue = workOrder.status !== "DONE" && workOrder.due_date < today;
              const canManageOrder = isManager || workOrder.created_by === session?.user.id;
              const phoneDigits = workOrder.contact_phone?.replace(/\D/g, "") ?? "";
              const isExpanded = expandedWorkOrderId === workOrder.id;
              const canReassignTo = employees.filter((employee) => !assignments.some((assignment) => assignment.user_id === employee.user_id));
              return <article className="panel work-order-card" id={`work-order-${workOrder.id}`} key={workOrder.id}>
                <div className="work-order-heading">
                  <div><span className="eyebrow">ZÁKAZKA</span><h2>{workOrder.title}</h2></div>
                  <span className={`status-pill work-order-status work-order-${workOrder.status.toLowerCase()}`}>{workOrderStatusName(workOrder.status)}</span>
                </div>
                <div className="work-order-summary">
                  <span className={overdue ? "work-order-overdue" : ""}><CalendarDays size={14} />{dateLabel(`${workOrder.due_date}T12:00:00`)}{workOrder.starts_at ? ` · ${workOrder.starts_at.slice(0, 5)}` : workOrder.time_to_arrange ? " · dohodnúť čas" : ""}</span>
                  {currentAssignment?.declined_at && <span className="work-order-returned-label">Odmietnutá</span>}
                  {needsAcceptance && <span>Čaká na vaše rozhodnutie</span>}
                  <button type="button" className="button button-outline button-small" aria-expanded={isExpanded} onClick={() => setExpandedWorkOrderId((current) => current === workOrder.id ? null : workOrder.id)}>{isExpanded ? "Skryť podrobnosti" : "Zobraziť podrobnosti"}{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                </div>
                {needsAcceptance && <div className="work-order-accept-panel">
                  <span>Zákazka čaká na vaše potvrdenie.</span>
                  <div className="work-order-actions">
                    <button className="button button-primary button-small" disabled={busy} onClick={() => void acceptWorkOrder(workOrder.id)}>Prijať zákazku</button>
                    <button className="button button-danger button-small" disabled={busy} onClick={() => void rejectWorkOrder(workOrder.id)}>Odmietnuť zákazku</button>
                  </div>
                </div>}
                {isManager && workOrder.status !== "DONE" && assignments.some((assignment) => assignment.declined_at && !assignment.reassigned_at) && <div className="work-order-reassign-panel">
                  <span>Zákazku odmietol zamestnanec: {assigneeMembers.filter(({ assignment }) => assignment.declined_at && !assignment.reassigned_at).map(({ member }) => member?.full_name || member?.email || "Zamestnanec").join(", ")}.</span>
                  {canReassignTo.length > 0
                    ? <form className="work-order-reassign-form" onSubmit={(event) => void reassignDeclinedWorkOrder(event, workOrder)}>
                      <select name="assignee_id" aria-label="Prideliť zákazku ďalšiemu zamestnancovi" defaultValue="" required><option value="" disabled>Vybrať zamestnanca</option>{canReassignTo.map((employee) => <option key={employee.user_id} value={employee.user_id}>{employee.full_name || employee.email}</option>)}</select>
                      <button className="button button-outline button-small" disabled={busy}>Prideliť inému</button>
                    </form>
                    : <small>Všetci dostupní zamestnanci už majú túto zákazku.</small>}
                </div>}
                {isExpanded && <>
                <div className="work-order-meta">
                  <span><MapPin size={14} />{workOrder.address}</span>
                  <span className={overdue ? "work-order-overdue" : ""}><Clock3 size={14} />Termín: {dateLabel(`${workOrder.due_date}T12:00:00`)}{overdue ? " · po termíne" : ""}</span>
                  {workOrder.time_to_arrange
                    ? <span><Clock3 size={14} />Čas treba dohodnúť</span>
                    : (workOrder.starts_at || workOrder.ends_at) && <span><Clock3 size={14} />{workOrder.starts_at?.slice(0, 5) ?? "—"} – {workOrder.ends_at?.slice(0, 5) ?? "—"}</span>}
                  <span><Users size={14} />{assigneeMembers.length
                    ? assigneeMembers.map(({ assignment, member }) => `${member?.full_name || member?.email || "Bývalý zamestnanec"} · ${assignment.declined_at ? "odmietnutá" : assignment.accepted_at ? "prijatá" : "čaká na prijatie"}`).join(", ")
                    : roster.find((member) => member.user_id === workOrder.assignee_id)?.full_name || roster.find((member) => member.user_id === workOrder.assignee_id)?.email || "Bývalý zamestnanec"}</span>
                </div>
                <p className="work-order-description">{workOrder.description}</p>
                <div className="work-order-actions">
                  <a className="button button-outline button-small" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(workOrder.address)}`} target="_blank" rel="noreferrer"><Navigation size={14} /> Navigovať</a>
                  {workOrder.contact_phone && <>
                    <a className="button button-outline button-small" href={`tel:${workOrder.contact_phone}`}><Phone size={14} /> Zavolať</a>
                    <a className="button button-outline button-small" href={`sms:${workOrder.contact_phone}`}><MessageCircle size={14} /> SMS</a>
                    <a className="button button-outline button-small" href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noreferrer"><MessageCircle size={14} /> WhatsApp</a>
                  </>}
                  {canManageOrder && <button className="button button-outline button-small" onClick={() => setEditingOrderId((current) => current === workOrder.id ? null : workOrder.id)}><Pencil size={14} /> Upraviť</button>}
                  {canUpdate && workOrder.status !== "DONE" && <button className="button button-outline button-small" onClick={() => setEditingScheduleOrderId((current) => current === workOrder.id ? null : workOrder.id)}><CalendarDays size={14} /> Upraviť termín</button>}
                  {canManageOrder && workOrder.status !== "DONE" && <button className="button button-outline button-small" disabled={busy} onClick={() => void completeWorkOrder(workOrder)}><CheckCircle2 size={14} /> Dokončené</button>}
                  {canManageOrder && <button className="button button-danger button-small" disabled={busy} onClick={() => void deleteWorkOrder(workOrder)}><Trash2 size={14} /> Vymazať</button>}
                </div>
                {editingOrderId === workOrder.id && <form className="work-order-edit-form form-stack" onSubmit={(event) => void saveWorkOrderDetails(event, workOrder)}>
                  <div className="form-grid">
                    <label className="field"><span>Názov zákazky</span><input name="title" defaultValue={workOrder.title} minLength={2} maxLength={140} required /></label>
                    <label className="field"><span>Adresa zákazky</span><input name="address" defaultValue={workOrder.address} minLength={2} maxLength={250} required /></label>
                    <label className="field"><span>Dátum</span><input type="date" name="due_date" defaultValue={workOrder.due_date} required /></label>
                    <label className="field"><span>Telefón</span><input type="tel" name="contact_phone" defaultValue={workOrder.contact_phone ?? ""} maxLength={40} /></label>
                    <label className="field"><span>Čas od</span><input type="time" name="starts_at" defaultValue={workOrder.starts_at?.slice(0, 5) ?? ""} /></label>
                    <label className="field"><span>Čas do</span><input type="time" name="ends_at" defaultValue={workOrder.ends_at?.slice(0, 5) ?? ""} /></label>
                  </div>
                  <label className="permission-toggle"><input type="checkbox" name="time_to_arrange" defaultChecked={Boolean(workOrder.time_to_arrange)} /> Čas treba dohodnúť</label>
                  <label className="field"><span>Opis</span><textarea name="description" rows={3} defaultValue={workOrder.description} minLength={2} maxLength={4000} required /></label>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  <div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setEditingOrderId(null)}>Zrušiť</button><button className="button button-primary button-small" disabled={busy}>{busy ? "Ukladám…" : "Uložiť zmeny"}</button></div>
                </form>}
                {editingScheduleOrderId === workOrder.id && <form className="work-order-edit-form form-stack" onSubmit={(event) => void saveWorkOrderSchedule(event, workOrder)}>
                  <div className="form-grid">
                    <label className="field"><span>Termín</span><input type="date" name="due_date" defaultValue={workOrder.due_date} required /></label>
                    <label className="field"><span>Čas od <small>voliteľné</small></span><input type="time" name="starts_at" defaultValue={workOrder.starts_at?.slice(0, 5) ?? ""} /></label>
                    <label className="field"><span>Čas do <small>voliteľné</small></span><input type="time" name="ends_at" defaultValue={workOrder.ends_at?.slice(0, 5) ?? ""} /></label>
                  </div>
                  <label className="permission-toggle"><input type="checkbox" name="time_to_arrange" defaultChecked={Boolean(workOrder.time_to_arrange)} /> Čas treba dohodnúť</label>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  <div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setEditingScheduleOrderId(null)}>Zrušiť</button><button className="button button-primary button-small" disabled={busy}>{busy ? "Ukladám…" : "Uložiť termín"}</button></div>
                </form>}
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
                    <label className="field"><span>Stav zákazky</span><select name="status" defaultValue={workOrder.status === "ASSIGNED" ? "IN_PROGRESS" : workOrder.status}><option value="IN_PROGRESS">Rozpracované</option><option value="MEASURED">Zamerané</option><option value="WORKING">Pracuje sa</option><option value="DONE">Dokončené</option></select></label>
                    <label className="field"><span>Použitý materiál <small>voliteľné</small></span><textarea name="employee_materials" rows={2} maxLength={4000} defaultValue={workOrder.employee_materials ?? ""} placeholder="Materiály a množstvá…" /></label>
                    <label className="field"><span>Výkaz vykonanej práce <small>povinný pri dokončení</small></span><textarea name="work_report" rows={3} maxLength={4000} defaultValue={workOrder.work_report ?? ""} placeholder="Popíšte vykonané práce a výsledok…" /></label>
                    <label className="field"><span>Poznámka pre vlastníka <small>voliteľné</small></span><textarea name="employee_note" rows={2} maxLength={2000} defaultValue={workOrder.employee_note ?? ""} placeholder="Doplňujúca informácia k priebehu…" /></label>
                  </div>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  <div className="form-actions"><button className="button button-primary button-small" disabled={busy}>{busy ? "Ukladám…" : workOrder.status === "DONE" ? "Uložiť výkaz" : "Uložiť výkaz zákazky"}</button></div>
                </form>}
                </>}
              </article>;
            })}</div>}
        </section>
      {selectedCalendarOrder && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSelectedCalendarOrder(null);
      }}>
        <section className="panel detail-modal" role="dialog" aria-modal="true" aria-labelledby="calendar-order-title">
          <div className="modal-heading"><div><span className="eyebrow">ZÁKAZKA</span><h2 id="calendar-order-title">{selectedCalendarOrder.title}</h2></div><button className="logout-button" aria-label="Zavrieť podrobnosti" onClick={() => setSelectedCalendarOrder(null)}><X size={18} /></button></div>
          <p><MapPin size={15} /> {selectedCalendarOrder.address}</p>
          <p><CalendarDays size={15} /> {dateLabel(`${selectedCalendarOrder.due_date}T12:00:00`)}{selectedCalendarOrder.time_to_arrange ? " · čas treba dohodnúť" : selectedCalendarOrder.starts_at ? ` · ${selectedCalendarOrder.starts_at.slice(0, 5)} – ${selectedCalendarOrder.ends_at?.slice(0, 5) ?? "—"}` : ""}</p>
          <p className="work-order-description">{selectedCalendarOrder.description}</p>
          {selectedCalendarOrder.contact_phone && <p><Phone size={15} /> {selectedCalendarOrder.contact_phone}</p>}
          <div className="work-order-actions">
            <a className="button button-outline button-small" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedCalendarOrder.address)}`} target="_blank" rel="noreferrer"><Navigation size={14} /> Navigovať</a>
            {selectedCalendarOrder.contact_phone && <a className="button button-outline button-small" href={`tel:${selectedCalendarOrder.contact_phone}`}><Phone size={14} /> Zavolať</a>}
          </div>
          <div className="form-actions"><button className="button button-quiet" onClick={() => setSelectedCalendarOrder(null)}>Zavrieť</button><button className="button button-primary button-small" onClick={() => {
            const orderId = selectedCalendarOrder.id;
            setSelectedCalendarOrder(null);
            window.setTimeout(() => document.getElementById(`work-order-${orderId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
          }}>Otvoriť zákazku</button></div>
        </section>
      </div>}
      {selectedGoogleCalendarEvent && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSelectedGoogleCalendarEvent(null);
      }}>
        <section className="panel detail-modal" role="dialog" aria-modal="true" aria-labelledby="google-calendar-event-title">
          <div className="modal-heading"><div><span className="eyebrow">GOOGLE KALENDÁR · IBA NA ČÍTANIE</span><h2 id="google-calendar-event-title">{selectedGoogleCalendarEvent.summary || "Udalosť Google Kalendára"}</h2></div><button className="logout-button" aria-label="Zavrieť podrobnosti" onClick={() => setSelectedGoogleCalendarEvent(null)}><X size={18} /></button></div>
          <p><CalendarDays size={15} /> {selectedGoogleCalendarEvent.start.date
            ? `${dateLabel(`${selectedGoogleCalendarEvent.start.date}T12:00:00`)}${googleCalendarEventDateRange(selectedGoogleCalendarEvent).end !== selectedGoogleCalendarEvent.start.date ? ` – ${dateLabel(`${googleCalendarEventDateRange(selectedGoogleCalendarEvent).end}T12:00:00`)}` : ""} · celý deň`
            : selectedGoogleCalendarEvent.start.dateTime
              ? new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(selectedGoogleCalendarEvent.start.dateTime)) + (selectedGoogleCalendarEvent.end.dateTime ? ` – ${new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(selectedGoogleCalendarEvent.end.dateTime))}` : "")
              : "Čas udalosti nie je uvedený"}</p>
          {selectedGoogleCalendarEvent.location && <p><MapPin size={15} /> {selectedGoogleCalendarEvent.location}</p>}
          {selectedGoogleCalendarEvent.description && <p className="calendar-google-event-description">{selectedGoogleCalendarEvent.description}</p>}
          <div className="form-actions">
            {selectedGoogleCalendarEvent.htmlLink && <a className="button button-outline button-small" href={selectedGoogleCalendarEvent.htmlLink} target="_blank" rel="noreferrer">Otvoriť v Google Kalendári</a>}
            <button className="button button-quiet" onClick={() => setSelectedGoogleCalendarEvent(null)}>Zavrieť</button>
          </div>
        </section>
      </div>}
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
            }}><option value="">Bez zákazky</option>{workOrders.filter((order) => order.assignee_id === session?.user.id || (order.assignees ?? []).some((assignment) => assignment.user_id === session?.user.id)).map((order) => <option key={order.id} value={order.id}>{order.title}</option>)}</select></label>
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
            if (!nextRoundTrip) { setTripDifferentReturn(false); setTripReturnDestination(""); }
            if (tripMapDistance !== null && (tripDistanceSource === "MAP" || tripDistanceSource === "MAP_EDITED")) {
              setTripDistance((nextRoundTrip ? tripMapDistance * 2 : tripMapDistance).toFixed(2));
              setTripDistanceSource("MAP");
            }
          }} disabled={tripMapBusy} /><span>Spiatočná jazda (návrat na miesto odchodu)</span></label>
          {tripRoundTrip && <label className="checkbox-line trip-roundtrip"><input type="checkbox" checked={tripDifferentReturn} onChange={(event) => {
            setTripDifferentReturn(event.target.checked);
            setTripMapDistance(null);
            setTripDistanceSource("MANUAL");
            setTripDistance("");
          }} disabled={tripMapBusy} /><span>Pri návrate iný cieľ ako miesto odchodu</span></label>}
          {tripRoundTrip && tripDifferentReturn && <label className="field"><span>Cieľ spiatočnej jazdy</span><input value={tripReturnDestination} onChange={(event) => {
            setTripReturnDestination(event.target.value);
            setTripMapDistance(null);
            setTripDistanceSource("MANUAL");
            setTripDistance("");
          }} disabled={tripMapBusy} minLength={2} maxLength={250} placeholder="napr. sídlo firmy" /></label>}
          <section className="entry-photo-picker">
            <div className="entry-photo-heading"><span><strong>Zastávky na trase</strong><small>voliteľné, najviac 10</small></span></div>
            {tripStops.map((stop, index) => <div className="form-grid" key={`stop-${index}`}>
              <label className="field"><span>Zastávka {index + 1}</span><input value={stop} onChange={(event) => {
                const next = [...tripStops];
                next[index] = event.target.value;
                setTripStops(next);
                setTripMapDistance(null);
                setTripDistanceSource("MANUAL");
                setTripDistance("");
              }} disabled={tripMapBusy} minLength={2} maxLength={250} /></label>
              <button type="button" className="button button-outline button-small" onClick={() => setTripStops((current) => current.filter((_, stopIndex) => stopIndex !== index))} disabled={tripMapBusy}><X size={14} /> Odstrániť</button>
            </div>)}
            {tripStops.length < 10 && <button type="button" className="button button-outline button-small" onClick={() => setTripStops((current) => [...current, ""])} disabled={tripMapBusy}><Plus size={14} /> Pridať zastávku</button>}
          </section>
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
              <p>{trip.origin} {trip.stops?.map((stop, index) => <span key={index}><ArrowRight size={14} /> {stop} </span>)}<ArrowRight size={14} /> {trip.destination}{trip.return_destination && <><ArrowRight size={14} /> {trip.return_destination}</>}</p>
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
          <label className="field"><span>Zamestnanec</span><select value={reportEmployeeId} onChange={(event) => setReportEmployeeId(event.target.value)}><option value="ALL">Všetci zamestnanci</option>{roster.filter((member) => member.role === "EMPLOYEE" || member.is_employee).map((member) => <option key={member.id} value={member.user_id}>{member.full_name || member.email}</option>)}</select></label>
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
        </section>}
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

  const renderProfile = () => (
    <section className="content-page">
      <header className="dashboard-title-row"><div><span className="eyebrow">OSOBNÉ NASTAVENIA</span><h1>Môj profil</h1><p>Upravte zobrazované meno a nastavenia účtu.</p></div></header>
      <form className="panel form-panel form-stack profile-form" onSubmit={(event) => void saveProfile(event)}>
        <label className="field"><span>Meno a priezvisko</span><input value={profileFullName} onChange={(event) => setProfileFullName(event.target.value)} minLength={2} maxLength={120} required /></label>
        <label className="field"><span>Prihlasovací e-mail</span><input value={session?.user.email ?? ""} readOnly /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="invite-success" role="status">{notice}</p>}
        <div className="form-actions"><button className="button button-primary" disabled={busy}>{busy ? "Ukladám…" : "Uložiť profil"}</button></div>
      </form>
      <section className="panel form-panel account-actions">
        <div><h2>Prihlasovací účet</h2><p>Aktuálne ste prihlásený ako {session?.user.email ?? "—"}.</p></div>
        <div className="form-actions">
          <button className="button button-outline" onClick={() => void switchAccount()} disabled={busy}>Prepnúť účet</button>
          <button className="button button-danger" onClick={() => void signOut()} disabled={busy}><LogOut size={16} /> Odhlásiť sa</button>
        </div>
      </section>
      {isManager && activeMembership && <section className={`panel plan-card ${activeMembership.company.plan !== "FREE" ? "plan-card-pro" : ""}`}>
        <div className="plan-card-copy">
          <span className="eyebrow">{activeMembership.company.pro_trial_ends_at ? "SKÚŠOBNÁ VERZIA PRO" : activeMembership.company.plan !== "FREE" ? "AKTÍVNA LICENCIA" : "BEZPLATNÝ PLÁN"}</span>
          <h2>Workena {COMPANY_PLAN_LABELS[activeMembership.company.plan]}</h2>
          <p>{activeMembership.company.pro_trial_ends_at
            ? `Pro je zdarma do ${dateLabel(activeMembership.company.pro_trial_ends_at)}. Potom sa firma automaticky vráti na Free; platba sa nestrhne.`
            : activeMembership.company.plan !== "FREE"
              ? `Firemný priestor používa licenciu ${COMPANY_PLAN_LABELS[activeMembership.company.plan]}.`
              : activeMembership.company.pro_trial_started_at
                ? "Skúšobná verzia sa skončila. Firma používa Free; platenú licenciu si môžete objednať nižšie."
                : `Používate ${roster.filter((member) => member.active && (member.role === "EMPLOYEE" || member.role === "ACCOUNTANT" && member.is_employee)).length} z 2 zamestnaneckých miest.`}</p>
        </div>
        <div className="plan-card-price"><strong>{activeMembership.company.pro_trial_ends_at ? "Zdarma" : COMPANY_PLAN_LABELS[activeMembership.company.plan]}</strong><span>{activeMembership.company.pro_trial_ends_at ? "30-dňová skúška" : activeMembership.company.plan !== "FREE" ? "stav účtu" : "aktuálny účet"}</span></div>
        {isCompanyOwner && activeMembership.active && activeMembership.company.plan === "FREE" && !activeMembership.company.pro_trial_started_at && <div className="form-actions"><button className="button button-primary" disabled={busy} onClick={() => void startProTrial()}>{busy ? "Aktivujem…" : "Vyskúšať Pro na 30 dní"}</button></div>}
        <p className="plan-card-note">{activeMembership.company.pro_trial_ends_at
          ? "Bez platobnej karty a bez automatického účtovania. Po skúške si môžete platený plán objednať samostatne."
          : activeMembership.company.pro_trial_started_at
            ? "Skúšobnú verziu možno využiť iba raz na jednu firmu."
            : "Licenciu prideľuje správca Workena po potvrdení platby. Skúšobnú verziu Pro možno využiť raz na firmu."}</p>
      </section>}
      {isManager && <section className="pricing-proposal">
        <header className="pricing-proposal-heading">
          <div><span className="eyebrow">NA TESTOVANIE SO ZÁKAZNÍKMI</span><h2>Návrh balíkov a cien</h2></div>
          <p>Navrhované ceny na overenie záujmu. Konečné sumy vrátane DPH 23 %: Basic 19 €, Pro 39 € a Team 69 € mesačne. Nejde o potvrdený priemer slovenského trhu ani o aktuálne dostupné predplatné.</p>
        </header>
        {gopayTestMessage && <p className="invite-success" role="status">{gopayTestMessage}</p>}
        <div className="pricing-proposal-grid">
          <article className="panel pricing-proposal-card">
            <div><span className="pricing-proposal-name">Basic</span><strong>19 €<small> / mes.</small></strong></div>
            <p>Zamestnanci, úlohy a základná evidencia.</p>
            <p className="muted"><small>{PLAN_FEATURE_NOTES.BASIC}</small></p>
            <button className="button button-outline button-small" onClick={() => setPreviewPlan("BASIC")} disabled={busy}>Zobraziť platobné údaje</button>
          </article>
          <article className="panel pricing-proposal-card pricing-proposal-featured">
            <div><span className="pricing-proposal-name">Pro</span><strong>39 €<small> / mes.</small></strong></div>
            <p>Dochádzka, výkazy, exporty a reporty.</p>
            <p className="muted"><small>{PLAN_FEATURE_NOTES.PRO}</small></p>
            <button className="button button-outline button-small" onClick={() => setPreviewPlan("PRO")} disabled={busy}>Zobraziť platobné údaje</button>
          </article>
          <article className="panel pricing-proposal-card">
            <div><span className="pricing-proposal-name">Team</span><strong>69 €<small> / mes.</small></strong></div>
            <p>Viac tímov, zákazky, pokročilé reporty a oprávnenia.</p>
            <p className="muted"><small>{PLAN_FEATURE_NOTES.TEAM}</small></p>
            <button className="button button-outline button-small" onClick={() => setPreviewPlan("TEAM")} disabled={busy}>Zobraziť platobné údaje</button>
          </article>
        </div>
        {previewPlan && <section className="panel payment-instructions">
          <div className="payment-instructions-copy">
            <span className="eyebrow">BANKOVÝ PREVOD · {PAYMENT_PLAN_DETAILS[previewPlan].name.toUpperCase()}</span>
            <h3>Platobné údaje pre plán {PAYMENT_PLAN_DETAILS[previewPlan].name}</h3>
            <p>Toto je iba náhľad platobných údajov k návrhovej cene vrátane DPH 23 %, nie záväzná objednávka. Žiadosť o licenciu sa odošle správcovi Workena až po kliknutí na tlačidlo nižšie.</p>
            <dl>
              <div><dt>Príjemca</dt><dd>{PAYMENT_BENEFICIARY}</dd></div>
              <div><dt>IBAN</dt><dd>{PAYMENT_IBAN}</dd></div>
              <div><dt>Suma za 1 mesiac</dt><dd>{PAYMENT_PLAN_DETAILS[previewPlan].amount.toFixed(2).replace(".", ",")} €</dd></div>
              <div><dt>Správa</dt><dd>Workena {PAYMENT_PLAN_DETAILS[previewPlan].name}</dd></div>
            </dl>
          </div>
          <div className="form-actions">
            <button className="button button-quiet" onClick={() => setPreviewPlan("")}>Zavrieť náhľad</button>
            <button className="button button-primary" disabled={busy} onClick={() => void createPaymentRequest(previewPlan)}>Požiadať o licenciu</button>
            {isCompanyOwner && GOPAY_TEST_MODE && <button className="button button-outline" disabled={busy} onClick={() => void startGoPayTestPayment(previewPlan)}>Testovať mesačné GoPay opakovanie</button>}
          </div>
          {isCompanyOwner && <p className="payment-pending-note">GoPay sandbox testuje opakovanú mesačnú platbu. Prvá testovacia platba prebehne hneď; v sandboxe sa nič nestrhne z reálnej karty, licencia sa neaktivuje a nevznikne produkčné predplatné.</p>}
        </section>}
        {selectedPaymentRequest && <section className="panel payment-instructions">
          <div className="payment-instructions-copy">
            <span className="eyebrow">BANKOVÝ PREVOD · {PAYMENT_PLAN_DETAILS[selectedPaymentRequest.plan].name.toUpperCase()}</span>
            <h3>Dokončite platbu prevodom</h3>
            <p>Údaje z QR kódu si pred odoslaním skontrolujte v bankovej aplikácii. Zobrazená cena je konečná suma vrátane DPH 23 %.</p>
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
      {activeMembership?.role === "OWNER" && <section className="panel form-panel form-stack">
        <div className="panel-heading"><div><h2><Building2 size={17} /> Fakturačné údaje firmy</h2><p>Údaje sa použijú na vystavenie faktúry za licenciu.</p></div></div>
        <form className="form-stack" onSubmit={(event) => void saveCompanyBillingDetails(event)}>
          <div className="form-grid">
            <label className="field"><span>Fakturačný názov firmy</span><input value={billingName} onChange={(event) => setBillingName(event.target.value)} maxLength={160} placeholder="Obchodné meno s.r.o." /></label>
            <label className="field"><span>IČO</span><input value={billingIco} onChange={(event) => setBillingIco(event.target.value)} maxLength={20} /></label>
            <label className="field"><span>DIČ</span><input value={billingDic} onChange={(event) => setBillingDic(event.target.value)} maxLength={20} /></label>
            <label className="field"><span>IČ DPH <small>voliteľné</small></span><input value={billingIcDph} onChange={(event) => setBillingIcDph(event.target.value)} maxLength={20} /></label>
          </div>
          <label className="field"><span>Fakturačná adresa</span><textarea rows={2} value={billingAddress} onChange={(event) => setBillingAddress(event.target.value)} maxLength={300} placeholder="Ulica, mesto, PSČ" /></label>
          <div className="form-actions"><button className="button button-primary" disabled={busy}>{busy ? "Ukladám…" : "Uložiť fakturačné údaje"}</button></div>
        </form>
      </section>}
      {activeMembership?.role === "OWNER" && <section className="panel form-panel form-stack">
        <div className="panel-heading"><div><h2><Plus size={17} /> Pridať ďalšiu firmu</h2><p>Maximálny počet firiem podľa balíka: Free a Basic {PLAN_COMPANY_LIMIT.FREE}, Pro {PLAN_COMPANY_LIMIT.PRO}, Team {PLAN_COMPANY_LIMIT.TEAM}. Aktuálny balík: {COMPANY_PLAN_LABELS[activeMembership.company.plan]} (max. {PLAN_EMPLOYEE_LIMIT[activeMembership.company.plan] ?? "neobmedzene"} zamestnancov). Na ďalšiu firmu nad rámec balíka Free bude potrebná zodpovedajúca licencia.</p></div></div>
        <form className="form-stack" onSubmit={(event) => void createAdditionalCompany(event)}>
          <label className="field"><span>Názov novej firmy</span><input name="name" value={newCompanyName} onChange={(event) => setNewCompanyName(event.target.value)} minLength={2} maxLength={120} placeholder="napr. Workena s.r.o. — pobočka" required /></label>
          <div className="form-grid">
            <label className="field"><span>Fakturačný názov firmy</span><input name="billing_name" defaultValue={billingName} maxLength={200} required /></label>
            <label className="field"><span>IČO</span><input name="billing_ico" defaultValue={billingIco} maxLength={20} required /></label>
            <label className="field"><span>DIČ</span><input name="billing_dic" defaultValue={billingDic} maxLength={20} required /></label>
            <label className="field"><span>IČ DPH <small>voliteľné</small></span><input name="billing_ic_dph" defaultValue={billingIcDph} maxLength={20} /></label>
          </div>
          <label className="field"><span>Fakturačná adresa</span><textarea name="billing_address" rows={2} defaultValue={billingAddress} maxLength={400} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="invite-success" role="status">{notice}</p>}
          <div className="form-actions"><button className="button button-primary" disabled={busy}><Plus size={15} />{busy ? "Zakladám…" : "Založiť firmu"}</button></div>
        </form>
      </section>}
    </section>
  );

  const renderAdmin = () => (
    <section className="content-page">
      <header className="dashboard-title-row"><div><span className="eyebrow">SPRÁVA PLATFORMY</span><h1>Administrácia</h1><p>Prehľad všetkých zaevidovaných firiem a správa licencií.</p></div><span className="count-pill">{adminCompanies.length} firiem</span></header>
      {adminNotice && <p className="invite-success" role="status">{adminNotice}</p>}
      {adminError && <p className="form-error" role="alert">{adminError}</p>}
      <section className="panel form-panel form-stack">
        <div className="panel-heading"><div><h2><CalendarDays size={17} /> Odstávka kvôli aktualizácii</h2><p>Pošle e-mail všetkým firmám s vyplneným e-mailom vlastníka.</p></div></div>
        {adminMaintenanceOpen
          ? <form className="form-stack" onSubmit={(event) => void adminBroadcastMaintenance(event)}>
            <div className="form-grid">
              <label className="field"><span>Od</span><input type="datetime-local" name="starts_at" required /></label>
              <label className="field"><span>Do</span><input type="datetime-local" name="ends_at" required /></label>
            </div>
            <label className="field"><span>Dôvod <small>voliteľné</small></span><textarea name="reason" rows={2} maxLength={500} placeholder="napr. Aktualizácia a opravy aplikácie" /></label>
            <div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setAdminMaintenanceOpen(false)}>Zrušiť</button><button className="button button-primary" disabled={adminBusy}>{adminBusy ? "Odosielam…" : "Odoslať všetkým firmám"}</button></div>
          </form>
          : <button className="button button-outline" onClick={() => setAdminMaintenanceOpen(true)}>Naplánovať odstávku</button>}
      </section>
      {adminCompanies.length === 0
        ? <div className="panel empty-state"><span className="soft-icon"><Building2 size={19} /></span><strong>Zatiaľ tu nie sú žiadne firmy</strong><p>Keď si niekto založí firemný priestor, zobrazí sa tu.</p></div>
        : <div className="work-order-list">{adminCompanies.map((company) => <article className="panel work-order-card" key={company.company_id}>
          <div className="work-order-heading">
            <div><span className="eyebrow">FIRMA</span><h2>{company.name}</h2></div>
            <span className={`status-pill work-order-status work-order-${company.plan.toLowerCase()}`}>{COMPANY_PLAN_LABELS[company.plan]}</span>
          </div>
          <div className="work-order-meta">
            <span><Users size={14} />{company.owner_name || company.owner_email || "Neznámy vlastník"}</span>
            <span><ClipboardList size={14} />{company.member_count} aktívnych členov</span>
            <span><CalendarDays size={14} />Založená {dateLabel(company.created_at)}</span>
            {company.selected_plan && <span>Požadovaný balík: {PAYMENT_PLAN_DETAILS[company.selected_plan].name}</span>}
          </div>
          {company.pending_payment_id && <div className="work-order-accept-panel">
            <span>Čaká platba {company.pending_payment_plan ? PAYMENT_PLAN_DETAILS[company.pending_payment_plan].name : ""} · {Number(company.pending_payment_amount).toFixed(2).replace(".", ",")} € · VS {company.pending_payment_variable_symbol}</span>
            <div className="attendance-clock-actions">
              <button className="button button-primary button-small" disabled={adminBusy} onClick={() => void adminReviewPaymentRequest(company, true)}>Potvrdiť platbu</button>
              <button className="button button-outline button-small" disabled={adminBusy} onClick={() => void adminReviewPaymentRequest(company, false)}>Zamietnuť</button>
              <button className="button button-outline button-small" disabled={adminBusy || !company.owner_email} onClick={() => void adminSendPaymentReminder(company)}>Poslať upomienku</button>
            </div>
          </div>}
          <div className="form-actions">
            <label className="field admin-plan-field"><span>Licencia</span><select value={company.plan} disabled={adminBusy} onChange={(event) => void adminSetCompanyPlan(company.company_id, event.target.value as CompanyPlan)}>
              <option value="FREE">Free</option>
              <option value="BASIC">Basic</option>
              <option value="PRO">Pro</option>
              <option value="TEAM">Team</option>
            </select></label>
            <button className="button button-outline button-small" disabled={!company.owner_email} onClick={() => setAdminEmailTargetId((current) => current === company.company_id ? null : company.company_id)}>Poslať e-mail firme</button>
            <button className="button button-danger button-small" disabled={adminBusy} onClick={() => void adminDeleteCompany(company.company_id, company.name)}>Vymazať firmu</button>
          </div>
          {adminEmailTargetId === company.company_id && <form className="form-stack" onSubmit={(event) => void adminSendCustomEmail(company, event)}>
            <label className="field"><span>Predmet</span><input name="subject" minLength={2} maxLength={200} required /></label>
            <label className="field"><span>Text správy</span><textarea name="message" rows={4} minLength={2} maxLength={4000} required /></label>
            <div className="form-actions"><button type="button" className="button button-quiet button-small" onClick={() => setAdminEmailTargetId(null)}>Zrušiť</button><button className="button button-primary button-small" disabled={adminBusy}>{adminBusy ? "Odosielam…" : "Odoslať e-mail"}</button></div>
          </form>}
        </article>)}</div>}
    </section>
  );

  const renderCompanyJoinRequests = () => isManager && joinRequests.length > 0 && (
    <section className="panel invite-panel">
      <div className="panel-heading"><div><h2><Users size={17} /> Žiadosti o vstup</h2><p>Nové žiadosti o pripojenie do firmy.</p></div><span className="count-pill">{joinRequests.length} čaká</span></div>
      <div className="member-list">{joinRequests.map((request) => <div className="member-row" key={request.id}>
        <span className="avatar">{initials(request.full_name || request.email)}</span>
        <span className="member-name"><strong>{request.full_name || request.email}</strong><small>{request.email}</small></span>
        <button className="button button-primary button-small" disabled={busy} onClick={() => void reviewCompanyJoinRequest(request, true)}>Prijať</button>
        <button className="button button-danger button-small" disabled={busy} onClick={() => void reviewCompanyJoinRequest(request, false)}>Odstrániť</button>
      </div>)}</div>
    </section>
  );

  const renderTeam = () => (
    <section className="content-page">
      <header className="dashboard-title-row"><div><span className="eyebrow">FIREMNÝ PRIESTOR</span><h1>Tím</h1><p>Správa členov a ich prístupu k údajom firmy.</p></div></header>
      <div className="team-layout">
        {renderCompanyJoinRequests()}
        <section className="panel team-panel">
          <div className="panel-heading"><div><h2><Users size={17} /> Členovia tímu</h2><p>Prístup majú iba aktívni členovia firmy.</p></div><span className="count-pill">{roster.filter((member) => member.active).length} členov</span></div>
          <div className="member-list">{roster.filter((member) => member.active).map((member) => <div className="member-row" key={member.id}>
            <span className="avatar">{initials(member.full_name || member.email)}</span>
            <span className="member-name"><strong>{member.full_name || member.email}</strong><small>{member.email}</small></span>
            <span className={`status-pill role-${member.role.toLowerCase()}`}>{member.role === "ACCOUNTANT" ? `Účtovník ${member.is_employee ? "zamestnaný" : "externý"}` : member.role === "EMPLOYEE" && member.is_external ? "Zamestnanec externý" : roleName(member.role)}</span>
            {member.role !== "OWNER" && (activeMembership?.role === "OWNER" || member.role === "EMPLOYEE") && <button className="logout-button" aria-label={`Odstrániť ${member.email}`} onClick={() => void removeMember(member)} disabled={busy}><X size={16} /></button>}
          </div>)}</div>
        </section>
        {isManager && <section className="panel invite-panel">
          <div className="panel-heading"><div><h2><Plus size={17} /> Pridať člena</h2><p>Existujúci účet pridáme hneď, novému používateľovi pošleme pozvánku e-mailom.</p></div></div>
          <form className="invite-form" onSubmit={(event) => void addMember(event)}>
            <label className="field"><span>Meno a priezvisko</span><input type="text" name="full_name" autoComplete="name" minLength={1} maxLength={120} placeholder="Jana Nováková" required /></label>
            <label className="field"><span>E-mail</span><input type="email" name="email" autoComplete="email" maxLength={320} placeholder="meno@firma.sk" required /></label>
            <label className="field"><span>Typ člena</span><select name="member_type" value={newMemberType} onChange={(event) => setNewMemberType(event.target.value)}>
              <option value="EMPLOYEE">Zamestnanec</option>
              <option value="EXTERNAL_EMPLOYEE">Zamestnanec externý</option>
              <option value="EMPLOYED_ACCOUNTANT">Účtovník zamestnaný</option>
              <option value="EXTERNAL_ACCOUNTANT">Účtovník externý</option>
              {activeMembership?.role === "OWNER" && <option value="MANAGER">Vedúci</option>}
            </select></label>
            {["EMPLOYEE", "EMPLOYED_ACCOUNTANT"].includes(newMemberType) && <label className="permission-toggle"><input type="checkbox" name="is_minor" /> Mladistvý (prestávka po 4,5 h)</label>}
            <button className="button button-primary" disabled={busy}>Pridať do tímu</button>
          </form>
        </section>}
      </div>
      {isManager && <section className="panel form-panel form-stack">
        <div className="panel-heading"><div><h2><ShieldCheck size={17} /> Práva členov tímu</h2><p>Účtovník môže byť zároveň zamestnancom; externý zamestnanec sa eviduje bez automatického odpočítania prestávky.</p></div></div>
        <div className="member-list">{roster.filter((member) => member.active && (member.role === "EMPLOYEE" || member.role === "ACCOUNTANT" || member.role === "MANAGER" || member.role === "OWNER" && member.user_id === session?.user.id)).map((member) => <div className="member-row permissions-member-row" key={member.id}>
          <span className="avatar">{initials(member.full_name || member.email)}</span>
          <span className="member-name"><strong>{member.full_name || member.email}</strong><small>{member.email}</small></span>
          {(member.role === "EMPLOYEE" || member.role === "ACCOUNTANT") && <select value={member.role} disabled={busy} onChange={(event) => void updateMemberRole(member, event.target.value as Role)}>
              <option value="EMPLOYEE">Zamestnanec</option>
              <option value="ACCOUNTANT">Účtovník</option>
            </select>}
          <label className="permission-toggle"><input type="checkbox" checked={member.role === "EMPLOYEE" || Boolean(member.is_employee)} disabled={busy || member.role === "EMPLOYEE"} onChange={(event) => void updateMemberPermissions(member, "is_employee", event.target.checked)} /> Zamestnanec</label>
          {member.role === "EMPLOYEE" && <label className="permission-toggle"><input type="checkbox" checked={Boolean(member.is_external)} disabled={busy} onChange={(event) => void updateMemberPermissions(member, "is_external", event.target.checked)} /> Externý (bez odpočítania prestávky)</label>}
          {(member.role === "EMPLOYEE" || member.is_employee) && <label className="permission-toggle"><input type="checkbox" checked={Boolean(member.is_minor)} disabled={busy || Boolean(member.is_external)} onChange={(event) => void updateMemberPermissions(member, "is_minor", event.target.checked)} /> Mladistvý (prestávka po 4,5 h)</label>}
          <label className="permission-toggle"><input type="checkbox" checked={Boolean(member.is_salesperson)} disabled={busy} onChange={(event) => void updateMemberPermissions(member, "is_salesperson", event.target.checked)} /> Obchodník</label>
        </div>)}</div>
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
          {canAccessCustomers && <button className={`nav-link ${page === "customers" ? "active" : ""}`} onClick={() => { setPage("customers"); setError(""); setNotice(""); }}><Users size={18} /> Zákazníci</button>}
          <button className={`nav-link ${page === "trips" ? "active" : ""}`} onClick={() => { setPage("trips"); setError(""); setTripNotice(""); }}><MapPin size={18} /> Výkaz jázd</button>
          {canManageAttendance && <button className={`nav-link ${page === "reports" ? "active" : ""}`} onClick={() => { setPage("reports"); setError(""); }}><Download size={18} /> Exporty a reporty</button>}
          {isManager && <button className={`nav-link ${page === "team" ? "active" : ""}`} onClick={() => setPage("team")}><Users size={18} /> Tím</button>}
          {isManager && <button className={`nav-link ${page === "history" ? "active" : ""}`} onClick={() => setPage("history")}><History size={18} /> História</button>}
          <button className={`nav-link ${page === "profile" ? "active" : ""}`} onClick={() => setPage("profile")}><Pencil size={18} /> Môj profil</button>
          {isPlatformAdmin && <button className={`nav-link ${page === "admin" ? "active" : ""}`} onClick={() => { setPage("admin"); setAdminError(""); setAdminNotice(""); }}><Building2 size={18} /> Administrácia</button>}
          <button className="nav-link" onClick={() => { window.location.hash = "obchodne-podmienky"; }}><ShieldCheck size={18} /> Obchodné podmienky</button>
          <button className="nav-link" onClick={() => { window.location.hash = "ochrana-osobnych-udajov"; }}><ShieldCheck size={18} /> Ochrana osobných údajov</button>
        </nav>
        <div className="sidebar-bottom">
          <button className="profile-row profile-open-button" onClick={() => setPage("profile")}><span className="avatar">{initials(profileName)}</span><span className="profile-name"><strong>{profileName}</strong><small>{activeMembership ? roleName(activeMembership.role) : "Bez firmy"}</small></span><Pencil size={14} /></button>
          <button className="logout-button" aria-label="Odhlásiť sa" onClick={() => void signOut()}><LogOut size={17} /></button>
        </div>
      </aside>
      <div className="main-area">
        <header className="mobile-top"><Brand />{memberships.length > 1
          ? <select className="mobile-company-select" aria-label="Vybrať firmu" value={activeCompanyId} onChange={(event) => { setCompanyId(event.target.value); setSelectedId(null); }}>
            {memberships.map((membership) => <option key={membership.company_id} value={membership.company_id}>{membership.company.name}</option>)}
          </select>
          : <span className="mobile-company">{activeMembership?.company.name}</span>}
          <a className="mobile-terms" href="#obchodne-podmienky">Podmienky</a><button className="logout-button" aria-label="Odhlásiť sa" onClick={() => void signOut()}><LogOut size={17} /></button></header>
        <main className="page-content">
          {!activeMembership && !isPlatformAdmin ? (
            <section className="center-card company-create">
              <span className="eyebrow">VITAJTE VO WORKENE</span><h1>Začnite používať Workenu</h1>
              <p className="muted">Založte vlastnú firmu alebo požiadajte o prístup do existujúcej.</p>
              <div className="company-entry-tabs" role="tablist" aria-label="Možnosti vstupu do firmy">
                <button type="button" className={`button ${companyJoinMode === "create" ? "button-primary" : "button-outline"}`} role="tab" aria-selected={companyJoinMode === "create"} onClick={() => { setCompanyJoinMode("create"); setError(""); setNotice(""); }}>Založiť firmu</button>
                <button type="button" className={`button ${companyJoinMode === "join" ? "button-primary" : "button-outline"}`} role="tab" aria-selected={companyJoinMode === "join"} onClick={() => { setCompanyJoinMode("join"); setError(""); setNotice(""); }}>Pridať sa k firme</button>
              </div>
              {companyJoinMode === "create" ? <form className="form-stack" onSubmit={(event) => void createCompany(event)}>
                <label className="field"><span>Názov firmy</span><input name="name" minLength={2} maxLength={120} placeholder="napr. Workena s.r.o." required /></label>
                <div className="form-grid">
                  <label className="field"><span>Fakturačný názov firmy</span><input name="billing_name" maxLength={200} required /></label>
                  <label className="field"><span>IČO</span><input name="billing_ico" maxLength={20} required /></label>
                  <label className="field"><span>DIČ</span><input name="billing_dic" maxLength={20} required /></label>
                  <label className="field"><span>IČ DPH <small>voliteľné</small></span><input name="billing_ic_dph" maxLength={20} /></label>
                </div>
                <label className="field"><span>Fakturačná adresa</span><textarea name="billing_address" rows={2} maxLength={400} required /></label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="button button-primary" disabled={busy}>{busy ? "Vytváram…" : "Vytvoriť firmu"}</button>
              </form> : <div className="form-stack">
                <form className="company-search-form" onSubmit={(event) => void searchCompaniesForJoin(event)}>
                  <label className="field"><span>Názov firmy</span><input value={companySearchName} onChange={(event) => setCompanySearchName(event.target.value)} minLength={2} maxLength={120} placeholder="Zadajte názov firmy" required /></label>
                  <button className="button button-outline" disabled={busy}><Search size={16} /> Vyhľadať firmu</button>
                </form>
                {companySearchResults.length > 0 && <div className="company-search-results">{companySearchResults.map((company) => <div className="company-search-result" key={company.company_id}>
                  <strong>{company.company_name}</strong><button className="button button-primary button-small" disabled={busy} onClick={() => void requestCompanyJoin(company)}>Požiadať o prístup</button>
                </div>)}</div>}
                {notice && <p className="invite-success" role="status">{notice}</p>}
                {error && <p className="form-error" role="alert">{error}</p>}
              </div>}
            </section>
          ) : page === "admin" && isPlatformAdmin ? renderAdmin() : !activeMembership ? (
            <section className="center-card company-create">
              <span className="eyebrow">VITAJTE VO WORKENE</span><h1>Založte firemný priestor</h1>
              <p className="muted">Váš účet zatiaľ nie je členom firmy. Založte firmu a stanete sa jej vlastníkom, alebo prejdite do Administrácie.</p>
              <form className="form-stack" onSubmit={(event) => void createCompany(event)}>
                <label className="field"><span>Názov firmy</span><input name="name" minLength={2} maxLength={120} placeholder="napr. Workena s.r.o." required /></label>
                <div className="form-grid">
                  <label className="field"><span>Fakturačný názov firmy</span><input name="billing_name" maxLength={200} required /></label>
                  <label className="field"><span>IČO</span><input name="billing_ico" maxLength={20} required /></label>
                  <label className="field"><span>DIČ</span><input name="billing_dic" maxLength={20} required /></label>
                  <label className="field"><span>IČ DPH <small>voliteľné</small></span><input name="billing_ic_dph" maxLength={20} /></label>
                </div>
                <label className="field"><span>Fakturačná adresa</span><textarea name="billing_address" rows={2} maxLength={400} required /></label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="button button-primary" disabled={busy}>{busy ? "Vytváram…" : "Vytvoriť firmu"}</button>
              </form>
            </section>
          ) : page === "attendance" ? renderAttendance() : page === "workOrders" ? renderWorkOrders() : page === "customers" && canAccessCustomers ? renderCustomers() : page === "trips" ? renderTrips() : page === "reports" && canManageAttendance ? renderReports() : page === "team" ? renderTeam() : page === "history" && isManager ? renderHistory() : page === "profile" ? renderProfile() : (
            <div className="content-page">
              <header className="dashboard-title-row"><div><span className="eyebrow">PREHĽAD PRÁCE</span><h1>Dobrý deň, {profileName.split(" ")[0]}</h1><p>Tu je prehľad práce vo firme {activeMembership.company.name}.</p></div>{isEmployeeUser && <button className="button button-primary" onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setShowEntryForm(true); }}><Plus size={16} /> Nový záznam</button>}</header>
              {renderCompanyJoinRequests()}
              {isEmployeeUser && <section className={`panel attendance-clock attendance-clock-compact ${activeShift ? "attendance-clock-running" : ""}`}>
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
                  ? <button className="button button-primary" disabled={busy} onClick={() => void attendanceAction("start_attendance")}><Play size={16} /> Začať pracovať</button>
                  : activeBreak
                    ? <button className="button button-outline" disabled={busy} onClick={() => void attendanceAction("end_attendance_break")}><Coffee size={16} /> Ukončiť prestávku</button>
                    : <div className="attendance-clock-actions">
                      <button className="button button-outline" disabled={busy} onClick={() => void attendanceAction("start_attendance_break")}><Coffee size={16} /> Začať prestávku</button>
                      <button className="button button-danger" disabled={busy} onClick={requestEndAttendance}><Square size={15} /> Ukončiť prácu</button>
                    </div>}
              </section>}
              {isEmployeeUser && (() => {
                const myOrders = workOrders.filter((order) =>
                  (order.assignees?.length
                    ? order.assignees.some((assignment) => assignment.user_id === session?.user.id && !assignment.declined_at)
                    : order.assignee_id === session?.user.id));
                const activeOrders = myOrders
                  .filter((order) => order.status !== "DONE" && !(activeMembership?.is_salesperson && order.status === "MEASURED"))
                  .sort((a, b) => a.due_date.localeCompare(b.due_date)
                    || (a.starts_at ?? "99:99").localeCompare(b.starts_at ?? "99:99"));
                const todayKey = localDateKey(new Date().toISOString());
                return <section className="panel assignment-notice-panel">
                  <div className="panel-heading"><div><h2><ClipboardList size={17} /> Moje pridelené zákazky</h2><p>Zákazky priradené vám, ktoré ešte nie sú dokončené.</p></div><span className="count-pill">{activeOrders.length} aktívnych</span></div>
                  {activeOrders.length
                    ? <ul>{activeOrders.map((order) => {
                      const assignment = (order.assignees ?? []).find((item) => item.user_id === session?.user.id);
                      const overdue = order.status !== "DONE" && order.due_date < todayKey;
                      const expanded = expandedDashboardOrderId === order.id;
                      return <li key={order.id}>
                        <strong>{order.title}</strong>
                        <span className={overdue ? "work-order-overdue" : ""}>Termín {dateLabel(`${order.due_date}T12:00:00`)}{order.time_to_arrange ? " · čas treba dohodnúť" : order.starts_at ? ` · ${order.starts_at.slice(0, 5)} – ${order.ends_at?.slice(0, 5) ?? "—"}` : ""}{overdue ? " · po termíne" : ""}</span>
                        <span className={`status-pill work-order-status work-order-${order.status.toLowerCase()}`}>{workOrderStatusName(order.status)}</span>
                        {assignment && !assignment.accepted_at && !assignment.declined_at && <span className="status-pill status-pending">Čaká na potvrdenie</span>}
                        <button className="button button-outline button-small" aria-expanded={expanded} onClick={() => setExpandedDashboardOrderId(expanded ? null : order.id)}>{expanded ? "Skryť podrobnosti" : "Zobraziť podrobnosti"}</button>
                        {expanded && <div className="dashboard-order-details">
                          <span><MapPin size={14} /> {order.address}</span>
                          <p>{order.description}</p>
                          <div className="work-order-actions">
                            <a className="button button-outline button-small" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}`} target="_blank" rel="noreferrer"><Navigation size={14} /> Navigovať</a>
                            {order.contact_phone && <a className="button button-outline button-small" href={`tel:${order.contact_phone}`}><Phone size={14} /> Zavolať</a>}
                            <button className="button button-outline button-small" onClick={() => setPage("workOrders")}>Otvoriť zákazku</button>
                          </div>
                        </div>}
                      </li>;
                    })}</ul>
                    : <p className="assignment-notice-empty">Momentálne nemáte žiadne pridelené zákazky.</p>}
                </section>;
              })()}
              <section className="stats-grid">
                <div className="stat-card"><span className="stat-label">Odpracované tento mesiac</span><span className="stat-icon stat-purple"><Clock3 size={17} /></span><strong>{hoursLabel(monthHours)} <small>hod.</small></strong><span className="stat-foot">{isManager ? "Všetci zamestnanci" : "Vaše odpracované hodiny"}</span></div>
                <div className="stat-card"><span className="stat-label">{isManager ? "Čaká na kontrolu" : "Moje záznamy na kontrolu"}</span><span className="stat-icon stat-amber"><ClipboardList size={17} /></span><strong>{visibleEntries.filter((entry) => entry.status === "PENDING").length}</strong><span className="stat-foot">{isManager ? "Nevybavené záznamy firmy" : "Vaše nevybavené záznamy"}</span></div>
                <div className="stat-card"><span className="stat-label">{isManager ? "Členovia tímu" : "Moje záznamy tento mesiac"}</span><span className={`stat-icon ${isManager ? "stat-green" : "stat-purple"}`}>{isManager ? <Users size={17} /> : <ClipboardList size={17} />}</span><strong>{isManager ? roster.filter((member) => member.active).length : monthlyEntries.length}</strong><span className="stat-foot">{isManager ? "Aktívni členovia firmy" : "Zapísané pracovné dni"}</span></div>
              </section>
              {isManager && (() => {
                const waiting = workOrders.flatMap((order) => (order.status === "DONE" ? [] : (order.assignees ?? [])
                  .filter((assignment) => !assignment.accepted_at && !assignment.declined_at)
                  .map((assignment) => ({
                    order,
                    employee: roster.find((member) => member.user_id === assignment.user_id),
                  }))));
                return <section className="panel assignment-notice-panel">
                  <div className="panel-heading"><div><h2><Users size={17} /> Potvrdenie priradených zákaziek</h2><p>Prehľad zamestnancov, ktorí ešte nepotvrdili pridelenú prácu.</p></div><span className="count-pill">{waiting.length} čaká</span></div>
                  {waiting.length
                    ? <ul>{waiting.map(({ order, employee }) => <li key={`${order.id}-${employee?.user_id ?? order.assignee_id}`}><strong>{order.title}</strong><span>{employee?.full_name || employee?.email || "Zamestnanec"} · termín {dateLabel(`${order.due_date}T12:00:00`)}</span><button className="button button-outline button-small" onClick={() => setPage("workOrders")}>Zobraziť</button></li>)}</ul>
                    : <p className="assignment-notice-empty">Všetky priradenia sú potvrdené.</p>}
                </section>;
              })()}
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
                {visibleEntries.length === 0 ? <div className="panel empty-state"><span className="soft-icon"><ClipboardList size={19} /></span><strong>Zatiaľ tu nie sú žiadne záznamy</strong><p>Pridajte prvý pracovný záznam pre túto firmu.</p>{isEmployeeUser && <button className="button button-primary button-small" onClick={() => { setEditingEntry(null); setPendingPhotos([]); setError(""); setShowEntryForm(true); }}><Plus size={15} /> Nový záznam</button>}</div> : (
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
          {canAccessCustomers && <button className={`mobile-nav-link ${page === "customers" ? "active" : ""}`} aria-current={page === "customers" ? "page" : undefined} onClick={() => { setPage("customers"); setError(""); setNotice(""); }}>
            <Users size={19} /><span>Zákazníci</span>
          </button>}
          <button className={`mobile-nav-link ${page === "trips" ? "active" : ""}`} aria-current={page === "trips" ? "page" : undefined} onClick={() => { setPage("trips"); setError(""); setTripNotice(""); }}>
            <MapPin size={19} /><span>Jazdy</span>
          </button>
          {isManager && <button className={`mobile-nav-link ${page === "team" ? "active" : ""}`} aria-current={page === "team" ? "page" : undefined} onClick={() => setPage("team")}>
            <Users size={19} /><span>Tím</span>
          </button>}
          {isManager && <button className={`mobile-nav-link ${page === "history" ? "active" : ""}`} aria-current={page === "history" ? "page" : undefined} onClick={() => setPage("history")}>
            <History size={19} /><span>História</span>
          </button>}
          {canManageAttendance && <button className={`mobile-nav-link ${page === "reports" ? "active" : ""}`} aria-current={page === "reports" ? "page" : undefined} onClick={() => setPage("reports")}>
            <Download size={19} /><span>Reporty</span>
          </button>}
          <button className={`mobile-nav-link ${page === "profile" ? "active" : ""}`} aria-current={page === "profile" ? "page" : undefined} onClick={() => setPage("profile")}>
            <Pencil size={19} /><span>Profil</span>
          </button>
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
      {canAccessCustomers && <section className="print-report customers-print-report">
        <header className="print-report-header"><span className="brand"><span className="brand-mark">w</span> workena</span><span>Databáza zákazníkov</span></header>
        <h1>Zákazníci{isCompanyOwner && customerOwnerId !== "ALL" ? ` — ${roster.find((member) => member.user_id === customerOwnerId)?.full_name || ""}` : ""}</h1>
        <p className="print-report-company">{activeMembership?.company.name} · Vygenerované {dateLabel(new Date().toISOString())}</p>
        <table><thead><tr><th>Dátum</th><th>Meno</th><th>Lokalita</th><th>Dopyt</th><th>Produkt</th><th>CP poslaná</th><th>Kontakt</th><th>Približná cena</th><th>Stav</th></tr></thead>
          <tbody>{visibleCustomers.map((customer) => <tr key={customer.id}>
            <td>{customer.customer_date}</td><td>{customer.full_name}</td><td>{customer.location}</td><td>{customer.lead_source}</td><td>{customer.product}</td><td>{customer.quote_sent_date ?? "—"}</td><td>{customer.contact_details}</td><td>{customer.estimated_price === null ? "—" : `${hoursLabel(Number(customer.estimated_price))} €`}</td><td>{customerStatusName(customer.status)}</td>
          </tr>)}</tbody>
        </table>
        <footer className="print-report-footer">Workena · {activeMembership?.company.name}</footer>
      </section>}
      {renderEntryFormModal()}
      {showLunchBreakPrompt && <div className="modal-backdrop" role="presentation">
        <section className="panel detail-modal lunch-break-prompt" role="dialog" aria-modal="true" aria-labelledby="lunch-break-title">
          <div className="modal-heading"><div><span className="eyebrow">UKONČENIE ZMENY</span><h2 id="lunch-break-title">Mali ste prestávku na obed?</h2></div></div>
          <p>Pri odpovedi Áno sa odpočíta 30 minút. Pri odpovedi Nie sa započíta celý čas a k dochádzke sa pridá poznámka.</p>
          <div className="form-actions">
            <button className="button button-outline" disabled={busy} onClick={() => setShowLunchBreakPrompt(false)}>Pokračovať v práci</button>
            <button className="button button-outline" disabled={busy} onClick={() => { setShowLunchBreakPrompt(false); void attendanceAction("end_attendance", false); }}>Nie, prestávku som nemal</button>
            <button className="button button-primary" disabled={busy} onClick={() => { setShowLunchBreakPrompt(false); void attendanceAction("end_attendance", true); }}>Áno, odpočítať 30 min</button>
          </div>
        </section>
      </div>}
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
            {(isManager || (selectedEntry.user_id === session.user.id && selectedEntry.status !== "APPROVED")) && <button className="button button-outline button-small" disabled={busy} onClick={() => { setEditingEntry(selectedEntry); setPendingPhotos([]); setSelectedId(null); setShowEntryForm(true); setError(""); }}><Pencil size={14} /> Upraviť</button>}
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
