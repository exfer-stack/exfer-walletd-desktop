import { Fragment, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, type MdAlign, type MdInline } from "exfer-agent";
import { useT } from "../../lib/i18n";

// Renders an agent message's markdown into the desktop design system. The parse
// is shared (exfer-agent core, XSS-safe — no raw HTML, scheme-allowlisted
// links); this file only maps the neutral AST onto Tailwind. Memoized on the
// source so streaming re-renders stay cheap.

// Addresses / tx hashes embedded in prose: EVM addresses, 56–64 hex hashes, and
// xf-prefixed bech32 exfer addresses. Each match becomes a small copyable chip;
// the surrounding text renders normally.
const ENTITY_RE = /\b(0x[0-9a-fA-F]{40}|[0-9a-fA-F]{56,64}|xf[0-9a-z]{20,})\b/g;

export function CopyChip({ value }: { value: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const short = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
  return (
    <button
      type="button"
      className="mono inline-flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 align-baseline text-[0.85em] text-cyan-200 hover:bg-neutral-700"
      title={value}
      aria-label={t("agent.copy.label", { value })}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <span>{short}</span>
      <span aria-hidden className={copied ? "text-emerald-300" : "text-neutral-500"}>
        {copied ? "✓" : "⧉"}
      </span>
      {copied && <span className="sr-only">{t("agent.copy.copied")}</span>}
    </button>
  );
}

/** Split a prose string into plain text + copyable entity chips. */
function renderText(value: string, keyPrefix: number): ReactNode {
  ENTITY_RE.lastIndex = 0;
  if (!ENTITY_RE.test(value)) return <Fragment key={keyPrefix}>{value}</Fragment>;
  ENTITY_RE.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let seg = 0;
  while ((m = ENTITY_RE.exec(value)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyPrefix}-t${seg}`}>{value.slice(last, m.index)}</Fragment>);
    out.push(<CopyChip key={`${keyPrefix}-c${seg}`} value={m[0]} />);
    last = m.index + m[0].length;
    seg++;
  }
  if (last < value.length) out.push(<Fragment key={`${keyPrefix}-t${seg}`}>{value.slice(last)}</Fragment>);
  return <Fragment key={keyPrefix}>{out}</Fragment>;
}

function renderInline(nodes: MdInline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return renderText(n.v, i);
      case "strong":
        return (
          <strong key={i} className="font-semibold text-neutral-50">
            {renderInline(n.c)}
          </strong>
        );
      case "em":
        return (
          <em key={i} className="italic">
            {renderInline(n.c)}
          </em>
        );
      case "code":
        return (
          <code key={i} className="mono rounded bg-neutral-800 px-1 py-0.5 text-[0.85em] text-cyan-200">
            {n.v}
          </code>
        );
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-300">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

const alignClass = (a: MdAlign) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 text-[15px] leading-relaxed text-neutral-100">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{renderInline(b.c)}</p>;
          case "h": {
            const size = b.level <= 1 ? "text-lg" : b.level === 2 ? "text-base" : "text-sm";
            return (
              <p key={i} className={`${size} font-semibold tracking-tight text-neutral-50`}>
                {renderInline(b.c)}
              </p>
            );
          }
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-1 pl-5 marker:text-neutral-600">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-neutral-500">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={i} className="mono overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900/70 p-3 text-[12.5px] leading-relaxed text-neutral-200">
                <code>{b.v}</code>
              </pre>
            );
          case "table":
            // Wrap in a rounded bordered frame so a two-column balance/quote
            // table reads as one block, not loose floating rows.
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-neutral-800">
                <table className="w-full border-collapse text-[13.5px]">
                  <thead>
                    <tr className="border-b border-neutral-700 bg-neutral-900/50">
                      {b.header.map((cell, j) => (
                        <th key={j} className={`px-2 py-1.5 font-semibold text-neutral-100 ${alignClass(b.align[j] ?? null)}`}>
                          {renderInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-b border-neutral-800/70 last:border-0">
                        {row.map((cell, c) => (
                          <td key={c} className={`px-2 py-1.5 text-neutral-200 ${alignClass(b.align[c] ?? null)}`}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
