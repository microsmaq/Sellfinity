import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { register } from "@/lib/actions/auth";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Sign up — SellPilot" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <AuthForm
      title="Create your account"
      action={register}
      submitLabel="Create account"
      fields={[
        { name: "name", label: "Name", type: "text", autoComplete: "name" },
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        {
          name: "password",
          label: "Password (8+ characters)",
          type: "password",
          autoComplete: "new-password",
        },
      ]}
      footer={{ text: "Already have an account?", linkText: "Log in", href: "/login" }}
    />
  );
}
