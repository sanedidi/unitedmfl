// Small line icons for the ticket pages (same stroke style as components/Icons).
type P = { size?: number };
const s = (size = 18) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const Check = ({ size }: P) => <svg {...s(size)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const Plus = ({ size }: P) => <svg {...s(size)}><path d="M12 5v14M5 12h14" /></svg>;
export const Minus = ({ size }: P) => <svg {...s(size)}><path d="M5 12h14" /></svg>;
export const Clock = ({ size }: P) => <svg {...s(size)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const Lock = ({ size }: P) => <svg {...s(size)}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /></svg>;
export const Shield = ({ size }: P) => <svg {...s(size)}><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /></svg>;
export const Info = ({ size }: P) => <svg {...s(size)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
export const Camera = ({ size }: P) => <svg {...s(size)}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>;
export const Share = ({ size }: P) => <svg {...s(size)}><path d="M4 12v7h16v-7M12 3v12M7 8l5-5 5 5" /></svg>;
export const Refresh = ({ size }: P) => <svg {...s(size)}><path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" /></svg>;
export const UserIc = ({ size }: P) => <svg {...s(size)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></svg>;
export const Alert = ({ size }: P) => <svg {...s(size)}><path d="M12 3l10 18H2zM12 10v5M12 18h.01" /></svg>;
export const Back = ({ size }: P) => <svg {...s(size)}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
export const Pin = ({ size }: P) => <svg {...s(size)}><path d="M12 21s-7-6.2-7-11.5A7 7 0 0119 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;
