import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { rpc, formatExfer, MAX_ADDRESSES } from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { CopyButton } from "../components/CopyButton";
import { getLabel, shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";

export function Receive() {
  const { balance: data, refresh } = useWallet();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [qr, setQr] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const entries = (data?.entries ?? []).filter((e) => !isHidden(e.address));

  // Default the selection to the first address once balances arrive.
  useEffect(() => {
    if (!selected && entries.length > 0) {
      setSelected(entries[0].address);
    }
  }, [data, selected]);

  useEffect(() => {
    if (!selected) {
      setQr("");
      return;
    }
    QRCode.toDataURL(selected, {
      errorCorrectionLevel: "M",
      // Small quiet zone so finder patterns are locatable (margin:1 was too
      // tight) without a heavy white border — the QR sits in a white card.
      margin: 2,
      width: 320,
      color: {
        dark: "#171717",
        light: "#ffffff",
      },
    }).then(setQr).catch((e) => setError(String(e)));
  }, [selected]);

  async function generateAddress() {
    setGenerating(true);
    setError(null);
    try {
      const out = await rpc<GeneratedAddress>("generate_standard_address");
      await refresh();
      setSelected(out.address);
      toast.success("Address created", `${out.address.slice(0, 10)}… is ready.`);
    } catch (e) {
      setError(String(e));
      toast.error("Couldn't create address", String(e));
    } finally {
      setGenerating(false);
    }
  }

  const selectedEntry = data?.entries.find((e) => e.address === selected);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8 fade-in">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          Receive EXFER
        </h1>
        <p className="text-base text-neutral-400">
          Share an address or its QR code. Anyone can send to it — no
          permission needed.
        </p>
      </header>

      {error && <div className="banner-error">{error}</div>}

      <div className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
        {/* Address picker */}
        <section className="card overflow-hidden">
          <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Your addresses
            </h2>
            <button
              type="button"
              onClick={generateAddress}
              disabled={generating || (data?.entries.length ?? 0) >= MAX_ADDRESSES}
              className="btn-ghost"
              title={
                (data?.entries.length ?? 0) >= MAX_ADDRESSES
                  ? `Capped at ${MAX_ADDRESSES} addresses`
                  : undefined
              }
            >
              {generating ? "…" : "+ New"}
            </button>
          </header>
          <ul className="max-h-[420px] divide-y divide-neutral-800 overflow-auto">
            {entries.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-neutral-400">
                No addresses yet —{" "}
                <button
                  type="button"
                  onClick={generateAddress}
                  className="font-medium text-cyan-400 underline-offset-2 hover:underline"
                >
                  generate one
                </button>{" "}
                to start receiving.
              </li>
            ) : null}
            {entries.map((e) => {
              const active = e.address === selected;
              const label = getLabel(e.address);
              return (
                <li key={e.address}>
                  <button
                    type="button"
                    onClick={() => setSelected(e.address)}
                    className={
                      active
                        ? "block w-full px-5 py-3 text-left bg-cyan-500/10 border-l-2 border-cyan-400"
                        : "block w-full px-5 py-3 text-left border-l-2 border-transparent hover:bg-neutral-900"
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-neutral-100">
                          {label ?? "Address"}
                        </div>
                        <code className="addr-xs">
                          {shortAddress(e.address)}
                        </code>
                      </div>
                      <div className="amount text-right text-sm">
                        {formatExfer(e.balance)}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* QR + address detail */}
        <section className="card-padded space-y-5">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              Pick an address to display its QR code.
            </div>
          ) : (
            <>
              <div className="flex justify-center">
                {qr ? (
                  <img
                    src={qr}
                    alt="Address QR code"
                    className="rounded-lg border border-neutral-800"
                    width={320}
                    height={320}
                  />
                ) : (
                  <div className="flex h-[320px] w-[320px] items-center justify-center rounded-lg bg-neutral-800 text-sm text-neutral-500">
                    Rendering…
                  </div>
                )}
              </div>

              <div className="space-y-2 text-center">
                <div className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                  {getLabel(selected) ??
                    (selectedEntry?.imported
                      ? "Imported"
                      : `Address ${selectedEntry?.index ?? ""}`)}
                </div>
                <div className="amount-md">
                  {selectedEntry ? formatExfer(selectedEntry.balance) : ""}
                </div>
              </div>

              <div>
                <div className="label">Full address</div>
                <div className="flex gap-2">
                  <code className="addr flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5">
                    {selected}
                  </code>
                  <CopyButton text={selected} className="btn-secondary" />
                </div>
              </div>

              <p className="text-sm text-neutral-400">
                Reusing a single address across multiple deposits is fine
                technically, but if you want activity to be hard to link
                back to one wallet, mint a fresh address per payer.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
