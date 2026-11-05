"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="container" style={{ padding: "120px 24px", textAlign: "center" }}>
      <div className="overline">Xatolik</div>
      <h1 className="h1">Nimadir noto‘g‘ri ketdi</h1>
      <p className="lead" style={{ margin: "16px auto 32px" }}>Ma’lumotlarni yuklab bo‘lmadi. Birozdan so‘ng qayta urinib ko‘ring.</p>
      <button className="btn btn-primary" onClick={reset}>Qayta urinish</button>
    </div>
  );
}
