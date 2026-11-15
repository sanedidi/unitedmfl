import { Route, Routes } from "react-router";
import { HomePage, LinkPage } from "@/pages/Landing";
import { ApplicationPage } from "@/pages/Application";

export default function App() {
  return (
    <Routes>
      <Route index element={<HomePage />} />
      <Route path="a/:token" element={<ApplicationPage />} />
      <Route path=":code" element={<LinkPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
