"use client";

import { useT } from "@/lib/i18n";
export default function Error({ reset }: { error: Error; reset: () => void }) {
  const tx = useT();
  return (
    <div className="container" style={{ padding: "120px 24px", textAlign: "center" }}>
      <div className="overline">{tx("Xatolik")}</div>
      <h1 className="h1">{tx("Nimadir noto‘g‘ri ketdi")}</h1>
      <p className="lead" style={{ margin: "16px auto 32px" }}>{tx("Ma’lumotlarni yuklab bo‘lmadi. Birozdan so‘ng qayta urinib ko‘ring.")}</p>
      <button className="btn btn-primary" onClick={reset}>{tx("Qayta urinish")}</button>
    </div>
  );
}
