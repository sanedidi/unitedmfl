import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, hasSession, login as apiLogin, logout as apiLogout, onLogout, type User } from "./api";

type Ctx = { user: User | null; ready: boolean; can: (perm: string) => boolean; login: (e: string, p: string) => Promise<void>; logout: () => Promise<void> };
const AuthCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const off = onLogout(() => setUser(null));
    if (!hasSession()) {
      setReady(true);
      return () => void off();
    }
    api.get<User>("/admin/me").then(setUser).catch(() => setUser(null)).finally(() => setReady(true));
    return () => void off();
  }, []);

  const login = useCallback(async (e: string, p: string) => setUser(await apiLogin(e, p)), []);
  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);
  // "news" means viewing the page; "news:create", "news:edit", "news:delete" are its actions
  const can = useCallback((perm: string) => !!user && (user.role === "admin" || user.permissions.includes(perm.includes(":") ? perm : `${perm}:view`)), [user]);

  return <AuthCtx.Provider value={{ user, ready, can, login, logout }}>{children}</AuthCtx.Provider>;
}

/** The admin page being shown (set by the route guard), so its parts know what the role may do there. */
const PageCtx = createContext("");
export const PageScope = ({ page, children }: { page: string; children: ReactNode }) => <PageCtx.Provider value={page}>{children}</PageCtx.Provider>;

/** What the signed-in user may do on the current page. Outside a page scope everything is allowed (the server still checks). */
export function usePage() {
  const { can } = useAuth();
  const page = useContext(PageCtx);
  if (!page) return { page, create: true, edit: true, del: true, readOnly: false };
  const create = can(`${page}:create`), edit = can(`${page}:edit`), del = can(`${page}:delete`);
  return { page, create, edit, del, readOnly: !create && !edit && !del };
}

/** Renders its children only when the role may do this action on the current page. */
export function Allowed({ to, children, otherwise = null }: { to: "create" | "edit" | "delete"; children: ReactNode; otherwise?: ReactNode }) {
  const pg = usePage();
  const ok = to === "create" ? pg.create : to === "edit" ? pg.edit : pg.del;
  return <>{ok ? children : otherwise}</>;
}
