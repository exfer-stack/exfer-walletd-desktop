import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { rpc, formatExfer, MAX_ADDRESSES } from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { CopyButton } from "../components/CopyButton";
import { PendingChip, netPending } from "../components/PendingChip";
import { getLabel, setLabel, shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { useEscapeKey } from "../lib/useEscapeKey";

export function Receive() {
  const { balance: data, refresh } = useWallet();
  const toast = useToast();
  const { t } = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [qr, setQr] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // The "+ New" flow opens a tiny dialog so a fresh key can be named up front
  // (optional). Blank name = just create, like before.
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  useEscapeKey(() => {
    if (creatingOpen && !generating) setCreatingOpen(false);
  });

  const entries = (data?.entries ?? []).filter((e) => !isHidden(e.address));

  // Default the selection to the first address once balances arrive, and
  // re-home it if the selected address is no longer visible (e.g. it was
  // hidden elsewhere) — otherwise the QR/right pane keeps showing an address
  // that's dropped out of the list.
  useEffect(() => {
    if (entries.length === 0) return;
    if (!selected || !entries.some((e) => e.address === selected)) {
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
    }).then(setQr).catch((e) => setError(humanizeError(e)));
  }, [selected]);

  // Each generated address is its own independent key. We let the user name it
  // in one step: generate, then save the (optional) name as the address label.
  async function generateAddress(name?: string) {
    setGenerating(true);
    setError(null);
    try {
      const label = name?.trim() ?? "";
      const out = await rpc<GeneratedAddress>("generate_standard_address", {
        label: label || null,
      });
      if (label) setLabel(out.address, label);
      await refresh();
      setSelected(out.address);
      toast.success(
        t("rcv.addrCreatedTitle"),
        label
          ? t("na.createdNamed", { name: label })
          : t("rcv.addrCreatedBody", { addr: out.address.slice(0, 10) }),
      );
      setCreatingOpen(false);
      setCreateName("");
    } catch (e) {
      setError(humanizeError(e));
      toast.error(t("rcv.addrCreateFailTitle"), humanizeError(e));
    } finally {
      setGenerating(false);
    }
  }

  function openCreate() {
    setCreateName("");
    setCreatingOpen(true);
  }

  const selectedEntry = data?.entries.find((e) => e.address === selected);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8 fade-in">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t("rcv.title")}
        </h1>
        <p className="text-sm text-neutral-400">
          {t("rcv.subtitle")}
        </p>
      </header>

      {error && <div className="banner-error">{error}</div>}

      <div className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
        {/* Address picker */}
        <section className="card flex flex-col overflow-hidden">
          <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              {t("rcv.yourAddresses")}
            </h2>
            <button
              type="button"
              onClick={openCreate}
              disabled={generating || (data?.entries.length ?? 0) >= MAX_ADDRESSES}
              className="btn-ghost min-w-[5rem]"
              title={
                (data?.entries.length ?? 0) >= MAX_ADDRESSES
                  ? t("rcv.cappedTitle", { n: MAX_ADDRESSES })
                  : undefined
              }
            >
              {generating ? t("rcv.creating") : t("rcv.new")}
            </button>
          </header>
          <ul className="flex-1 divide-y divide-neutral-800 overflow-auto">
            {entries.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-neutral-400">
                {t("rcv.emptyPre")}{" "}
                <button
                  type="button"
                  onClick={openCreate}
                  className="font-medium text-cyan-400 underline-offset-2 hover:underline"
                >
                  {t("rcv.emptyLink")}
                </button>{" "}
                {t("rcv.emptyPost")}
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
                        ? "block w-full px-5 py-3 text-left bg-cyan-500/10 border-l-2 border-cyan-400 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
                        : "block w-full px-5 py-3 text-left border-l-2 border-transparent hover:bg-neutral-900 focus-visible:bg-neutral-900 focus-visible:border-cyan-400/60 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-neutral-100">
                          {label ?? shortAddress(e.address)}
                        </div>
                        {/* Only when a label exists does the short address need
                            a second line; without a label the short address is
                            already the primary identity. walletd marks every
                            self-generated key imported:true, so the old
                            "Imported"/"Address N" line was misleading — dropped. */}
                        {label ? (
                          <code className="addr-xs">
                            {shortAddress(e.address)}
                          </code>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5 text-right text-sm">
                        <PendingChip amount={netPending(e)} />
                        <span className="amount">{formatExfer(e.balance)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          {entries.length > 0 ? (
            <div className="border-t border-neutral-800 px-5 py-2 text-right text-xs tabular-nums text-neutral-500">
              {entries.length}/{MAX_ADDRESSES}
            </div>
          ) : null}
        </section>

        {/* QR + address detail */}
        <section className="card-padded space-y-5">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              {t("rcv.pickPrompt")}
            </div>
          ) : (
            <>
              <div className="flex justify-center">
                {qr ? (
                  <img
                    src={qr}
                    alt={t("rcv.qrAlt")}
                    className="rounded-lg border border-neutral-800"
                    width={320}
                    height={320}
                  />
                ) : (
                  <div className="flex h-[320px] w-[320px] items-center justify-center rounded-lg bg-neutral-800 text-sm text-neutral-500">
                    {t("rcv.rendering")}
                  </div>
                )}
              </div>

              <div className="space-y-2 text-center">
                <div className="text-base font-medium text-neutral-100">
                  {getLabel(selected) ?? shortAddress(selected)}
                </div>
                <div className="flex items-center justify-center gap-2">
                  <div className="amount-md">
                    {selectedEntry ? formatExfer(selectedEntry.balance) : ""}
                  </div>
                  {selectedEntry && <PendingChip amount={netPending(selectedEntry)} />}
                </div>
              </div>

              <div>
                <div className="label">{t("rcv.fullAddress")}</div>
                <div className="flex gap-2">
                  <code className="addr flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5">
                    {selected}
                  </code>
                  <CopyButton text={selected} className="btn-secondary" />
                </div>
              </div>

              <p className="text-sm text-neutral-400">
                {t("rcv.privacyNote")}
              </p>
            </>
          )}
        </section>
      </div>

      {/* New-address dialog — an optional name field so a fresh key can be
          labelled on creation. Blank name just creates, like before. */}
      {creatingOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-6 fade-in"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !generating)
              setCreatingOpen(false);
          }}
        >
          <div className="card-padded mt-24 w-full max-w-sm space-y-4">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              {t("na.title")}
            </h2>
            <p className="text-sm text-neutral-400">{t("na.info")}</p>
            <div>
              <label className="label">{t("na.nameOptional")}</label>
              <input
                className="input"
                value={createName}
                maxLength={28}
                autoFocus
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !generating)
                    generateAddress(createName);
                  if (e.key === "Escape" && !generating) setCreatingOpen(false);
                }}
                placeholder={t("na.namePlaceholder")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCreatingOpen(false)}
                disabled={generating}
              >
                {t("na.cancel")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => generateAddress(createName)}
                disabled={generating}
              >
                {generating ? t("rcv.creating") : t("na.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
