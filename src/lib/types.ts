export type Role = "OWNER" | "MANAGER" | "EMPLOYEE";
export type EntryStatus = "PENDING" | "APPROVED" | "REJECTED";

export type Membership = {
  id: string;
  company_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: Role;
};

export type Company = {
  id: string;
  name: string;
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
