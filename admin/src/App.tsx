import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/lib/auth";
import { Layout } from "@/components/Layout";
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
import { AuditPage, RolesPage, UsersPage } from "@/pages/System";
import { AiPage } from "@/pages/Ai";
import { ApplicationsSection } from "@/pages/Applications";
import { HomepageBuilder } from "@/pages/homepage/Builder";
import { StickersPage } from "@/pages/Stickers";

function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <Empty title="Ruxsat yo‘q" text="Bu bo‘lim sizning rolingiz uchun yopiq." />;
}

/** Operators and shop managers land on their own section instead of a forbidden dashboard. */
function Home() {
  const { can } = useAuth();
  if (can("dashboard")) return <DashboardPage />;
  if (can("live")) return <Navigate to="/live" replace />;
  return <Empty title="Xush kelibsiz" />;
}

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <LoginPage />;
  return (
    <Routes>
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
        <Route path="groups/*" element={<Guard perm="teams"><GroupsSection /></Guard>} />
        <Route path="players/*" element={<Guard perm="teams"><PlayersPage /></Guard>} />
        <Route path="standings/*" element={<Guard perm="standings"><StandingsPage /></Guard>} />
        <Route path="seasons" element={<Guard perm="seasons"><SeasonsPage /></Guard>} />
        <Route path="news/*" element={<Guard perm="news"><NewsPage /></Guard>} />
        <Route path="banners/*" element={<Guard perm="banners"><BannersPage /></Guard>} />
        <Route path="homepage" element={<Guard perm="homepage"><HomepageBuilder /></Guard>} />
        <Route path="videos/*" element={<Guard perm="videos"><VideosPage /></Guard>} />
        <Route path="partners/*" element={<Guard perm="partners"><PartnersPage /></Guard>} />
        <Route path="instagram" element={<Guard perm="videos"><InstagramPage /></Guard>} />
        <Route path="products/*" element={<Guard perm="merch"><ProductsPage /></Guard>} />
        <Route path="requests/*" element={<Guard perm="requests"><RequestsPage /></Guard>} />
        <Route path="ai/*" element={<Guard perm="users"><AiPage /></Guard>} />
        <Route path="telegram-stickers" element={<Guard perm="users"><StickersPage /></Guard>} />
        <Route path="wildberries" element={<Guard perm="users"><WildberriesPage /></Guard>} />
        <Route path="users" element={<Guard perm="users"><UsersPage /></Guard>} />
        <Route path="roles" element={<Guard perm="users"><RolesPage /></Guard>} />
        <Route path="audit" element={<Guard perm="users"><AuditPage /></Guard>} />
        <Route path="*" element={<Empty title="Sahifa topilmadi" />} />
      </Route>
    </Routes>
  );
}
