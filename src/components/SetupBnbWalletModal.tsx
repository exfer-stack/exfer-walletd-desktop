// Set up the wallet's BNB (BSC/EVM) key — generate a fresh one or import an
// existing MetaMask account. This is the single creation surface the BnbAccount
// setup pane (and so Swap / Dashboard / Liquidity) routes to when
// `created == false`. Ported from the mobile CreateBnbWalletSheet.
//
// GENERATE: bsc_create_address → show the 24-word mnemonic → require an "I've
// backed it up" confirmation before Done. The BNB wallet has its OWN mnemonic
// (independent of the EXFER seed), MetaMask-compatible at m/44'/60'/0'/0/0.
//
// IMPORT: a raw private key (0x + 64 hex) via bsc_import_key, or a 12/24-word
// BIP-39 phrase via bsc_import_mnemonic. Both MetaMask-compatible.

import { useCallback, useEffect, useState } from "react";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { createBscWallet, importBscKey, importBscMnemonic } from "../lib/bnb";
import { useEscapeKey } from "../lib/useEscapeKey";
import { CopyButton } from "./CopyButton";

type Mode = "choose" | "generate" | "import";
type ImportKind = "key" | "phrase";

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

/**
 * The full create-or-import flow as a modal. `onCreated` fires with the new BNB
 * address once a key exists (so the caller can refresh the shared poll); the
 * modal closes itself on Done / successful import.
 */
export function SetupBnbWalletModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (address: string) => void;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>("choose");
  // While a freshly-generated BNB recovery phrase is on screen but not yet
  // acknowledged, neither Escape nor a backdrop click may dismiss the modal —
  // the key already exists in the keystore, so a careless close could leave the
  // user funding an address whose phrase they never wrote down. Done (after the
  // "I backed it up" check) is the only way out of that screen.
  const [locked, setLocked] = useState(false);
  const guardedClose = useCallback(() => {
    if (!locked) onClose();
  }, [locked, onClose]);
  useEscapeKey(guardedClose);

  return (
    <div
      // items-start + overflow-y-auto so a tall pane (the 24-word phrase) SCROLLS
      // instead of overflowing the viewport top & bottom; my-auto re-centers it
      // vertically whenever it does fit.
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) guardedClose();
      }}
    >
      <div className="card-padded my-auto w-full max-w-2xl space-y-4">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">{t("bnb.setupTitle")}</h2>
        </header>

        {mode === "choose" && <ChoosePane onPick={setMode} />}
        {mode === "generate" && (
          <GeneratePane
            onClose={onClose}
            onCreated={onCreated}
            onBack={() => setMode("choose")}
            onLockChange={setLocked}
          />
        )}
        {mode === "import" && (
          <ImportPane
            onClose={onClose}
            onCreated={onCreated}
            onBack={() => setMode("choose")}
          />
        )}
      </div>
    </div>
  );
}

/** First step: generate a new BNB wallet, or import one you already have. */
function ChoosePane({ onPick }: { onPick: (m: Mode) => void }) {
  const { t } = useT();
  return (
    <div className="space-y-3">
      <div className="banner-info text-sm">{t("bnb.setupBody")}</div>
      <OptionRow
        title={t("bnb.genTitle")}
        sub={t("bnb.genSub")}
        onClick={() => onPick("generate")}
      />
      <OptionRow
        title={t("bnb.importTitle")}
        sub={t("bnb.importSub")}
        onClick={() => onPick("import")}
      />
    </div>
  );
}

function OptionRow({
  title,
  sub,
  onClick,
}: {
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-left transition-colors hover:border-neutral-700"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-neutral-100">{title}</div>
        <div className="text-xs text-neutral-500">{sub}</div>
      </div>
      <span className="text-neutral-600">›</span>
    </button>
  );
}

