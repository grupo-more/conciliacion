"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { AppHeader } from "./AppHeader";

interface Props {
  user: { email: string; name: string | null };
  children: React.ReactNode;
}

export function AppShell({ user, children }: Props) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen flex items-start">
      <Sidebar
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        <AppHeader user={user} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 p-3 sm:p-4 md:p-6 page-enter">{children}</main>
      </div>
    </div>
  );
}
