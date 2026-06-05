// Shared in-wallet BNB (BSC) account surface, extracted from Swap so both the
// Swap panel and the Dashboard can show it. Renders the wallet's derived BSC
// address (QR + copy), its live balance, a withdraw form with Max, a gas /
// irreversible / BSC-only safety banner, and the private-key export modal.
//
// Two variants:
//   • full   (default) — the expanded panel Swap uses: collapsible header,
//     QR + address, withdraw, key export.
//   • compact          — a self-contained card for the Dashboard: address QR +
//     balance + withdraw inline, with the same safety + export affordances.
//
// The balance/address come from a useBnbAsset() the parent owns (single poll),
// so this component never spins up its own loop — pass the hook's result in.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { rpc, revealEvmPrivateKey } from "../lib/rpc";
import { shortAddress } from "../lib/labels";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { useBnbUsd, usdNumber } from "../lib/market";
import { fmtUnits, type BnbAsset } from "../lib/bnb";
import { CopyButton } from "./CopyButton";
import { SetupBnbWalletModal } from "./SetupBnbWalletModal";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** A tiny inline spinner (Tailwind animate-spin) for the waiting bits. */
function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

/** Small QR that renders an address to a data URL (same palette as Receive). */
function MiniQr({ value, size = 160 }: { value: string; size?: number }) {
  const { t } = useT();
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: size,
      color: { dark: "#171717", light: "#ffffff" },
    })
      .then((d) => alive && setSrc(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [value, size]);
  return src ? (
    <img
      src={src}
      width={size}
      height={size}
      alt="BSC address QR"
      className="rounded-lg border border-neutral-800"
    />
  ) : (
    <div
      style={{ width: size, height: size }}
      className="flex items-center justify-center rounded-lg bg-neutral-800 text-xs text-neutral-500"
    >
      {t("swap.qrRendering")}
    </div>
  );
}

/** The deposit QR + address + copy + hint, shared by both variants. */
function DepositBlock({
  addr,
  qrSize,
  waiting,
  isZero,
}: {
  addr: string;
  qrSize: number;
  waiting: boolean;
  isZero: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center gap-3">
      <MiniQr value={addr} size={qrSize} />
      <div className="flex w-full items-start gap-2">
        <code className="addr flex-1 break-all rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-center text-xs">
          {addr}
        </code>
        <CopyButton text={addr} className="btn-secondary" />
      </div>
      <p className="text-xs text-neutral-500">{t("swap.depositHint")}</p>
      {/* BSC-only safety: the address is identical across EVM chains, so a
          wrong-network / wrong-token deposit is unrecoverable. */}
      <div className="banner-warn w-full text-xs text-amber-200">{t("bnb.chainSafety")}</div>
      {waiting && isZero && (
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <Spinner size={13} /> {t("swap.waitingBnb")}
        </div>
      )}
    </div>
  );
}

