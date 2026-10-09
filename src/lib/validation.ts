import { z } from "zod";

export const companySchema = z.object({
  name: z.string().trim().min(2).max(120),
  emailDomain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .optional()
    .or(z.literal(""))
    .transform((value) => value || undefined)
    .refine((value) => !value || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value), "Neplatná e-mailová doména."),
  enforceEmailDomain: z.boolean(),
});

export const entrySchema = z.object({
  workedAt: z.coerce.date(),
  hours: z.coerce.number().gt(0).lte(24),
  workType: z.string().trim().min(2).max(120),
  workplace: z.string().trim().min(2).max(120),
  note: z.string().trim().max(2000).optional(),
});

export function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}
