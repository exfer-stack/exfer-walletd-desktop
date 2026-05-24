import { useEffect, useState } from "react";
import { bootstrapStatus } from "./lib/rpc";
import type { BootstrapStatus } from "./lib/types";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { Layout, type Tab } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { GenerateAddress } from "./pages/GenerateAddress";
import { Transfer } from "./pages/Transfer";
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
    // Poll once a second only while we're not ready; stop once we are.
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
      <div className="flex h-full items-center justify-center p-6">
        <div className="card max-w-md p-6 space-y-3">
          <h1 className="text-lg font-semibold text-red-700">
            walletd failed to start
          </h1>
          <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-900">
            {status.message}
          </pre>
          <p className="text-sm text-neutral-600">
            Check the app log (stderr) for details. You may need to clear the
            saved password from the OS keychain and re-enter it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === "dashboard" && <Dashboard />}
      {tab === "generate" && <GenerateAddress />}
      {tab === "transfer" && <Transfer />}
      {tab === "settings" && <Settings onRestart={(s) => setStatus(s)} />}
    </Layout>
  );
}

export default App;
