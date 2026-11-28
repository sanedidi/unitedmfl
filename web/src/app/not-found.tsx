import Link from "next/link";

import { useT } from "@/lib/i18n";
export default function NotFound() {
  const tx = useT();
  return (
    <div className="container" style={{ padding: "120px 24px", textAlign: "center" }}>
      <div className="overline">404</div>
      <h1 className="h1">{tx("Sahifa topilmadi")}</h1>
      <p className="lead" style={{ margin: "16px auto 32px" }}>{tx("Bu sahifa mavjud emas yoki o‘chirilgan.")}</p>
      <Link href="/" className="btn btn-primary">{tx("Bosh sahifaga")}</Link>
    </div>
  );
}
