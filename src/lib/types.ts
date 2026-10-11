export type Role = "OWNER" | "MANAGER" | "EMPLOYEE" | "ACCOUNTANT";
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

export type CompanyPlan = "FREE" | "BASIC" | "PRO" | "TEAM";

export type Company = {
  id: string;
  name: string;
  plan: CompanyPlan;
  selected_plan?: PaymentPlan | null;
  billing_name?: string | null;
  billing_ico?: string | null;
  billing_dic?: string | null;
  billing_ic_dph?: string | null;
  billing_address?: string | null;
};

export type AdminCompanyRow = {
  company_id: string;
  name: string;
  created_at: string;
  plan: CompanyPlan;
  selected_plan: PaymentPlan | null;
  owner_email: string | null;
  owner_name: string | null;
  member_count: number;
  pending_payment_id: string | null;
  pending_payment_plan: PaymentPlan | null;
  pending_payment_amount: number | null;
  pending_payment_variable_symbol: string | null;
  pending_payment_created_at: string | null;
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
  assignees?: WorkOrderAssignment[];
};

export type WorkOrderAssignment = {
  work_order_id: string;
  company_id: string;
  user_id: string;
  accepted_at: string | null;
  created_at: string;
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

export type AbsenceType = "VACATION" | "HOME_OFFICE" | "OUT_OF_OFFICE" | "OTHER";
export type AbsenceStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export type AbsenceRequest = {
  id: string;
  company_id: string;
  user_id: string;
  type: AbsenceType;
  start_date: string;
  end_date: string;
  note: string | null;
  status: AbsenceStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  attachment_path: string | null;
  attachment_file_name: string | null;
  attachment_mime_type: string | null;
  attachment_size_bytes: number | null;
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
  stops: string[];
  return_destination: string | null;
};
