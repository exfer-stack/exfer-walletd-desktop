import { useCallback, useEffect, useState } from "react";
import { bootstrapStatus } from "./lib/rpc";
import type { BootstrapStatus } from "./lib/types";
import { ToastProvider, useToast } from "./lib/toast";
import { WalletProvider } from "./lib/wallet";
import { checkForUpdate } from "./lib/updater";
import {
  I18nProvider,
  useT,
  readLang,
  persistLang,
  type Lang,
} from "./lib/i18n";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { Layout, type Tab } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Receive } from "./pages/Receive";
import { Send } from "./pages/Send";
import { Swap } from "./pages/Swap";
import { Liquidity } from "./pages/Liquidity";
import { Activity } from "./pages/Activity";
import { Settings } from "./pages/Settings";
import { SwapWatcher } from "./components/SwapWatcher";

function App() {
  // Language lives at the very root so I18nProvider wraps everything —
  // including the PasswordPrompt and the failed-bootstrap screen, which render
  // before WalletProvider. Switching re-renders all useT() consumers instantly.
  const [lang, setLangState] = useState<Lang>(readLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    persistLang(l);
  }, []);

  return (
    <I18nProvider lang={lang}>
      <ToastProvider>
        <AppInner lang={lang} setLang={setLang} />
      </ToastProvider>
    </I18nProvider>
  );
}

function AppInner({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const toast = useToast();
  const { t } = useT();
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");

  async function refreshStatus() {
    const s = await bootstrapStatus();
    setStatus(s);
  }

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(() => {
      setStatus((prev) => {
        if (prev && prev.status === "ready") return prev;
        refreshStatus();
        return prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // One-shot update check on launch. If a newer version is published,
  // nudge the user toward Settings → Check for updates.
  useEffect(() => {
    checkForUpdate().then((u) => {
      if (u.available) {
        toast.info(
          t("app.updateAvailableTitle", { v: u.version ?? "" }),
          t("app.updateAvailableBody"),
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!status || status.status === "needs_password") {
    return <PasswordPrompt onReady={refreshStatus} />;
  }

  if (status.status === "failed") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card-padded max-w-lg space-y-3 fade-in">
          <h1 className="text-xl font-semibold text-red-300">
            {t("app.bootFailedTitle")}
          </h1>
          <pre className="whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-xs text-red-200">
            {status.message}
          </pre>
          <p className="text-sm text-neutral-400">{t("app.bootFailedHint")}</p>
        </div>
      </div>
    );
  }

  // Ready — mount the wallet data layer (shared balance + polling +
  // incoming-deposit detection) around the tabbed UI.
  return (
    <WalletProvider>
      {/* Announces swap completions (toast + OS notification) even when the
          Swap tab isn't open. No-op when the swap engine is disabled. */}
      <SwapWatcher />
      <Layout activeTab={tab} onTabChange={setTab}>
        {tab === "dashboard" && <Dashboard />}
        {tab === "receive" && <Receive />}
        {tab === "send" && <Send />}
        {tab === "swap" && <Swap />}
        {tab === "liquidity" && <Liquidity />}
        {tab === "activity" && <Activity />}
        {tab === "settings" && (
          <Settings
            onRestart={(s) => setStatus(s)}
            fingerprint={status.fingerprint}
            localAddr={status.local_addr}
            lang={lang}
            setLang={setLang}
          />
        )}
      </Layout>
    </WalletProvider>
  );
}

export default App;
