// Address-format dialog (#36): the same account has two textual spellings —
// legacy hex and the checksummed bech32m "xf…". Rather than cramming a toggle
// into the address row, clicking the address opens this dialog, which lists both
// forms with a copy on each and a one-line explainer. Display-only: same bytes,
// same funds, walletd accepts either (see lib/addressDisplay.ts). Uses the same
// overlay pattern as the app's other dialogs — no bespoke popover.

import { addressKey } from "../lib/address";
import { encodeBech32mAddr } from "../lib/addressDisplay";
import { CopyButton } from "./CopyButton";
import { useT } from "../lib/i18n";
import { useEscapeKey } from "../lib/useEscapeKey";

function FormatRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex gap-2">
        <code className="addr flex-1 break-all rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5">
          {value}
        </code>
        <CopyButton text={value} className="btn-secondary" />
      </div>
    </div>
  );
}

/** The "two ways to write the same address" dialog for one address. */
export function AddressFormatsModal({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const { t } = useT();
  useEscapeKey(onClose);
  const hex = addressKey(address);
  const bech = encodeBech32mAddr(address) ?? hex;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-padded mt-24 w-full max-w-md space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-100">
            {t("addr.formInfoTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            aria-label={t("na.cancel")}
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-neutral-400">{t("addr.formInfoBody")}</p>
        <FormatRow label={t("addr.formatHex")} value={hex} />
        <FormatRow label={t("addr.formatBech32m")} value={bech} />
      </div>
    </div>
  );
}
