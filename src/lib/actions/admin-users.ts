"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

const planSchema = z.enum(["FREE", "PRO", "SCALE"]);

export async function adminUpdateUserPlan(formData: FormData): Promise<void> {
  await requireAdmin();
  const userId = z.string().min(1).max(100).parse(formData.get("userId"));
  const plan = planSchema.parse(formData.get("plan"));
  await db.user.updateMany({ where: { id: userId, role: "USER" }, data: { plan } });
  revalidatePath("/admin");
  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${userId}`);
}
