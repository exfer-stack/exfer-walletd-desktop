import { useEffect, useState, type FormEvent } from "react";
import {
  previewMnemonicImport,
  importMnemonicScheme,
  formatBalanceCompact,
  type MnemonicScheme,
  type MnemonicCandidate,
} from "../lib/rpc";
import { useToast } from "../lib/toast";
import { shortAddress } from "../lib/labels";

interface Props {
  onClose: () => void;
  onImported?: (address: string) => void;
}

type Preview = { standard: MnemonicCandidate; legacy: MnemonicCandidate };

/// Import one address from its 24-word recovery phrase.
///
/// The same words map to two different addresses depending on the derivation
/// scheme — "standard" (what exfer.dev / the Exfer mobile wallet export, via
/// BIP39 → EXFER-MNEMONIC-ED25519) and "legacy" (walletd's raw-key phrase).
/// We preview BOTH with their on-chain balance so the user picks the one that
/// holds their coins; when exactly one is funded we default to it and show a
/// "found your wallet" card. Standard is the default, so a phrase exported on
/// mobile re-imports here to the very same address.
export function ImportMnemonicModal({ onClose, onImported }: Props) {
  const toast = useToast();
  const [phrase, setPhrase] = useState("");
  const [scheme, setScheme] = useState<MnemonicScheme>("standard");
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wordCount = phrase.trim().split(/\s+/).filter(Boolean).length;
  const valid = wordCount === 24;

  // Debounced preview: derive both candidate addresses + balances as soon as a
  // full 24-word phrase is entered, then default to whichever holds funds.
  useEffect(() => {
    if (!valid) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreviewErr(null);
    const handle = window.setTimeout(() => {
      previewMnemonicImport(phrase.trim())
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          const sb = p.standard.balance ?? 0;
          const lb = p.legacy.balance ?? 0;
          // Default to the funded scheme; standard otherwise.
          if (lb > 0 && sb === 0) setScheme("legacy");
          else setScheme("standard");
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewErr(String(e).replace(/^Error: /, ""));
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [phrase, valid]);

  // Exactly one scheme funded ⇒ "found your wallet". Both funded / both empty
  // / chain unreachable ⇒ null (show the two-way picker).
  const fundedScheme: MnemonicScheme | null = preview
    ? ((preview.standard.balance ?? 0) > 0) !== ((preview.legacy.balance ?? 0) > 0)
      ? (preview.standard.balance ?? 0) > 0
        ? "standard"
        : "legacy"
      : null
    : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!valid) {
      setError(`Recovery phrase must be 24 words (you entered ${wordCount}).`);
      return;
    }
    setPending(true);
    try {
      const res = await importMnemonicScheme(
        phrase.trim(),
        scheme,
        label.trim() || undefined,
      );
      toast.success(
        "Address imported",
        `Added ${shortAddress(res.address)} — appears in Receive and Dashboard.`,
      );
      onImported?.(res.address);
      onClose();
    } catch (err) {
      setError(String(err).replace(/^Error: /, ""));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={onSubmit} className="card-padded w-full max-w-lg space-y-5">
        <header className="space-y-1">
          <h2 className="text-xl font-semibold text-neutral-100">
            Import recovery phrase
          </h2>
          <p className="text-sm text-neutral-400">
            Add one address from its 24-word phrase. The standard scheme matches
            exfer.dev and the Exfer mobile wallet, so a phrase exported there
            recovers the same address here.
          </p>
        </header>

        <div>
          <label className="label" htmlFor="imp-phrase">
            Recovery phrase ({wordCount}/24 words)
          </label>
          <textarea
            id="imp-phrase"
            className="input font-mono"
            rows={3}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
            placeholder="word1 word2 word3 … word24"
          />
        </div>

        {previewing && (
          <p className="help">Deriving addresses…</p>
        )}

        {previewErr && (
          <div className="banner-info text-sm">
            Can't reach the chain to preview balances right now — you can still
            import. Standard is the default scheme.
          </div>
        )}

        {/* Exactly one candidate holds coins: show it as the obvious choice. */}
        {preview && fundedScheme && (
          <div className="banner-info space-y-1">
            <div className="text-sm font-medium text-neutral-200">
              Found your wallet
            </div>
            <div className="text-lg font-semibold text-neutral-100">
              {formatBalanceCompact(preview[fundedScheme].balance ?? 0)}
            </div>
            <div className="addr-xs text-neutral-400">
              {shortAddress(preview[fundedScheme].address)} ·{" "}
              {fundedScheme === "standard" ? "Standard (BIP39)" : "Legacy"}
            </div>
          </div>
        )}

        {/* Ambiguous (both funded / both empty / chain down): let them pick. */}
        {preview && !fundedScheme && (
          <div className="space-y-2">
            <span className="label">Choose your address</span>
            {(
              [
                ["standard", "Standard (BIP39)", preview.standard],
                ["legacy", "Legacy (private-key phrase)", preview.legacy],
              ] as [MnemonicScheme, string, MnemonicCandidate][]
            ).map(([key, title, cand]) => {
              const active = scheme === key;
              const funded = (cand.balance ?? 0) > 0;
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => setScheme(key)}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                    active
                      ? "border-cyan-400 bg-cyan-500/10"
                      : "border-neutral-700 bg-neutral-800/40 hover:border-neutral-600"
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium text-neutral-200">
                      {title}
                    </span>
                    <span
                      className={`addr-xs font-medium ${
                        funded ? "text-cyan-400" : "text-neutral-500"
                      }`}
                    >
                      {cand.balance == null
                        ? "—"
                        : formatBalanceCompact(cand.balance)}
                    </span>
                  </div>
                  <div className="addr-xs text-neutral-500">
                    {shortAddress(cand.address)}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div>
          <label className="label" htmlFor="imp-mn-label">
            Label (optional)
          </label>
          <input
            id="imp-mn-label"
            type="text"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={pending}
            placeholder="e.g. cold-savings"
            maxLength={64}
          />
        </div>

        {error && <div className="banner-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button type="submit" className="btn" disabled={pending || !valid}>
            {pending ? "Importing…" : "Import"}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

function Backdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
