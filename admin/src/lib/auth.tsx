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
  const can = useCallback((perm: string) => !!user && (user.role === "admin" || user.permissions.includes(perm)), [user]);

  return <AuthCtx.Provider value={{ user, ready, can, login, logout }}>{children}</AuthCtx.Provider>;
}
