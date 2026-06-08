import { useCallback, useEffect, useState } from "react";
import { bootstrapStatus } from "./lib/rpc";
import type { BootstrapStatus } from "./lib/types";
import { ToastProvider } from "./lib/toast";
import { WalletProvider } from "./lib/wallet";
import { checkForUpdate, dismissedVersion, type UpdateInfo } from "./lib/updater";
import { UpdateModal } from "./components/UpdateModal";
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
import { Governance } from "./pages/Governance";
import { Settings } from "./pages/Settings";
import { SwapWatcher } from "./components/SwapWatcher";
import { InflightProvider, useResumeTarget } from "./lib/inflight";

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

  // One-shot update check on launch. A newer version the user hasn't
  // dismissed opens the update modal (version + changelog + install-and-
  // restart); "Later" silences THAT version only, and Settings keeps the
  // manual check + install path.
  const [updatePrompt, setUpdatePrompt] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    checkForUpdate().then((u) => {
      if (u.available && u.version && u.version !== dismissedVersion()) {
        setUpdatePrompt(u);
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
  // incoming-deposit detection) around the tabbed UI. InflightProvider shares
  // the transient "resume target" hand-off so an in-flight row can route to the
  // right tab and reopen that swap / LP deposit.
  return (
    <WalletProvider>
      <InflightProvider>
        {/* Announces swap completions (toast + OS notification) even when the
            Swap tab isn't open. No-op when the swap engine is disabled. */}
        <SwapWatcher />
        <Ready
          tab={tab}
          setTab={setTab}
          status={status}
          setStatus={setStatus}
          lang={lang}
          setLang={setLang}
        />
        {/* Launch update prompt — rendered only once the wallet is ready, so
            it never covers the password gate or a failed-boot screen. */}
        {updatePrompt && <UpdateModal info={updatePrompt} onClose={() => setUpdatePrompt(null)} />}
      </InflightProvider>
    </WalletProvider>
  );
}

/** The ready, tabbed UI. Split out so it can call useResumeTarget() — the nav
 *  hand-off setter — which only works inside InflightProvider. */
function Ready({
  tab,
  setTab,
  status,
  setStatus,
  lang,
  setLang,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  status: Extract<BootstrapStatus, { status: "ready" }>;
  setStatus: (s: BootstrapStatus) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
}) {
  const { setResumeTarget } = useResumeTarget();

  // Route to a tab while priming its resume target — an in-flight swap row jumps
  // straight to Swap and resumes that swap. (LP deposits resume from within the
  // Liquidity tab, which reads resumeLpAddId off the same hand-off.)
  const resumeSwap = (swapId: string) => {
    setResumeTarget({ resumeSwapId: swapId });
    setTab("swap");
  };

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === "dashboard" && <Dashboard onOpenSwap={() => setTab("swap")} />}
      {tab === "receive" && <Receive />}
      {tab === "send" && <Send />}
      {tab === "swap" && <Swap />}
      {tab === "liquidity" && <Liquidity />}
      {tab === "activity" && <Activity onResumeSwap={resumeSwap} />}
      {tab === "governance" && <Governance />}
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
  );
}

export default App;