/** The withdraw form (to + amount + Max), shared by both variants. */
function WithdrawBlock({
  bnbWei,
  reserveWei,
  onSent,
}: {
  bnbWei: string | null;
  reserveWei: string | null;
  onSent: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [withdrawing, setWithdrawing] = useState(false);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  // True while the amount field holds the auto-computed "send everything"
  // figure. We then send the "max" sentinel (walletd sweeps the live balance)
  // rather than the shown estimate, and keep the figure fresh as balance polls.
  const [maxMode, setMaxMode] = useState(false);
  const [wErr, setWErr] = useState<string | null>(null);

  // balance − gas reserve, the spendable ceiling shown when Max is tapped.
  const maxSendWei = useMemo(() => {
    if (bnbWei == null) return null;
    try {
      const bal = BigInt(bnbWei);
      const res = reserveWei ? BigInt(reserveWei) : 0n;
      return bal > res ? bal - res : 0n;
    } catch {
      return null;
    }
  }, [bnbWei, reserveWei]);

  // Keep the auto-filled Max amount fresh as the balance re-polls.
  useEffect(() => {
    if (maxMode && maxSendWei != null) setAmt(fmtUnits(maxSendWei.toString(), 18, 8));
  }, [maxMode, maxSendWei]);

  async function withdraw() {
    setWErr(null);
    if (!HEX40.test(to.trim())) {
      setWErr(t("swap.errBscAddress"));
      return;
    }
    if (!maxMode && !(Number(amt) > 0)) {
      setWErr(t("swap.errEnterAmountMax"));
      return;
    }
    setWithdrawing(true);
    try {
      // In Max mode send the literal "max" so walletd sweeps from the live
      // balance (the shown figure is an estimate); otherwise send the typed
      // amount verbatim — what the user sees is what's sent.
      const r = await rpc<{ txhash: string }>("bsc_send_bnb", {
        to: to.trim(),
        amount: maxMode ? "max" : amt.trim(),
      });
      toast.success(
        t("swap.toastBnbSentTitle"),
        t("swap.toastBnbSentBody", { tx: shortAddress(r.txhash, 10, 8) }),
      );
      setTo("");
      setAmt("");
      setMaxMode(false);
      onSent();
    } catch (e) {
      setWErr(humanizeError(e));
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-neutral-800 pt-4">
      <div className="flex items-baseline justify-between">
        <div className="label mb-0">{t("swap.withdrawBnb")}</div>
        <span className="font-mono text-xs tabular-nums text-neutral-500">
          {fmtUnits(bnbWei ?? undefined, 18, 5)} BNB
        </span>
      </div>
      <div className="grid grid-cols-[1.5fr_1fr] gap-2">
        <input
          className="input font-mono text-xs"
          placeholder={t("swap.withdrawToPlaceholder")}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={withdrawing}
          autoComplete="off"
        />
        <div className="relative">
          <input
            className="input pr-12"
            placeholder={t("swap.withdrawAmtPlaceholder")}
            value={amt}
            onChange={(e) => {
              setMaxMode(false);
              setAmt(e.target.value);
            }}
            disabled={withdrawing}
            inputMode="decimal"
          />
          <button
            type="button"
            className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 text-xs"
            onClick={() => setMaxMode(true)}
            disabled={withdrawing || maxSendWei == null}
          >
            {t("swap.maxLabel")}
          </button>
        </div>
      </div>
      {/* Gas-reserve + irreversible-address warning. */}
      <div className="banner-info text-xs">{t("swap.withdrawNote")}</div>
      {wErr && <div className="banner-error">{wErr}</div>}
      <button
        type="button"
        className="btn-secondary w-full"
        disabled={withdrawing}
        onClick={withdraw}
      >
        {withdrawing ? t("swap.sending") : t("swap.withdraw")}
      </button>
    </div>
  );
}

/**
 * In-wallet BNB account on BSC: address (QR + copy), live balance, withdraw,
 * key export. The address/balance come from the parent's `asset` (single poll).
 *
 * Props:
 *   asset    — the useBnbAsset() result (address + bnbWei + refresh).
 *   variant  — "full" (collapsible Swap panel) | "compact" (Dashboard card).
 *   lead     — full only: start expanded (e.g. the buy-side deposit lead).
 *   waiting  — full only: show the "Waiting for your BNB…" spinner when zero.
 */
export function BnbAccount({
  asset,
  variant = "full",
  lead = false,
  waiting = false,
}: {
  asset: BnbAsset;
  variant?: "full" | "compact";
  lead?: boolean;
  waiting?: boolean;
}) {
  const { t } = useT();
  const bnbUsd = useBnbUsd();
  const { address: addr, created, bnbWei, reserveWei, refresh } = asset;
  const [open, setOpen] = useState(lead);
  const [exportOpen, setExportOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  // Human BNB balance + its ≈$ value (best-effort; hidden when BNB/USD absent).
  const bnbHuman = (() => {
    if (!bnbWei) return 0;
    try {
      return Number(BigInt(bnbWei)) / 1e18;
    } catch {
      return 0;
    }
  })();
  const bnbUsdValue = bnbUsd != null && bnbHuman > 0 ? bnbHuman * bnbUsd : null;
  const isZero = bnbWei != null && bnbHuman === 0;

  // No BNB key yet (seedless wallet): render a SETUP pane so this component is
  // self-contained — every consumer (Swap / Dashboard / Liquidity) gets the
  // "set up your BNB wallet" CTA for free, gating BNB actions before any form.
  if (!created) {
    const setupModal = setupOpen && (
      <SetupBnbWalletModal
        onClose={() => setSetupOpen(false)}
        onCreated={() => {
          // The key now exists; re-poll so address + balance land and this
          // component swaps to the live account surface below.
          refresh();
        }}
      />
    );

    const setupPane = (
      <div className="space-y-4">
        <p className="text-sm text-neutral-400">{t("bnb.setupBody")}</p>
        <button
          type="button"
          className="btn w-full"
          onClick={() => setSetupOpen(true)}
        >
          {t("bnb.setupTitle")}
        </button>
      </div>
    );

    if (variant === "compact") {
      return (
        <section className="card-padded space-y-4">
          <div>
            <div className="text-sm font-semibold text-neutral-100">
              {t("swap.bnbAccountTitle")}
            </div>
            <div className="text-xs text-neutral-500">{t("swap.bnbAccountSubtitle")}</div>
          </div>
          {setupPane}
          {setupModal}
        </section>
      );
    }

    return (
      <section className="card overflow-hidden">
        <div className="px-5 py-4">
          <div className="mb-4">
            <div className="text-sm font-semibold text-neutral-100">
              {t("swap.bnbAccountTitle")}
            </div>
            <div className="text-xs text-neutral-500">{t("swap.bnbAccountSubtitle")}</div>
          </div>
          {setupPane}
        </div>
        {setupModal}
      </section>
    );
  }

  // Created but address not yet polled in (transient): nothing to render.
  if (!addr) return null;

  const exportButton = (
    <div className="border-t border-neutral-800 pt-4">
      <button
        type="button"
        className="btn-ghost w-full text-neutral-400"
        onClick={() => setExportOpen(true)}
      >
        {t("swap.exportBnbKey")}
      </button>
    </div>
  );

  // ── Compact card (Dashboard): always-open, self-contained card. ──
  if (variant === "compact") {
    return (
      <section className="card-padded space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold text-neutral-100">
              {t("swap.bnbAccountTitle")}
            </div>
            <div className="text-xs text-neutral-500">{t("swap.bnbAccountSubtitle")}</div>
          </div>
          <span className="text-right">
            <span className="block font-mono text-sm tabular-nums text-neutral-200">
              {fmtUnits(bnbWei ?? undefined, 18, 5)} BNB
            </span>
            {bnbUsdValue != null && (
              <span className="block font-mono text-xs tabular-nums text-neutral-500">
                ≈ {usdNumber(bnbUsdValue)}
              </span>
            )}
          </span>
        </div>

        <DepositBlock addr={addr} qrSize={140} waiting={waiting} isZero={isZero} />
        <WithdrawBlock bnbWei={bnbWei} reserveWei={reserveWei} onSent={refresh} />
        {exportButton}

        {exportOpen && <ExportBnbKeyModal onClose={() => setExportOpen(false)} />}
      </section>
    );
  }

  // ── Full panel (Swap): collapsible. ──
  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <div>
          <div className="text-sm font-semibold text-neutral-100">{t("swap.bnbAccountTitle")}</div>
          <div className="text-xs text-neutral-500">{t("swap.bnbAccountSubtitle")}</div>
        </div>
        <span className="text-right">
          <span className="block font-mono text-sm tabular-nums text-neutral-200">
            {fmtUnits(bnbWei ?? undefined, 18, 5)} BNB
          </span>
          {bnbUsdValue != null && (
            <span className="block font-mono text-xs tabular-nums text-neutral-500">
              ≈ {usdNumber(bnbUsdValue)}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-neutral-800 px-5 py-5">
          <DepositBlock addr={addr} qrSize={160} waiting={waiting} isZero={isZero} />
          <WithdrawBlock bnbWei={bnbWei} reserveWei={reserveWei} onSent={refresh} />
          {exportButton}
        </div>
      )}

      {exportOpen && <ExportBnbKeyModal onClose={() => setExportOpen(false)} />}
    </section>
  );
}

/* The BNB (BSC/EVM) private key — passphrase-gated — so the user can import
 * their BNB address into MetaMask-style wallets ("Import account → Private
 * key"). The key is derived at m/44'/60'/0'/0/0, the standard path, so the same
 * address appears in MetaMask. Shown once and never persisted. */
export function ExportBnbKeyModal({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<{
    address: string;
    key: string;
  } | null>(null);

  async function reveal(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 4) {
      setErr(t("swap.expEnterPw"));
      return;
    }
    setBusy(true);
    try {
      // Desktop exports the BNB PRIVATE KEY only — never a recovery phrase
      // (the BNB key is seed-derived on seeded wallets; the per-key phrase is a
      // raw-key encoding, not a standard BIP-39 HD seed, so it's misleading).
      const res = await revealEvmPrivateKey(pw);
      setData({ address: res.address, key: res.private_key_hex });
      setPw("");
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-padded w-full max-w-xl space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">{t("swap.exportBnbKey")}</h2>
          <p className="mt-1 text-sm text-neutral-400">{t("swap.expDesc")}</p>
        </header>

        {!data ? (
          <form onSubmit={reveal} className="space-y-4">
            <div className="banner-warn text-sm text-amber-200">{t("swap.expWarn")}</div>
            <div>
              <label className="label" htmlFor="export-bnb-pw">
                {t("swap.walletPassword")}
              </label>
              <input
                id="export-bnb-pw"
                type="password"
                className="input"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={busy}
                autoFocus
                autoComplete="current-password"
              />
            </div>
            {err && <div className="banner-error">{err}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
                {t("swap.back")}
              </button>
              <button type="submit" className="btn-danger" disabled={busy || pw === ""}>
                {busy ? t("swap.confirming") : t("swap.expReveal")}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="banner-error">{t("swap.expRevealed")}</div>
            <div>
              <div className="label">{t("swap.bnbAddressLabel")}</div>
              <code className="addr block break-all rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
                {data.address}
              </code>
            </div>
            <div>
              <div className="label">{t("swap.expPrivKey")}</div>
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 font-mono text-sm break-all text-red-200">
                {data.key}
              </div>
            </div>
            <div className="banner-info text-xs">{t("swap.expMetaMask")}</div>
            <div className="flex justify-end gap-2">
              <CopyButton text={data.key} className="btn-secondary" />
              <button type="button" className="btn" onClick={onClose}>
                {t("swap.done")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
