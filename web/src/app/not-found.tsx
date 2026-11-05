import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container" style={{ padding: "120px 24px", textAlign: "center" }}>
      <div className="overline">404</div>
      <h1 className="h1">Sahifa topilmadi</h1>
      <p className="lead" style={{ margin: "16px auto 32px" }}>Bu sahifa mavjud emas yoki o‘chirilgan.</p>
      <Link href="/" className="btn btn-primary">Bosh sahifaga</Link>
    </div>
  );
}
