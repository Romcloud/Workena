export type Role = "OWNER" | "MANAGER" | "EMPLOYEE";
export type EntryStatus = "PENDING" | "APPROVED" | "REJECTED";

export type Membership = {
  id: string;
  company_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: Role;
  active: boolean;
  deactivated_at: string | null;
  created_at: string;
};

export type Company = {
  id: string;
  name: string;
  plan: "FREE" | "PRO";
};

export type PaymentPlan = "BASIC" | "PRO" | "TEAM";
export type PaymentRequest = {
  id: string;
  company_id: string;
  plan: PaymentPlan;
  amount_eur: number;
  variable_symbol: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  created_at: string;
  reviewed_at: string | null;
};

export type WorkEntry = {
  id: string;
  company_id: string;
  user_id: string;
  worked_at: string;
  hours: number;
  work_type: string;
  workplace: string;
  note: string | null;
  status: EntryStatus;
  review_note: string | null;
};

export type Photo = {
  id: string;
  company_id: string;
  work_entry_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
};

export type AttendanceShift = {
  id: string;
  company_id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  source_work_entry_id: string | null;
};

export type AttendanceBreak = {
  id: string;
  shift_id: string;
  started_at: string;
  ended_at: string | null;
};

export type WorkOrderStatus = "ASSIGNED" | "IN_PROGRESS" | "DONE";

export type WorkOrder = {
  id: string;
  company_id: string;
  assignee_id: string;
  created_by: string | null;
  title: string;
  address: string;
  due_date: string;
  description: string;
  status: WorkOrderStatus;
  employee_note: string | null;
  employee_materials: string | null;
  work_report: string | null;
  report_submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkOrderPhoto = {
  id: string;
  work_order_id: string;
  phase: "BEFORE" | "AFTER";
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export type VehicleTrip = {
  id: string;
  company_id: string;
  user_id: string;
  work_order_id: string | null;
  trip_date: string;
  origin: string;
  destination: string;
  is_round_trip: boolean;
  calculated_one_way_km: number | null;
  distance_km: number;
  distance_source: "MAP" | "MANUAL" | "MAP_EDITED";
  note: string | null;
  created_at: string;
};
