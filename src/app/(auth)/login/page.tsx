import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { login } from "@/lib/actions/auth";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Log in — SellPilot" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <AuthForm
      title="Log in to your account"
      action={login}
      submitLabel="Log in"
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        {
          name: "password",
          label: "Password",
          type: "password",
          autoComplete: "current-password",
        },
      ]}
      footer={{ text: "New to SellPilot?", linkText: "Create an account", href: "/register" }}
    />
  );
}
