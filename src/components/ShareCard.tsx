import { useMemo, useState } from "react";
import { useT } from "../i18n";
import { buildCard, cardToSvg, drawCard } from "../lib/shareCard";

/** Share control (S-122): builds a card client-side (no upload, no third party) with source, as-of date and disclaimers. */
export default function ShareCard({ testId = "share", title, lines, source, asOf, projection = false, demo = false }: {
  testId?: string; title: string; lines: { label: string; value: string }[]; source: string; asOf: string; projection?: boolean; demo?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const card = useMemo(() => buildCard({
    title, lines, source, asOf, projection, demo,
    labels: { source: t("share.source"), asOf: t("share.asOf"), projection: t("share.projection"), demo: t("common.demo"), footer: t("meta.title") },
  }), [title, lines, source, asOf, projection, demo, t]);
  const svg = useMemo(() => cardToSvg(card), [card]);
  const href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const downloadPng = () => {
    const canvas = document.createElement("canvas");
    canvas.width = card.width; canvas.height = card.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawCard(ctx, card);
    canvas.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = "people-pulse-card.png"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  };

  return (
    <div data-testid={testId} className="space-y-2">
      <button data-testid={`${testId}-button`} type="button" aria-expanded={open} disabled={lines.length === 0} onClick={() => setOpen(!open)}
        className="border border-black px-3 py-1 text-[10px] uppercase tracking-widest font-black cursor-pointer disabled:opacity-40">{t("share.button")}</button>
      {open && (
        <div role="dialog" aria-label={t("share.title")} data-testid={`${testId}-dialog`} className="border border-black bg-white p-3 space-y-2 max-w-md">
          <img data-testid={`${testId}-preview`} src={href} alt={card.text.join(". ")} className="w-full h-auto border border-black/20" />
          <ul data-testid={`${testId}-text`} className="sr-only">{card.text.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <p className="text-[11px] font-sans text-slate-700">{t("share.note")}</p>
          <div className="flex flex-wrap gap-2">
            <button data-testid={`${testId}-png`} type="button" onClick={downloadPng} className="border border-black bg-black text-[#F9F7F2] px-3 py-1 text-[10px] uppercase tracking-widest font-black cursor-pointer">PNG</button>
            <a data-testid={`${testId}-svg`} href={href} download="people-pulse-card.svg" className="border border-black px-3 py-1 text-[10px] uppercase tracking-widest font-black">SVG</a>
            <button type="button" onClick={() => setOpen(false)} className="px-3 py-1 text-[10px] uppercase tracking-widest font-bold underline cursor-pointer">{t("share.close")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
