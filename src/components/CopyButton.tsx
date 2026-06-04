import { useState } from "react";
import { useT } from "../lib/i18n";

interface Props {
  text: string;
  /** Optional label shown next to the icon when the user clicks. */
  className?: string;
}

export function CopyButton({ text, className }: Props) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={className ?? "btn-ghost"}
      title={t("cpy.title")}
    >
      {copied ? (
        <>
          <span aria-hidden>✓</span>
          <span>{t("cpy.copied")}</span>
        </>
      ) : (
        <>
          <span aria-hidden>⧉</span>
          <span>{t("cpy.copy")}</span>
        </>
      )}
    </button>
  );
}
