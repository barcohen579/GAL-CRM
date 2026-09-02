import { redirect } from "next/navigation";

// The root route just hands off to the dashboard, which itself redirects
// to /login when there's no active, authorized session.
export default function RootPage() {
  redirect("/dashboard");
}
