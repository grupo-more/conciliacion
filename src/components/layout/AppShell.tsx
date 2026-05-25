import { Sidebar } from "./Sidebar";
import { AppHeader } from "./AppHeader";

interface Props {
  user: { email: string; name: string | null };
  children: React.ReactNode;
}

export function AppShell({ user, children }: Props) {
  return (
    <div className="min-h-screen flex items-start">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        <AppHeader user={user} />
        <main className="flex-1 p-6 page-enter">{children}</main>
      </div>
    </div>
  );
}
