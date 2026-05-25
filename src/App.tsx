import { useEffect, useState } from "react";
import { bootstrapStatus } from "./lib/rpc";
import type { BootstrapStatus } from "./lib/types";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { Layout, type Tab } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Receive } from "./pages/Receive";
import { Send } from "./pages/Send";
import { Activity } from "./pages/Activity";
import { Settings } from "./pages/Settings";

function App() {
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

  if (!status || status.status === "needs_password") {
    return <PasswordPrompt onReady={refreshStatus} />;
  }

  if (status.status === "failed") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card-padded max-w-lg space-y-3 fade-in">
          <h1 className="text-xl font-semibold text-red-300">
            Walletd failed to start
          </h1>
          <pre className="whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-xs text-red-200">
            {status.message}
          </pre>
          <p className="text-sm text-neutral-400">
            Check the app log (stderr) for details. If the password in your
            OS keychain is wrong (e.g. you moved data between machines), you
            may need to clear it and re-enter.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === "dashboard" && <Dashboard />}
      {tab === "receive" && <Receive />}
      {tab === "send" && <Send />}
      {tab === "activity" && <Activity />}
      {tab === "settings" && (
        <Settings
          onRestart={(s) => setStatus(s)}
          fingerprint={status.fingerprint}
          localAddr={status.local_addr}
        />
      )}
    </Layout>
  );
}

export default App;