/** Generate a fresh BNB wallet, reveal the 24 words, require a backup confirm. */
function GeneratePane({
  onClose,
  onCreated,
  onBack,
  onLockChange,
}: {
  onClose: () => void;
  onCreated: (address: string) => void;
  onBack: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ address: string; words: string[] } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Lock the modal (no Escape / backdrop dismiss) while the recovery phrase is
  // shown but not yet acknowledged. Release on unmount (e.g. Back to choose).
  useEffect(() => {
    onLockChange(!!result && !confirmed);
    return () => onLockChange(false);
  }, [result, confirmed, onLockChange]);

  async function generate() {
    setBusy(true);
    try {
      const r = await createBscWallet();
      setResult({ address: r.address, words: r.mnemonic });
    } catch (e) {
      toast.error(t("bnb.genFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  function done() {
    if (!result) return;
    onCreated(result.address);
    toast.success(t("bnb.created"), t("bnb.createdBody"));
    onClose();
  }

  if (!result) {
    return (
      <div className="space-y-4">
        <div className="banner-info text-sm">{t("bnb.genIntro")}</div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
            {t("swap.back")}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={generate}>
            {busy ? <Spinner /> : t("bnb.genAction")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="banner-warn text-sm text-amber-200">{t("bnb.backupWarn")}</div>
      {/* 6 across → 4 tidy rows, so a 4-char word doesn't sprawl half the modal. */}
      <div className="grid grid-cols-6 gap-1.5">
        {result.words.map((w, i) => (
          <div
            key={i}
            className="flex items-baseline gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-1.5 py-1.5"
          >
            <span className="w-3 shrink-0 text-right font-mono text-[10px] text-neutral-600">{i + 1}</span>
            <span className="truncate font-mono text-xs text-neutral-100">{w}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <CopyButton text={result.words.join(" ")} className="btn-secondary" />
      </div>
      <div>
        <div className="label">{t("bnb.address")}</div>
        <div className="flex items-center gap-2">
          <code className="addr flex-1 break-all rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
            {result.address}
          </code>
          <CopyButton text={result.address} className="btn-secondary" />
        </div>
      </div>
      <label
        className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 ${
          confirmed
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-neutral-800 bg-neutral-900"
        }`}
      >
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 h-4 w-4 flex-none accent-emerald-500"
        />
        <span className="text-sm text-neutral-200">{t("bnb.backupConfirm")}</span>
      </label>
      <div className="flex justify-end">
        <button type="button" className="btn" disabled={!confirmed} onClick={done}>
          {t("swap.done")}
        </button>
      </div>
    </div>
  );
}

/** Import an existing MetaMask account: raw private key or BIP-39 phrase. */
function ImportPane({
  onClose,
  onCreated,
  onBack,
}: {
  onClose: () => void;
  onCreated: (address: string) => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [kind, setKind] = useState<ImportKind>("key");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = value.trim();
  const keyValid = /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed);
  const phraseWords = trimmed.split(/\s+/).filter(Boolean);
  const phraseValid = phraseWords.length === 12 || phraseWords.length === 24;
  const valid = kind === "key" ? keyValid : phraseValid;

  async function go() {
    if (!valid) return;
    setBusy(true);
    try {
      const r =
        kind === "key"
          ? await importBscKey(trimmed)
          : await importBscMnemonic(phraseWords.join(" "));
      onCreated(r.address);
      toast.success(t("bnb.imported"), t("bnb.importedBody"));
      onClose();
    } catch (e) {
      toast.error(t("bnb.importFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(["key", "phrase"] as ImportKind[]).map((k) => {
          const active = kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setValue("");
              }}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                active
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                  : "border-neutral-800 bg-neutral-900 text-neutral-300"
              }`}
            >
              {k === "key" ? t("bnb.tabKey") : t("bnb.tabPhrase")}
            </button>
          );
        })}
      </div>

      {kind === "key" ? (
        <div>
          <label className="label" htmlFor="bnb-import-key">
            {t("bnb.keyLabel")}
          </label>
          <input
            id="bnb-import-key"
            className="input font-mono text-xs"
            placeholder="0x…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoFocus
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-neutral-500">{t("bnb.keyHelp")}</p>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="bnb-import-phrase">
            {t("bnb.phraseLabel", { n: phraseWords.length })}
          </label>
          <textarea
            id="bnb-import-phrase"
            className="input h-24 resize-none font-mono text-xs"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("bnb.phrasePlaceholder")}
            spellCheck={false}
            autoFocus
          />
          <p className="mt-1 text-xs text-neutral-500">{t("bnb.phraseHelp")}</p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
          {t("swap.back")}
        </button>
        <button type="button" className="btn" disabled={!valid || busy} onClick={go}>
          {busy ? <Spinner /> : t("bnb.importAction")}
        </button>
      </div>
    </div>
  );
}
