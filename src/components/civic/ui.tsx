import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Shared civic form primitives: visible labels, 44px minimum touch targets, no horizontal overflow. */
export function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-bold">{label}</label>
      {children}
    </div>
  );
}
export const inputCls = "w-full min-h-[44px] border border-black bg-white text-black px-3 py-2 text-base";
export const primaryBtnCls = "min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-bold border border-black bg-black text-white disabled:opacity-60";
export function TextInput(p: InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={inputCls} />; }
export function Btn({ secondary, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      type="button"
      {...p}
      className={`min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-bold border border-black ${secondary ? "bg-white text-black" : "bg-black text-white"} disabled:opacity-60`}
    />
  );
}
export function ErrorNote({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" data-testid="civic-error" className="text-red-800 text-sm font-bold">{msg}</p> : null;
}
