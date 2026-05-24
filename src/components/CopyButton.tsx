import { useState } from "react";

interface Props {
  text: string;
  /** Optional label shown next to the icon when the user clicks. */
  className?: string;
}

export function CopyButton({ text, className }: Props) {
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
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <span aria-hidden>✓</span>
          <span>Copied</span>
        </>
      ) : (
        <>
          <span aria-hidden>⧉</span>
          <span>Copy</span>
        </>
      )}
    </button>
  );
}
