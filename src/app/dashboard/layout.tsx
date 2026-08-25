import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { logout } from "./actions";

const NAV_LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/products", label: "Products" },
  { href: "/dashboard/offers", label: "Offers" },
  { href: "/dashboard/rewards", label: "Rewards" },
  { href: "/dashboard/escrow", label: "Escrow" },
  { href: "/dashboard/recovery", label: "Recovery" },
  { href: "/dashboard/policies", label: "Policies" },
  { href: "/dashboard/readiness", label: "Readiness" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  return (
    <div className="flex flex-col flex-1">
      <nav className="border-b bg-white">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="font-semibold">{merchant.name}</span>
            <div className="flex items-center gap-1">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm px-3 py-1.5 rounded hover:bg-gray-100 text-gray-700"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
          <form action={logout}>
            <button type="submit" className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50">
              Log out
            </button>
          </form>
        </div>
      </nav>
      <div className="flex-1">{children}</div>
    </div>
  );
}
