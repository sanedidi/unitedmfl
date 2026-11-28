import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "@/lib/auth";
import { Layout, NAV, firstPage } from "@/components/Layout";
import { I } from "@/components/Icons";
import { Empty, Loading } from "@/components/ui";
import { LoginPage } from "@/pages/Login";
import { DashboardPage } from "@/pages/Dashboard";
import { MatchEditPage, MatchesPage } from "@/pages/Matches";
import { LiveConsolePage, LivePickPage } from "@/pages/Live";
import { ProtocolReviewPage, ProtocolsPage } from "@/pages/Protocols";
import { GroupsSection } from "@/pages/Groups";
import { NewsPage, PlayersPage, RequestsPage, SeasonsPage, TeamsPage, VideosPage } from "@/pages/Content";
import { ProductsPage } from "@/pages/Merch";
import { WildberriesPage } from "@/pages/Wildberries";
import { BannersPage } from "@/pages/Banners";
import { PartnersPage } from "@/pages/Partners";
import { InstagramPage } from "@/pages/Instagram";
import { StandingsPage } from "@/pages/Standings";
import { AuditPage, RoleEditPage, RolesPage, UsersPage } from "@/pages/System";
import { AiPage } from "@/pages/Ai";
import { ApplicationsSection } from "@/pages/Applications";
import { HomepageBuilder } from "@/pages/homepage/Builder";
import { StickersPage } from "@/pages/Stickers";
import { TicketsSection } from "@/pages/Tickets";
import { StadiumsSection } from "@/pages/Stadiums";
import { ScanPage } from "@/pages/Scan";

function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <NoAccess />;
}

/** A page outside the user's role, opened by a direct link. */
function NoAccess() {
  const { can, user } = useAuth();
  const { pathname } = useLocation();
  const page = NAV.flatMap((g) => g.items).find((it) => it.to !== "/" && pathname.startsWith(it.to));
  const home = firstPage(can);
  return (
    <div className="card no-access">
      <span className="no-access-ico"><I.lock size={24} /></span>
      <h2>Bu sahifa sizga yopiq</h2>
      <p>{page ? `«${page.label}» bo‘limi` : "Bu bo‘lim"} «{user?.role_name || user?.role}» roliga kirmaydi. Kirish kerak bo‘lsa, administratorga murojaat qiling.</p>
      {home && <Link className="btn btn-primary" to={home.to}>{home.label === "Dashboard" ? "Bosh sahifaga" : `${home.label}ga o‘tish`}</Link>}
    </div>
  );
}

/** Users without the dashboard land on the first page their role opens. */
function Home() {
  const { can } = useAuth();
  if (can("dashboard")) return <DashboardPage />;
  const first = firstPage(can);
  if (first) return <Navigate to={first.to} replace />;
  return <Empty title="Xush kelibsiz" text="Rolingizga hali birorta sahifa berilmagan. Administratorga murojaat qiling." />;
}

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route path="scan" element={<Guard perm="scan"><ScanPage /></Guard>} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="matches" element={<Guard perm="matches:read"><MatchesPage /></Guard>} />
        <Route path="matches/:id" element={<Guard perm="matches:read"><MatchEditPage /></Guard>} />
        <Route path="live" element={<Guard perm="live"><LivePickPage /></Guard>} />
        <Route path="live/:id" element={<Guard perm="live"><LiveConsolePage /></Guard>} />
        <Route path="protocols" element={<Guard perm="protocols"><ProtocolsPage /></Guard>} />
        <Route path="protocols/:id" element={<Guard perm="protocols"><ProtocolReviewPage /></Guard>} />
        <Route path="teams/*" element={<Guard perm="teams"><TeamsPage /></Guard>} />
        <Route path="applications/*" element={<Guard perm="applications"><ApplicationsSection /></Guard>} />
        <Route path="groups/*" element={<Guard perm="groups"><GroupsSection /></Guard>} />
        <Route path="players/*" element={<Guard perm="players"><PlayersPage /></Guard>} />
        <Route path="standings/*" element={<Guard perm="standings"><StandingsPage /></Guard>} />
        <Route path="seasons" element={<Guard perm="seasons"><SeasonsPage /></Guard>} />
        <Route path="news/*" element={<Guard perm="news"><NewsPage /></Guard>} />
        <Route path="banners/*" element={<Guard perm="banners"><BannersPage /></Guard>} />
        <Route path="homepage" element={<Guard perm="homepage"><HomepageBuilder /></Guard>} />
        <Route path="videos/*" element={<Guard perm="videos"><VideosPage /></Guard>} />
        <Route path="partners/*" element={<Guard perm="partners"><PartnersPage /></Guard>} />
        <Route path="instagram" element={<Guard perm="instagram"><InstagramPage /></Guard>} />
        <Route path="tickets/*" element={<Guard perm="tickets"><TicketsSection /></Guard>} />
        <Route path="stadiums/*" element={<Guard perm="stadiums"><StadiumsSection /></Guard>} />
        <Route path="products/*" element={<Guard perm="merch"><ProductsPage /></Guard>} />
        <Route path="requests/*" element={<Guard perm="requests"><RequestsPage /></Guard>} />
        <Route path="ai/*" element={<Guard perm="ai"><AiPage /></Guard>} />
        <Route path="telegram-stickers" element={<Guard perm="stickers"><StickersPage /></Guard>} />
        <Route path="wildberries" element={<Guard perm="wildberries"><WildberriesPage /></Guard>} />
        <Route path="users" element={<Guard perm="users"><UsersPage /></Guard>} />
        <Route path="roles" element={<Guard perm="roles"><RolesPage /></Guard>} />
        <Route path="roles/:id" element={<Guard perm="roles"><RoleEditPage /></Guard>} />
        <Route path="audit" element={<Guard perm="audit"><AuditPage /></Guard>} />
        <Route path="*" element={<Empty title="Sahifa topilmadi" />} />
      </Route>
    </Routes>
  );
}
