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
import { HelpPopover } from "./HelpPopover";
import { useEscapeKey } from "../lib/useEscapeKey";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** The "?" that explains where this address comes from + MetaMask import. The
 *  origin/recovery story used to be an always-on paragraph under the QR — moved
 *  behind this so the default surface reads light. */
function AddrHelp() {
  const { t } = useT();
  return <HelpPopover title={t("bnb.helpTitle")} body={t("bnb.helpBody")} />;
}

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

/** A full-width, click-to-copy address chip. The address is LEFT-aligned with
 *  break-all + relaxed line-height (never the centered, jagged, char-by-char
 *  wrap the old `text-center` produced) and the copy affordance is a shrink-0
 *  trailing label, so the hex always reads as one clean block — one line where
 *  it fits (the modal), two tidy left-aligned lines where it's narrow (the swap
 *  rail), and never a ragged 4-line stack. The whole chip is the copy target. */
function AddressChip({ addr, short = false }: { addr: string; short?: boolean }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied */
    }
  }
  // Copy + QR always carry the FULL address; the visible text is the standard
  // middle-elided short form in narrow columns (the swap rail) so a 42-char hex
  // never wraps into a ragged multi-line stack, and shown in full where the
  // width allows (the modal). Kept short enough to never trip `truncate` (which
  // would clip the tail the user verifies and add a second ellipsis).
  const shown = short ? shortAddress(addr) : addr;
  return (
    <button
      type="button"
      onClick={copy}
      title={addr}
      className="group flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-left transition hover:border-neutral-600"
    >
      <code
        className={
          "min-w-0 flex-1 font-mono text-[13px] leading-relaxed tracking-tight text-neutral-200 " +
          (short ? "truncate" : "break-all")
        }
      >
        {shown}
      </code>
      <span
        className={
          "flex shrink-0 items-center gap-1 text-xs font-medium transition " +
          (copied ? "text-emerald-300" : "text-neutral-400 group-hover:text-cyan-300")
        }
      >
        <span aria-hidden>{copied ? "✓" : "⧉"}</span>
        {copied ? t("cpy.copied") : t("cpy.copy")}
      </span>
    </button>
  );
}

/** The deposit QR + address + safety hint, shared by every variant. `compact`
 *  (the narrow swap rail) middle-elides the address so it never wraps. */
function DepositBlock({
  addr,
  qrSize,
  waiting,
  isZero,
  compact = false,
}: {
  addr: string;
  qrSize: number;
  waiting: boolean;
  isZero: boolean;
  compact?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <MiniQr value={addr} size={qrSize} />
      </div>
      <AddressChip addr={addr} short={compact} />
      {/* BSC-only safety: the address is identical across EVM chains, so a
          wrong-network / wrong-token deposit is unrecoverable. The "where does
          this come from / MetaMask" story now lives behind the header "?". */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
        <span aria-hidden className="mt-px shrink-0">⚠</span>
        <span>{t("bnb.chainSafety")}</span>
      </div>
      {waiting && isZero && (
        <div className="flex items-center justify-center gap-2 text-xs text-neutral-400">
          <Spinner size={13} /> {t("swap.waitingBnb")}
        </div>
      )}
    </div>
  );
}

/** The withdraw VIEW (destination + amount, each on its own full-width row —
 *  never crammed side by side). `onBack` returns to the deposit view. */
function WithdrawBlock({
  bnbWei,
  reserveWei,
  onSent,
  onBack,
}: {
  bnbWei: string | null;
  reserveWei: string | null;
  onSent: () => void;
  onBack?: () => void;
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

  const toValid = HEX40.test(to.trim());
  const amtPositive = maxMode || Number(amt) > 0;

  return (
    <div className="space-y-4">
      {/* ── Destination — its OWN full-width row, with an inline validity ✓. ── */}
      <div>
        <label className="label">{t("swap.wdToLabel")}</label>
        <div className="relative">
          <input
            className="input pr-10 font-mono text-sm"
            placeholder={t("swap.withdrawToPlaceholder")}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={withdrawing}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {toValid && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-400">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 13l4 4L19 7" />
              </svg>
            </span>
          )}
        </div>
        {to.trim() !== "" && !toValid && (
          <div className="help text-red-300">{t("swap.errBscAddress")}</div>
        )}
      </div>

      {/* ── Amount — its OWN full-width row; the input, unit, and Max share it. ── */}
      <div>
        <div className="flex items-baseline justify-between">
          <label className="label mb-1.5">{t("swap.wdAmountLabel")}</label>
          <span className="font-mono text-xs tabular-nums text-neutral-500">
            {t("lp.balance")}: {fmtUnits(bnbWei ?? undefined, 18, 5)} BNB
          </span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-950 px-3.5 py-2.5 transition focus-within:border-cyan-400">
          <input
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-lg font-semibold tabular-nums text-neutral-100 outline-none placeholder:text-neutral-600"
            placeholder="0.0"
            value={amt}
            onChange={(e) => {
              setMaxMode(false);
              setAmt(e.target.value);
            }}
            disabled={withdrawing}
            inputMode="decimal"
          />
          <span className="shrink-0 text-sm font-medium text-neutral-500">BNB</span>
          <button
            type="button"
            className="shrink-0 rounded-md bg-neutral-800 px-2.5 py-1 text-xs font-semibold text-cyan-300 transition hover:bg-neutral-700 disabled:opacity-50"
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
        className="btn w-full"
        disabled={withdrawing || !toValid || !amtPositive}
        onClick={withdraw}
      >
        {withdrawing ? t("swap.sending") : t("swap.withdraw")}
      </button>
      {onBack && (
        <button
          type="button"
          className="btn-ghost w-full text-neutral-400"
          disabled={withdrawing}
          onClick={onBack}
        >
          {t("swap.wdBackDeposit")}
        </button>
      )}
    </div>
  );
}

/**
 * In-wallet BNB account on BSC: address (QR + copy), live balance, withdraw,
 * key export. The address/balance come from the parent's `asset` (single poll).
 *
 * Props:
 *   asset    — the useBnbAsset() result (address + bnbWei + refresh).
 *   variant  — "full" (the Dashboard deposit/withdraw modal console) |
 *              "compact" (legacy inline card) |
 *              "fund" (deposit-only lead for the buy-with-no-BNB swap step).
 *   waiting  — full/fund: show the "Waiting for your BNB…" spinner when zero.
 */
export function BnbAccount({
  asset,
  variant = "full",
  waiting = false,
  onClose,
}: {
  asset: BnbAsset;
  variant?: "full" | "compact" | "fund";
  waiting?: boolean;
  /** full only: when set, the header shows an ✕ close button (modal use). */
  onClose?: () => void;
}) {
  const { t } = useT();
  const bnbUsd = useBnbUsd();
  const { address: addr, created, bnbWei, reserveWei, refresh } = asset;
  const [exportOpen, setExportOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  // The full console is two views: deposit (QR + address) and withdraw — never
  // both crammed together. Mirrors the mobile wallet's BNB modal.
  const [view, setView] = useState<"deposit" | "withdraw">("deposit");

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
  //
  // `|| setupOpen` keeps us in this branch while the setup modal is open EVEN
  // AFTER the key is created: the background poll flips `created` to true the
  // instant the key exists, and without this the component would swap to the
  // live-account branch and UNMOUNT the SetupBnbWalletModal — tearing down the
  // recovery-phrase screen before the user has written it down. Closing the
  // modal (Done / back) clears setupOpen and lets us fall through to the
  // created surfaces.
  if (!created || setupOpen) {
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
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-neutral-100">
                {t("swap.bnbAccountTitle")}
              </div>
              <div className="text-xs text-neutral-500">{t("swap.bnbAccountSubtitle")}</div>
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t("dash.bnbClose")}
                className="-mr-1 -mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
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

  // ── Fund step (Swap buy with no BNB yet): a single-purpose "Add BNB" card.
  //    Deposit only — no withdraw form / key export, so the one action that
  //    matters here (top up, then swap) isn't buried under controls the user
  //    can't act on with a zero balance. ──
  if (variant === "fund") {
    return (
      <section className="card overflow-hidden">
        <div className="space-y-4 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
              {t("swap.fundStepTitle")}
              <AddrHelp />
            </div>
            <div className="text-xs text-neutral-500">{t("swap.fundStepSubtitle")}</div>
          </div>
          <DepositBlock addr={addr} qrSize={152} waiting={waiting} isZero={isZero} compact />
        </div>
      </section>
    );
  }

  // ── Compact card (Dashboard): always-open, self-contained card. ──
  if (variant === "compact") {
    return (
      <section className="card-padded space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
              {t("swap.bnbAccountTitle")}
              <AddrHelp />
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

  // ── Full console (Dashboard deposit/withdraw modal). Non-collapsible: it
  //    opens in its own modal, so a collapse toggle would hide the only content.
  //    A clean header (title + "?" left, live balance right) sits over the
  //    deposit / withdraw / export sections. ──
  return (
    <section className="card overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b border-neutral-800 px-5 py-4">
        <div className="flex min-w-0 items-start gap-2">
          {view === "withdraw" && (
            <button
              type="button"
              onClick={() => setView("deposit")}
              aria-label={t("swap.wdBackDeposit")}
              className="-ml-1 mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-base font-semibold text-neutral-100">
                {view === "withdraw" ? t("swap.withdrawBnb") : t("swap.bnbAccountTitle")}
              </h2>
              {view === "deposit" && <AddrHelp />}
            </div>
            {view === "deposit" && (
              <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
                {t("swap.bnbAccountSubtitle")}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <div className="text-right">
            <div className="font-mono text-lg font-semibold tabular-nums text-neutral-100">
              {fmtUnits(bnbWei ?? undefined, 18, 5)}{" "}
              <span className="text-sm font-medium text-neutral-500">BNB</span>
            </div>
            {bnbUsdValue != null && (
              <div className="font-mono text-xs tabular-nums text-neutral-500">
                ≈ {usdNumber(bnbUsdValue)}
              </div>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("dash.bnbClose")}
              className="-mr-1 -mt-0.5 grid h-7 w-7 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <div className="px-5 py-5">
        {view === "deposit" ? (
          <div className="space-y-5">
            <DepositBlock addr={addr} qrSize={168} waiting={waiting} isZero={isZero} />
            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() => setView("withdraw")}
            >
              {t("swap.withdrawBnb")}
            </button>
            <button
              type="button"
              className="btn-ghost w-full border-t border-neutral-800 pt-4 text-neutral-400"
              onClick={() => setExportOpen(true)}
            >
              {t("swap.exportBnbKey")}
            </button>
          </div>
        ) : (
          <WithdrawBlock
            bnbWei={bnbWei}
            reserveWei={reserveWei}
            onSent={() => {
              refresh();
              setView("deposit");
            }}
            onBack={() => setView("deposit")}
          />
        )}
      </div>

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
  useEscapeKey(onClose);
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
