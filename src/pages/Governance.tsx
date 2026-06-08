// Community voting / governance — desktop.
//
// Matches the approved simplified DESKTOP mockups
// (crypto-due-dil/voting-mockups/desktop/*.html):
//   • a list view with a one-time 3-step primer, sections
//     (Open / Upcoming / Closed), and proposal cards carrying a live
//     mini-result strip,
//   • a two-pane detail view — description + 1-line summary + expander,
//     per-address selector (desktop dropdown), options, pre-vote warning,
//     and a primary "Vote" action on the LEFT; a sticky power + live-results
//     rail on the RIGHT,
//   • voted and ineligible states.
//
// Voting is PER-ADDRESS (not aggregated): the user picks which address votes,
// that address's current balance is its power, and every address that clears
// `min_power` can cast its own independent vote. Signing goes through walletd's
// `sign_message` (Spend) via `governance.ts` → byte-identical canonical payload
// per SIGNING_SPEC.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useT, type MsgKey } from "../lib/i18n";
import { useWallet } from "../lib/wallet";
import { getLabel, shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { useToast } from "../lib/toast";
import { devmock } from "../lib/devmock";
import { humanizeError } from "../lib/errors";
import {
  getProposals,
  getProposal,
  getResults,
  getMyVote,
  submitVote,
  mediaUrl,
  fetchMediaBytes,
  type Proposal,
  type VoteResult,
  type I18nText,
  type Attachment,
} from "../lib/governance";
import type { Lang } from "../lib/i18n";

// 1 EXFER = 1e8 exfers. Power throughout the vote API is in exfers.
const EXFER_UNIT = 100_000_000;

// ── small format helpers ────────────────────────────────────────────────────

/** Governance EXFER figure (power is in exfers, 1 EXFER = 1e8 exfers).
 *
 *  ≥ 1 EXFER  → whole, comma-grouped ("128,400"), matching the mockups.
 *  0 < x < 1  → decimal, up to 8 places, trailing zeros trimmed ("0.2"), so a
 *               sub-1-EXFER balance/power doesn't collapse to a misleading "0".
 *  0          → "0". (Governance-local on purpose — other screens keep their
 *               own whole-EXFER formatting.) */
function fmtExfer(exfers: number | bigint): string {
  const v = typeof exfers === "bigint" ? Number(exfers) / EXFER_UNIT : exfers / EXFER_UNIT;
  if (v === 0) return "0";
  if (v >= 1) return Math.floor(v).toLocaleString("en-US");
  return v.toFixed(8).replace(/\.?0+$/, "");
}

/** Pick the active language's text from a bilingual {en,zh}. */
function pickText(t: I18nText, lang: Lang): string {
  return lang === "zh" ? t.zh || t.en : t.en || t.zh;
}

/** Human-readable byte size for an attachment ("48 KB", "1.4 MB"). */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0);
  return `${s} ${units[i]}`;
}

// ── inline stroke icons (lucide paths, currentColor) ────────────────────────

function Svg({
  size = 16,
  className,
  strokeWidth = 2,
  children,
}: {
  size?: number;
  className?: string;
  strokeWidth?: number;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const IconWallet = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <rect x="2" y="6" width="20" height="14" rx="2.5" />
    <path d="M16 13h.01" />
    <path d="M2 10h20" />
  </Svg>
);
const IconShieldCheck = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <path d="M12 2l9 5v6c0 5-3.5 8-9 9-5.5-1-9-4-9-9V7z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);
const IconClock = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
const IconCalendar = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 9h18M8 2v4M16 2v4" />
  </Svg>
);
const IconCheck = (p: { size?: number; className?: string; strokeWidth?: number }) => (
  <Svg {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);
const IconChevDown = (p: { size?: number; className?: string }) => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
const IconChevUp = (p: { size?: number; className?: string }) => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
);
const IconChevRight = (p: { size?: number; className?: string }) => (
  <Svg {...p} strokeWidth={2.4}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);
const IconBack = (p: { size?: number; className?: string }) => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);
const IconLock = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);
const IconWarn = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
const IconInfo = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h.01M11 12h1v4h1" />
  </Svg>
);
const IconDownload = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
);
const IconFile = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <path d="M14 3v5h5" />
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
  </Svg>
);
const IconImage = (p: { size?: number; className?: string }) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-4.5-4.5L7 20" />
  </Svg>
);
const IconX = (p: { size?: number; className?: string }) => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
// ── address model for the per-address selector ──────────────────────────────

interface AddrPower {
  address: string;
  label: string;
  short: string;
  power: number; // exfers
  eligible: boolean;
  voted: boolean; // already voted on THIS proposal
}

// ── proposal status → pill ──────────────────────────────────────────────────

function statusPill(p: Proposal, t: (k: MsgKey) => string): { cls: string; label: string } {
  if (p.status === "open") return { cls: "pill-info", label: t("gov.statusOpen") };
  if (p.status === "upcoming") return { cls: "pill-warn", label: t("gov.statusUpcoming") };
  // closed / finalized — derive pass/reject from results when we have a clear
  // top option (binary proposals: first option "for"/"approve" wins ≥ 50%).
  const res = p.results;
  if (res && p.options.length >= 1) {
    const total = Object.values(res.by_option).reduce(
      (acc, v) => acc + BigInt(v || "0"),
      0n,
    );
    const top = p.options[0].id;
    const topPow = BigInt(res.by_option[top] || "0");
    if (total > 0n) {
      const passed = topPow * 2n >= total; // ≥ 50%
      return passed
        ? { cls: "pill-success", label: t("gov.statusPassed") }
        : { cls: "pill-error", label: t("gov.statusRejected") };
    }
  }
  return { cls: "pill-neutral", label: t("gov.statusClosed") };
}

// ── time formatting ─────────────────────────────────────────────────────────

function fmtDuration(
  secs: number,
  t: (k: MsgKey, v?: Record<string, string | number>) => string,
): string {
  if (secs <= 0) return t("gov.closed");
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return t("gov.dayHour", { d, h });
  if (h > 0) return t("gov.hourMin", { h, m });
  return t("gov.minutes", { n: Math.max(1, m) });
}

function fmtAgo(
  secs: number,
  t: (k: MsgKey, v?: Record<string, string | number>) => string,
): string {
  if (secs < 5) return t("gov.justNow");
  if (secs < 60) return t("gov.secondsAgo", { n: secs });
  return t("gov.minutesAgo", { n: Math.floor(secs / 60) });
}

// ════════════════════════════════════════════════════════════════════════════
// Top-level: list ↔ detail router
// ════════════════════════════════════════════════════════════════════════════

export function Governance() {
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) {
    return <ProposalDetail id={openId} onBack={() => setOpenId(null)} />;
  }
  return <GovernanceList onOpen={setOpenId} />;
}

// ════════════════════════════════════════════════════════════════════════════
// List view
// ════════════════════════════════════════════════════════════════════════════

function GovernanceList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, lang } = useT();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProposals(await getProposals());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sections = useMemo(() => {
    const list = proposals ?? [];
    const open = list.filter((p) => p.status === "open");
    const upcoming = list.filter((p) => p.status === "upcoming");
    const closed = list.filter((p) => p.status === "closed" || p.status === "finalized");
    return { open, upcoming, closed };
  }, [proposals]);

  return (
    <div className="mx-auto max-w-7xl p-8 fade-in">
      {/* page header */}
      <div className="mb-1.5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-100">
            {t("gov.title")}
            {proposals && (
              <span className="ml-2 text-sm font-normal text-neutral-500">
                · {proposals.length}
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-neutral-400">{t("gov.subtitle")}</p>
        </div>
      </div>

      {/* onboarding primer (always shown) */}
      <div className="relative mb-2 mt-4 flex items-stretch rounded-xl border border-neutral-800 bg-neutral-950 px-2 py-4">
        <PrimerStep n={1} text={t("gov.primerStep1")}>
          <IconWallet size={18} />
        </PrimerStep>
        <PrimerStep n={2} text={t("gov.primerStep2")}>
          <IconShieldCheck size={18} />
        </PrimerStep>
        <PrimerStep n={3} text={t("gov.primerStep3")}>
          <IconInfo size={18} />
        </PrimerStep>
      </div>

      {/* loading / error / empty */}
      {!proposals && !error && (
        <div className="mt-10 text-center text-sm text-neutral-500">{t("gov.loading")}</div>
      )}
      {error && (
        <div className="mt-6 flex items-center justify-between gap-3 banner-error">
          <span>{t("gov.loadError")}</span>
          <button type="button" onClick={load} className="btn-secondary px-3 py-1.5 text-sm">
            {t("gov.retry")}
          </button>
        </div>
      )}
      {proposals && proposals.length === 0 && !error && (
        <div className="mt-10 text-center text-sm text-neutral-500">{t("gov.empty")}</div>
      )}

      {/* sections */}
      {sections.open.length > 0 && (
        <Section title={t("gov.sectionOpen")} count={sections.open.length}>
          <div className="grid grid-cols-2 gap-4">
            {sections.open.map((p) => (
              <ProposalCard key={p.id} p={p} lang={lang} t={t} onOpen={onOpen} />
            ))}
          </div>
        </Section>
      )}
      {sections.upcoming.length > 0 && (
        <Section title={t("gov.sectionUpcoming")} count={sections.upcoming.length}>
          <div className="grid grid-cols-2 gap-4">
            {sections.upcoming.map((p) => (
              <ProposalCard key={p.id} p={p} lang={lang} t={t} onOpen={onOpen} />
            ))}
          </div>
        </Section>
      )}
      {sections.closed.length > 0 && (
        <Section title={t("gov.sectionClosed")} count={sections.closed.length}>
          <div className="grid grid-cols-2 gap-4">
            {sections.closed.map((p) => (
              <ProposalCard key={p.id} p={p} lang={lang} t={t} onOpen={onOpen} />
            ))}
          </div>
        </Section>
      )}

      {proposals && proposals.length > 0 && (
        <p className="mt-8 text-center text-xs text-neutral-600">
          {lang === "zh"
            ? "每持有 1 EXFER = 1 票 · 票权随余额计算 · 各提案门槛见详情"
            : "1 EXFER = 1 vote · power tracks your balance · threshold shown per proposal"}
        </p>
      )}
    </div>
  );
}

function PrimerStep({ n, text, children }: { n: number; text: string; children: ReactNode }) {
  return (
    <div
      className={
        "flex min-w-0 flex-1 items-center gap-3 px-4 py-1" +
        (n > 1 ? " border-l border-neutral-800" : "")
      }
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-300">
        {children}
      </span>
      <span className="text-sm leading-snug text-neutral-400">{text}</span>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <>
      <div className="mb-3 mt-7 flex items-center gap-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          {title}
        </span>
        <span className="mono rounded-md bg-neutral-500/15 px-1.5 py-px text-[0.7rem] text-neutral-500">
          {count}
        </span>
        <span className="h-px flex-1 bg-neutral-800" />
      </div>
      {children}
    </>
  );
}

// ── proposal card ───────────────────────────────────────────────────────────

function ProposalCard({
  p,
  lang,
  t,
  onOpen,
}: {
  p: Proposal;
  lang: Lang;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  onOpen: (id: string) => void;
}) {
  const pill = statusPill(p, t);
  const ended = p.status === "closed" || p.status === "finalized";
  const propId = p.id.toUpperCase();

  // result percentages (option[0] = "for", option[1] = "against", rest abstain)
  const res = p.results;
  const total = res
    ? Object.values(res.by_option).reduce((a, v) => a + BigInt(v || "0"), 0n)
    : 0n;
  const pct = (id: string): number => {
    if (!res || total === 0n) return 0;
    return Number((BigInt(res.by_option[id] || "0") * 1000n) / total) / 10;
  };
  const forId = p.options[0]?.id;
  const againstId = p.options[1]?.id;
  const abstainId = p.options[2]?.id;
  const forPct = forId ? pct(forId) : 0;
  const againstPct = againstId ? pct(againstId) : 0;
  const abstainPct = abstainId ? pct(abstainId) : 0;

  // Only surface a vote count when the list payload carried a tally — open
  // proposals often omit `results`, and "0 votes" on a live proposal that has
  // votes is misleading. (The detail view fetches the live /results tally.)
  const votes = res?.total_voters ?? null;

  // time meta
  const now = Math.floor(Date.now() / 1000);
  let timeNode: ReactNode = null;
  if (p.status === "open") {
    const left = p.window.close_time - now;
    const urgent = left > 0 && left < 86_400;
    timeNode = (
      <span className={"inline-flex items-center gap-1.5" + (urgent ? " text-amber-300" : "")}>
        <IconClock size={13} />
        {t("gov.timeLeft", { t: fmtDuration(left, t) })}
      </span>
    );
  } else if (p.status === "upcoming") {
    const until = p.window.open_time - now;
    timeNode = (
      <span className="inline-flex items-center gap-1.5">
        <IconCalendar size={13} />
        {t("gov.startsIn", { t: fmtDuration(until, t) })}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(p.id)}
      className={
        "block w-full rounded-xl border border-neutral-800 bg-neutral-950 p-5 text-left transition hover:border-neutral-700 hover:bg-[#0e0e0e]" +
        (ended ? " opacity-75" : "")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-base font-semibold leading-snug text-neutral-100">
          {pickText(p.title, lang)}
        </div>
        <span className={"pill flex-none " + pill.cls}>{pill.label}</span>
      </div>

      <div className="mt-2.5 mb-3.5 line-clamp-2 text-sm leading-relaxed text-neutral-400">
        {pickText(p.description, lang)}
      </div>

      <div className="flex flex-wrap items-center gap-2.5 text-[0.78rem] text-neutral-500">
        <span className="mono rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs font-medium text-neutral-300">
          {propId}
        </span>
        {timeNode && <Dot />}
        {timeNode}
        {ended && (
          <>
            <Dot />
            <span>{t("gov.forPct", { pct: forPct })}</span>
          </>
        )}
        {votes != null && (
          <>
            <Dot />
            <span>{t("gov.votesCount", { n: votes.toLocaleString("en-US") })}</span>
          </>
        )}
      </div>

      {/* live mini-result strip on an open card */}
      {p.status === "open" && res && (
        <div className="mt-3">
          <div className="gov-mini-track h-[5px] rounded-full bg-neutral-800">
            <span className="bg-cyan-500" style={{ width: `${forPct}%` }} />
            <span className="bg-neutral-600" style={{ width: `${againstPct}%` }} />
          </div>
          <div className="mono mt-1.5 flex justify-between text-[0.7rem] text-neutral-500">
            <span className="text-cyan-300">{t("gov.legendFor", { pct: forPct })}</span>
            <span>
              {t("gov.legendRest", {
                against: againstPct,
                abstain: abstainPct,
              })}
            </span>
          </div>
        </div>
      )}
    </button>
  );
}

function Dot() {
  return <span className="h-[3px] w-[3px] flex-none rounded-full bg-neutral-700" />;
}

// ════════════════════════════════════════════════════════════════════════════
// Detail view (two-pane)
// ════════════════════════════════════════════════════════════════════════════

function ProposalDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const { balance } = useWallet();

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [results, setResults] = useState<VoteResult | null>(null);
  const [resultsAt, setResultsAt] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);

  // per-address vote state, keyed by address → option_id (or null)
  const [votesByAddr, setVotesByAddr] = useState<Record<string, string | null>>({});

  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  // Visible wallet addresses (hidden ones are excluded everywhere else in the
  // app — Send/Swap/Dashboard all filter `isHidden` — so the voting selector
  // must too). A stable comma-joined key lets effects depend on the address
  // *set* rather than the whole `balance` object, which the wallet poll
  // replaces with a fresh reference every tick.
  const visibleEntries = useMemo(
    () => (balance?.entries ?? []).filter((e) => !isHidden(e.address)),
    [balance],
  );
  const addrKey = useMemo(
    () => visibleEntries.map((e) => e.address).join(","),
    [visibleEntries],
  );

  // wallet addresses → power model for THIS proposal
  const addrs: AddrPower[] = useMemo(() => {
    const entries = visibleEntries;
    const minPower = proposal?.min_power ?? 0;
    return entries.map((e) => {
      const label = getLabel(e.address) || shortAddress(e.address, 6, 4);
      return {
        address: e.address,
        label,
        short: shortAddress(e.address, 6, 4),
        power: e.balance,
        eligible: e.balance >= minPower,
        voted: !!votesByAddr[e.address],
      };
    });
  }, [visibleEntries, proposal, votesByAddr]);

  const eligibleAddrs = useMemo(() => addrs.filter((a) => a.eligible), [addrs]);

  // initial load: proposal + results + per-address my-vote.
  //
  // The detail endpoint only embeds `results` once a proposal is
  // closed/finalized; while it's open the live provisional tally lives at the
  // dedicated `/results` endpoint. So for open proposals fetch that separately —
  // otherwise the rail/banner show a perpetual "0 votes / 0%" even when the
  // backend has votes.
  const loadProposal = useCallback(async () => {
    setError(null);
    try {
      const p = await getProposal(id);
      setProposal(p);
      if (p.status === "open") {
        try {
          setResults(await getResults(id));
        } catch {
          setResults(p.results);
        }
      } else {
        setResults(p.results);
      }
      setResultsAt(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    loadProposal();
  }, [loadProposal]);

  // Resolve my-vote for each wallet address once we know the addresses.
  // Depend on the stable address-set key (not the `balance` object, which the
  // wallet poll re-creates every ~12s): otherwise this re-fires on every poll,
  // re-fetching getMyVote for every address and clobbering the optimistic
  // votesByAddr set by doVote / cleared by "Change option" (flicker / mid-edit
  // snap-back to the voted state).
  useEffect(() => {
    let cancelled = false;
    const addresses = addrKey ? addrKey.split(",") : [];
    if (addresses.length === 0) return;
    (async () => {
      const map: Record<string, string | null> = {};
      await Promise.all(
        addresses.map(async (address) => {
          try {
            const mv = await getMyVote(id, address);
            map[address] = mv?.option_id ?? null;
          } catch {
            map[address] = null;
          }
        }),
      );
      if (!cancelled) setVotesByAddr(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, addrKey]);

  // default the selected address: prefer the first eligible one (mockup leads
  // with 主地址), else the first address.
  useEffect(() => {
    if (selectedAddr) return;
    if (addrs.length === 0) return;
    const firstEligible = addrs.find((a) => a.eligible);
    setSelectedAddr((firstEligible ?? addrs[0]).address);
  }, [addrs, selectedAddr]);

  const selected = useMemo(
    () => addrs.find((a) => a.address === selectedAddr) ?? null,
    [addrs, selectedAddr],
  );

  // The selected address's current recorded vote on this proposal.
  const myVote = selectedAddr ? votesByAddr[selectedAddr] ?? null : null;

  // live results polling while the proposal is open — hit the dedicated
  // /results endpoint, which carries the live provisional tally (the detail
  // endpoint's embedded `results` is null until close/finalize).
  useEffect(() => {
    if (!proposal || proposal.status !== "open") return;
    const tick = async () => {
      try {
        setResults(await getResults(id));
        setResultsAt(Date.now());
      } catch {
        /* transient; keep last */
      }
    };
    pollRef.current = window.setInterval(tick, 12_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [id, proposal]);

  // ── derived results display ──
  const total = results
    ? Object.values(results.by_option).reduce((a, v) => a + BigInt(v || "0"), 0n)
    : 0n;
  const pct = (oid: string): number => {
    if (!results || total === 0n) return 0;
    return Math.round(Number((BigInt(results.by_option[oid] || "0") * 100n) / total));
  };
  const optVotesPower = (oid: string): bigint =>
    results ? BigInt(results.by_option[oid] || "0") : 0n;

  const doVote = async () => {
    if (!selectedAddr || !selectedOption || !proposal) return;
    setSubmitting(true);
    try {
      await submitVote(proposal.id, selectedOption, selectedAddr);
      // record locally + refresh server tally (live /results while open)
      setVotesByAddr((m) => ({ ...m, [selectedAddr]: selectedOption }));
      try {
        setResults(proposal.status === "open" ? await getResults(id) : (await getProposal(id)).results);
        setResultsAt(Date.now());
      } catch {
        /* keep last */
      }
    } catch (e) {
      toast.error(t("gov.voteFailed"), String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (error) {
    return (
      <div className="mx-auto max-w-6xl p-8 fade-in">
        <BackButton label={t("gov.back")} onClick={onBack} />
        <div className="mt-6 flex items-center justify-between gap-3 banner-error">
          <span>{t("gov.loadError")}</span>
          <button type="button" onClick={loadProposal} className="btn-secondary px-3 py-1.5 text-sm">
            {t("gov.retry")}
          </button>
        </div>
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="mx-auto max-w-6xl p-8 fade-in">
        <BackButton label={t("gov.back")} onClick={onBack} />
        <div className="mt-10 text-center text-sm text-neutral-500">{t("gov.loading")}</div>
      </div>
    );
  }

  const pill = statusPill(proposal, t);
  const now = Math.floor(Date.now() / 1000);
  const open = proposal.status === "open";
  const timeLeft = proposal.window.close_time - now;
  const pillLabel =
    open && timeLeft > 0 ? `${pill.label} · ${t("gov.timeLeft", { t: fmtDuration(timeLeft, t) })}` : pill.label;

  const isIneligible = open && selected != null && !selected.eligible;
  const hasVoted = open && myVote != null;

  return (
    <div className="mx-auto max-w-6xl p-8 fade-in">
      <BackButton label={t("gov.back")} onClick={onBack} />

      {/* title block */}
      <div className="mb-3.5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2.5">
            <span className="mono rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs font-medium text-neutral-300">
              {proposal.id.toUpperCase()}
            </span>
            <span className={"pill " + pill.cls}>{pillLabel}</span>
          </div>
          <h1 className="text-[1.55rem] font-semibold leading-tight tracking-tight text-neutral-50">
            {pickText(proposal.title, lang)}
          </h1>
        </div>
      </div>

      {/* two-pane */}
      <div className="grid grid-cols-[1fr_380px] items-start gap-6">
        {/* LEFT column */}
        <div>
          {/* voted confirmation banner */}
          {hasVoted && (
            <VotedBanner
              proposal={proposal}
              lang={lang}
              t={t}
              optionId={myVote!}
              addr={selected}
            />
          )}

          {/* description */}
          <div className="card mb-5 p-6">
            <Description text={pickText(proposal.description, lang)} expanded={expanded} />
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2.5 inline-flex items-center gap-1.5 py-1 text-sm font-medium text-neutral-400 hover:text-neutral-200"
            >
              {expanded ? t("gov.viewLess") : t("gov.viewFull")}
              {expanded ? (
                <IconChevUp size={15} className="text-neutral-500" />
              ) : (
                <IconChevDown size={15} className="text-neutral-500" />
              )}
            </button>
          </div>

          {/* attachments (inline images + downloadable files) */}
          {proposal.attachments.length > 0 && (
            <Attachments items={proposal.attachments} t={t} />
          )}

          {/* INELIGIBLE gate (selected address below threshold) */}
          {isIneligible ? (
            <IneligibleGate
              selected={selected!}
              minPower={proposal.min_power}
              t={t}
            />
          ) : hasVoted ? (
            // VOTED state — show which address voted + actions
            <VotedActions
              addr={selected}
              t={t}
              eligibleCount={eligibleAddrs.length}
              onChange={() => {
                // "change option": clear local vote selection so options show
                setVotesByAddr((m) => ({ ...m, [selectedAddr!]: null }));
                setSelectedOption(myVote);
              }}
              onAnother={() => {
                // Prefer the next eligible address that hasn't voted yet.
                const fresh = eligibleAddrs.find(
                  (a) => a.address !== selectedAddr && !a.voted,
                );
                if (fresh) {
                  setSelectedAddr(fresh.address);
                  setSelectedOption(null);
                  return;
                }
                // Else hop to another eligible address that has already voted so
                // the user lands on its VOTED state and can change it there. The
                // picker/dropdown lives only in the VOTE-state branch, so opening
                // it from here (VOTED state) would be a no-op dead-end.
                const votedOther = eligibleAddrs.find(
                  (a) => a.address !== selectedAddr,
                );
                if (votedOther) {
                  setSelectedAddr(votedOther.address);
                  setSelectedOption(null);
                  return;
                }
                // No other eligible address exists — tell the user instead of
                // silently doing nothing.
                toast.info(t("gov.allAddrVotedTitle"), t("gov.allAddrVotedBody"));
              }}
            />
          ) : (
            // VOTE state — address selector + options + warning + action
            <>
              <div className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                {t("gov.voteWithAddress")}
              </div>
              <AddressSelector
                addrs={addrs}
                selected={selected}
                minPower={proposal.min_power}
                open={pickerOpen}
                setOpen={setPickerOpen}
                onPick={(a) => {
                  setSelectedAddr(a.address);
                  setSelectedOption(null);
                  setPickerOpen(false);
                }}
                t={t}
              />

              <div className="mb-2.5 mt-5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                {t("gov.chooseVote")}
              </div>
              {proposal.options.map((o) => {
                const sel = selectedOption === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setSelectedOption(o.id)}
                    className={
                      "mb-2.5 flex w-full items-center gap-3.5 rounded-lg border px-4 py-3.5 text-left transition " +
                      (sel
                        ? "border-cyan-500 bg-cyan-500/[0.08]"
                        : "border-neutral-800 bg-neutral-950 hover:border-neutral-700")
                    }
                  >
                    <span
                      className={
                        "flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 " +
                        (sel ? "border-cyan-400" : "border-neutral-600")
                      }
                    >
                      <span
                        className={
                          "h-2 w-2 rounded-full bg-cyan-400 transition-opacity " +
                          (sel ? "opacity-100" : "opacity-0")
                        }
                      />
                    </span>
                    <span className="text-[0.95rem] font-semibold text-neutral-100">
                      {pickText(o.label, lang)}
                    </span>
                  </button>
                );
              })}

              {/* pre-vote warning */}
              <div className="mb-4 mt-5 flex items-center gap-2.5 banner-warn font-semibold">
                <IconWarn size={16} className="flex-none text-amber-300" />
                <span>{t("gov.preVoteWarn")}</span>
              </div>

              {/* primary action */}
              <button
                type="button"
                disabled={!selectedOption || submitting}
                onClick={doVote}
                className="btn w-full"
              >
                {!submitting && <IconCheck size={19} strokeWidth={2.2} />}
                {submitting
                  ? t("gov.voting")
                  : selectedOption
                    ? t("gov.voteAs", {
                        option: optionLabel(proposal, selectedOption, lang),
                        label: selected?.label ?? "",
                      })
                    : t("gov.vote")}
              </button>
            </>
          )}
        </div>

        {/* RIGHT rail */}
        <aside className="sticky top-0 flex flex-col gap-5">
          {/* power card (hide while showing the ineligible gate, which carries
              the other-addresses card instead) */}
          {!isIneligible && selected && (
            <PowerCard
              label={selected.label}
              power={selected.power}
              voted={hasVoted}
              t={t}
            />
          )}

          {/* ineligible: show this wallet's other addresses with quick-switch */}
          {isIneligible && (
            <OtherAddressesCard
              addrs={addrs}
              selectedAddr={selectedAddr}
              onPick={(a) => {
                setSelectedAddr(a.address);
                setSelectedOption(null);
              }}
              t={t}
            />
          )}

          {/* live results */}
          <ResultsRail
            proposal={proposal}
            lang={lang}
            t={t}
            results={results}
            resultsAt={resultsAt}
            pct={pct}
            optVotesPower={optVotesPower}
            myVote={hasVoted ? myVote : null}
          />
        </aside>
      </div>
    </div>
  );
}

function optionLabel(p: Proposal, oid: string, lang: Lang): string {
  const o = p.options.find((x) => x.id === oid);
  return o ? pickText(o.label, lang) : oid;
}

// ── attachments (inline images + downloadable files) ───────────────────────
//
// Bytes are self-hosted by exfer-vote at GET /media/<id> (public, no-auth) and
// fetched ONLY through the dual transport in governance.ts so the Tauri build's
// cert pinning is preserved (never host-direct). `kind` is server-decided — we
// render INLINE only `"image"` (raster png/jpeg/webp/gif); everything else,
// including SVG, is a download-only "Files" row. We never sniff content_type
// client-side and never render any attachment as markdown/HTML.

function Attachments({
  items,
  t,
}: {
  items: Attachment[];
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
}) {
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  const [viewing, setViewing] = useState<Attachment | null>(null);

  return (
    <div className="card mb-5 p-6">
      <div className="mb-3.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        <IconImage size={14} className="text-neutral-500" />
        {t("gov.attachments")}
        <span className="mono rounded-md bg-neutral-500/15 px-1.5 py-px text-[0.7rem] text-neutral-500">
          {items.length}
        </span>
      </div>

      {/* inline image thumbnails → click to view full (compact fixed tiles so
          many images stay dense and don't push the voting UI far down) */}
      {images.length > 0 && (
        <div className="att-thumb-grid mb-1 gap-3">
          {images.map((a) => (
            <ImageThumb key={a.id} att={a} t={t} onOpen={() => setViewing(a)} />
          ))}
        </div>
      )}

      {/* non-image files list */}
      {files.length > 0 && (
        <div className={images.length > 0 ? "mt-4" : ""}>
          {images.length > 0 && (
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              {t("gov.files")}
            </div>
          )}
          <div className="flex flex-col gap-2">
            {files.map((a) => (
              <FileRow key={a.id} att={a} t={t} />
            ))}
          </div>
        </div>
      )}

      {viewing && <ImageLightbox att={viewing} t={t} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Lazy image bytes for a Tauri-safe `<img>` source. In a plain browser the
 *  dev-proxy URL is directly usable; in the Tauri build we must pull the bytes
 *  through the CA-pinned client and hand back an object URL (a bare `/media/...`
 *  path would resolve against the webview origin, bypassing the pinned proxy). */
function useMediaSrc(att: Attachment): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(() =>
    devmock.isActive() ? mediaUrl(att.id) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (devmock.isActive()) {
      setSrc(mediaUrl(att.id));
      setFailed(false);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    (async () => {
      try {
        const { bytes, contentType } = await fetchMediaBytes(att.id);
        if (cancelled) return;
        url = URL.createObjectURL(
          new Blob([bytes as unknown as BlobPart], { type: contentType }),
        );
        setSrc(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [att.id]);

  return { src, failed };
}

function ImageThumb({
  att,
  t,
  onOpen,
}: {
  att: Attachment;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  onOpen: () => void;
}) {
  const { src, failed } = useMediaSrc(att);
  const [imgError, setImgError] = useState(false);
  const broken = failed || imgError;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={att.filename}
      className="group relative aspect-square overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 transition hover:border-neutral-600"
    >
      {src && !broken ? (
        <img
          src={src}
          alt={att.filename}
          onError={() => setImgError(true)}
          className="h-full w-full object-cover transition group-hover:scale-[1.03]"
        />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-neutral-600">
          <IconImage size={22} />
          {broken && <span className="text-[0.66rem]">{t("gov.imgFail")}</span>}
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5 text-left text-[0.68rem] text-neutral-300">
        {att.filename}
      </span>
    </button>
  );
}

function ImageLightbox({
  att,
  t,
  onClose,
}: {
  att: Attachment;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const { src, failed } = useMediaSrc(att);
  const [imgError, setImgError] = useState(false);
  const broken = failed || imgError;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 fade-in"
      onClick={onClose}
    >
      <div className="relative max-h-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2.5 flex items-center justify-between gap-4">
          <span className="mono truncate text-sm text-neutral-300">{att.filename}</span>
          <div className="flex flex-none items-center gap-2">
            <DownloadButton att={att} t={t} compact />
            <button
              type="button"
              onClick={onClose}
              title={t("gov.closeImage")}
              className="btn-secondary px-2.5 py-1.5 text-sm"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>
        {src && !broken ? (
          <img
            src={src}
            alt={att.filename}
            onError={() => setImgError(true)}
            className="max-h-[78vh] w-auto rounded-lg border border-neutral-800 object-contain"
          />
        ) : (
          <div className="flex h-64 w-[60vw] max-w-2xl items-center justify-center rounded-lg border border-neutral-800 bg-neutral-950 text-sm text-neutral-500">
            {broken ? t("gov.imgFail") : t("gov.loading")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function FileRow({
  att,
  t,
}: {
  att: Attachment;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex items-center gap-3.5 rounded-lg border border-neutral-800 bg-neutral-950 px-3.5 py-3">
      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-lg bg-neutral-900 text-neutral-400">
        <IconFile size={19} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.9rem] font-medium text-neutral-100">
          {att.filename}
        </span>
        <span className="mono whitespace-nowrap text-xs text-neutral-500">{fmtBytes(att.size)}</span>
      </span>
      <DownloadButton att={att} t={t} />
    </div>
  );
}

/** Download an attachment. Browser-dev → a normal anchor download of the
 *  dev-proxy URL. Tauri build → pull the bytes through the CA-pinned client
 *  (governance.ts → vote_media_get), pick a destination with the OS save dialog
 *  (the same `@tauri-apps/plugin-dialog` pattern backup/export uses), and write
 *  the file. We never fetch media host-direct in the webview. */
function DownloadButton({
  att,
  t,
  compact,
}: {
  att: Attachment;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  compact?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Browser-dev: a plain anchor download of the (proxy) URL is enough.
  if (devmock.isActive()) {
    return (
      <a
        href={mediaUrl(att.id)}
        download={att.filename}
        className={
          "btn-secondary flex-none " + (compact ? "px-2.5 py-1.5 text-sm" : "px-3 py-2 text-sm")
        }
      >
        <IconDownload size={16} />
        {!compact && t("gov.download")}
      </a>
    );
  }

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 1. Pick a destination via the OS save dialog (same pattern as export).
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({ defaultPath: att.filename });
      if (!dest) return; // user cancelled
      // 2. Rust pulls the bytes through the CA-pinned vote client and writes them
      //    straight to disk — same "Rust owns the disk write" shape as export.
      await invoke("vote_media_save", {
        path: `/media/${encodeURIComponent(att.id)}`,
        dest,
      });
      toast.success(t("gov.download"), t("gov.savedTo", { path: dest }));
    } catch (err) {
      toast.error(t("gov.downloadFail"), humanizeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        "btn-secondary flex-none " + (compact ? "px-2.5 py-1.5 text-sm" : "px-3 py-2 text-sm")
      }
    >
      <IconDownload size={16} />
      {!compact && (busy ? t("gov.downloading") : t("gov.download"))}
    </button>
  );
}

// ── description with collapse ───────────────────────────────────────────────

function Description({ text, expanded }: { text: string; expanded: boolean }) {
  return (
    <p
      className={
        "text-[0.92rem] leading-relaxed text-neutral-300 " +
        (expanded ? "" : "line-clamp-1")
      }
    >
      {text}
    </p>
  );
}

// ── voted confirmation banner ───────────────────────────────────────────────

function VotedBanner({
  proposal,
  lang,
  t,
  optionId,
  addr,
}: {
  proposal: Proposal;
  lang: Lang;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  optionId: string;
  addr: AddrPower | null;
}) {
  return (
    <div className="mb-5 flex items-center gap-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-4">
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-emerald-500/[0.18] text-emerald-300">
        <IconCheck size={20} strokeWidth={2.6} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold text-emerald-50">
          {t("gov.votedTitle", { option: optionLabel(proposal, optionId, lang) })}
        </span>
        <span className="mt-0.5 block text-sm text-emerald-300/85">
          {t("gov.votedSub", {
            label: addr?.label ?? "",
            power: addr ? fmtExfer(addr.power) : "0",
          })}
        </span>
      </span>
    </div>
  );
}

// ── voted actions (change / vote another) ───────────────────────────────────

function VotedActions({
  addr,
  t,
  eligibleCount,
  onChange,
  onAnother,
}: {
  addr: AddrPower | null;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  eligibleCount: number;
  onChange: () => void;
  onAnother: () => void;
}) {
  return (
    <>
      <div className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        {t("gov.votedAddress")}
      </div>
      <div className="mb-5 flex items-center gap-3.5 rounded-lg border border-neutral-800 bg-neutral-950 px-3.5 py-3">
        <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-300">
          <IconWallet size={19} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[0.9rem] font-semibold text-neutral-100">
            {addr?.label}
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-px text-[0.64rem] font-semibold text-emerald-300">
              <IconCheck size={9} strokeWidth={3.2} />
              {t("gov.votedChip")}
            </span>
          </span>
          <span className="mono text-xs text-neutral-500">{addr?.short}</span>
        </span>
        <span className="mono text-[0.92rem] text-neutral-100">
          {addr ? fmtExfer(addr.power) : "0"}{" "}
          <small className="text-xs font-medium text-neutral-500">EXFER</small>
        </span>
      </div>

      {/* validity pill */}
      <div className="mb-4">
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300">
          <IconCheck size={16} strokeWidth={3} className="text-emerald-400" />
          {t("gov.voteValid")}
        </span>
      </div>

      <div className="flex gap-2.5">
        <button type="button" onClick={onChange} className="btn-secondary w-full">
          {t("gov.changeVote")}
        </button>
        <button type="button" onClick={onAnother} className="btn-secondary w-full">
          {t("gov.voteAnother")}
        </button>
      </div>
      <div className="mt-3.5 text-center text-xs leading-relaxed text-neutral-500">
        {eligibleCount > 1 ? t("gov.otherAddrHint") : t("gov.changeHint")}
      </div>
    </>
  );
}

// ── address selector (desktop dropdown) ─────────────────────────────────────

function AddressSelector({
  addrs,
  selected,
  minPower,
  open,
  setOpen,
  onPick,
  t,
}: {
  addrs: AddrPower[];
  selected: AddrPower | null;
  minPower: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  onPick: (a: AddrPower) => void;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          "flex w-full items-center gap-3.5 rounded-lg border bg-neutral-950 px-3.5 py-3 text-left transition hover:bg-[#0e0e0e] " +
          (open ? "border-cyan-500/50" : "border-neutral-800 hover:border-neutral-700")
        }
      >
        <span
          className={
            "flex h-[38px] w-[38px] flex-none items-center justify-center rounded-lg " +
            (selected?.eligible
              ? "bg-cyan-500/10 text-cyan-300"
              : "bg-neutral-900 text-neutral-500")
          }
        >
          <IconWallet size={19} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[0.9rem] font-semibold text-neutral-100">
            {selected?.label}
            {addrs.length > 1 && (
              <span className="rounded bg-cyan-500/10 px-1.5 py-px text-[0.66rem] font-medium text-cyan-300">
                {t("gov.switchable")}
              </span>
            )}
          </span>
          <span className="mono text-xs text-neutral-500">{selected?.short}</span>
        </span>
        <span
          className={
            "mono text-[0.9rem] " +
            (selected?.eligible ? "text-neutral-100" : "text-neutral-500")
          }
        >
          {selected ? fmtExfer(selected.power) : "0"}{" "}
          <small className="text-xs font-medium text-neutral-500">EXFER</small>
        </span>
        <span className="text-neutral-500">
          {open ? <IconChevUp size={18} /> : <IconChevDown size={18} />}
        </span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl">
          <div className="flex items-center justify-between border-b border-neutral-800 px-3.5 py-3">
            <h3 className="text-sm font-semibold text-neutral-100">{t("gov.pickAddress")}</h3>
            <span className="text-xs text-neutral-500">
              {t("gov.addressesInWallet", { n: addrs.length })}
            </span>
          </div>
          {addrs.map((a) => {
            const isSel = a.address === selected?.address;
            return (
              <button
                key={a.address}
                type="button"
                onClick={() => onPick(a)}
                className={
                  "flex w-full items-center gap-3.5 border-b border-neutral-800 px-3.5 py-3 text-left transition last:border-b-0 hover:bg-neutral-900 " +
                  (a.eligible ? "" : "opacity-60 ") +
                  (isSel ? "bg-cyan-500/[0.08]" : "")
                }
              >
                <span
                  className={
                    "flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg " +
                    (a.eligible
                      ? "bg-cyan-500/10 text-cyan-300"
                      : "bg-neutral-900 text-neutral-500")
                  }
                >
                  <IconWallet size={18} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[0.88rem] font-semibold text-neutral-100">
                    {a.label}
                    {a.voted && (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-px text-[0.64rem] font-semibold text-emerald-300">
                        <IconCheck size={9} strokeWidth={3.2} />
                        {t("gov.votedChip")}
                      </span>
                    )}
                    {!a.eligible && (
                      <span className="rounded bg-amber-500/[0.12] px-1.5 py-px text-[0.66rem] font-medium text-amber-300">
                        {t("gov.belowThreshold", { n: fmtExfer(minPower) })}
                      </span>
                    )}
                  </span>
                  <span className="mono text-xs text-neutral-500">{a.short}</span>
                </span>
                <span
                  className={
                    "mono text-[0.82rem] " +
                    (a.eligible ? "text-neutral-200" : "text-neutral-500")
                  }
                >
                  {fmtExfer(a.power)} <small className="text-xs text-neutral-500">EXFER</small>
                </span>
                <span className="flex w-5 flex-none items-center justify-center">
                  {isSel ? (
                    <IconCheck size={14} className="text-cyan-400" strokeWidth={3} />
                  ) : !a.eligible ? (
                    <IconLock size={14} className="text-neutral-600" />
                  ) : null}
                </span>
              </button>
            );
          })}
          <div className="flex items-center gap-2 border-t border-neutral-800 px-3.5 py-3 text-xs text-neutral-500">
            <IconInfo size={14} className="flex-none" />
            {t("gov.perAddressHint", { n: fmtExfer(minPower) })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── power card (right rail) ─────────────────────────────────────────────────

function PowerCard({
  label,
  power,
  voted,
  t,
}: {
  label: string;
  power: number;
  voted: boolean;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-cyan-500/25 bg-cyan-500/[0.06] p-3.5">
      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-lg bg-cyan-500/[0.14] text-cyan-300">
        <IconShieldCheck size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-neutral-400">
          {voted ? t("gov.votedPower", { label }) : t("gov.thisAddressPower", { label })}
        </span>
        <span className="mono mt-0.5 block text-2xl font-semibold leading-tight text-neutral-50">
          {fmtExfer(power)}{" "}
          <small className="text-sm font-medium text-neutral-500">EXFER</small>
        </span>
      </span>
    </div>
  );
}

// ── results rail ────────────────────────────────────────────────────────────

function ResultsRail({
  proposal,
  lang,
  t,
  results,
  resultsAt,
  pct,
  optVotesPower,
  myVote,
}: {
  proposal: Proposal;
  lang: Lang;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
  results: VoteResult | null;
  resultsAt: number;
  pct: (oid: string) => number;
  optVotesPower: (oid: string) => bigint;
  myVote: string | null;
}) {
  // Re-render the "x ago" line on a ticking clock.
  const [, force] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => force((v) => v + 1), 5000);
    return () => window.clearInterval(h);
  }, []);

  const finalized = results?.finalized ?? false;
  const totalVoters = results?.total_voters ?? 0;
  const agoSecs = Math.max(0, Math.floor((Date.now() - resultsAt) / 1000));

  // option ordering: winner first by power, but keep abstain (index 2) muted.
  const ordered = [...proposal.options].sort(
    (a, b) => Number(optVotesPower(b.id) - optVotesPower(a.id)),
  );
  const topId = ordered[0]?.id;
  const abstainId = proposal.options[2]?.id;

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          {finalized ? t("gov.resultsFinal") : t("gov.results")}
        </span>
        <span className="mono text-[0.7rem] text-neutral-500">
          {t("gov.resultsMeta", {
            votes: totalVoters.toLocaleString("en-US"),
            ago: finalized ? "" : fmtAgo(agoSecs, t),
          }).replace(/ · $/, "")}
        </span>
      </div>

      {proposal.options.map((o) => {
        const p = pct(o.id);
        const isWin = o.id === topId && p > 0;
        const isMuted = o.id === abstainId;
        const isYours = myVote === o.id;
        return (
          <div
            key={o.id}
            style={{ ["--pct" as string]: `${p}%` }}
            className={
              "relative mb-2.5 overflow-hidden rounded-lg bg-neutral-900 px-3.5 py-3 last:mb-0 " +
              (isWin ? "gov-res-win " : "") +
              (isMuted ? "gov-res-muted " : "")
            }
          >
            <span className="gov-res-fill" />
            <div className="relative flex items-center justify-between">
              <span
                className={
                  "flex items-center gap-2 text-sm font-semibold " +
                  (isWin ? "text-cyan-300" : "text-neutral-100")
                }
              >
                {pickText(o.label, lang)}
                {isYours && (
                  <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-px text-[0.62rem] font-semibold text-cyan-300">
                    <IconCheck size={9} strokeWidth={3.2} />
                    {t("gov.yourVote")}
                  </span>
                )}
              </span>
              <span
                className={
                  "mono text-[0.92rem] font-semibold " +
                  (isWin ? "text-cyan-300" : "text-neutral-100")
                }
              >
                {p}%
              </span>
            </div>
            <div className="mono relative mt-1 text-[0.72rem] text-neutral-500">
              {t("gov.optPower", {
                n: fmtExfer(optVotesPower(o.id)),
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ineligible gate (left column) ───────────────────────────────────────────

function IneligibleGate({
  selected,
  minPower,
  t,
}: {
  selected: AddrPower;
  minPower: number;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
}) {
  // Threshold figures come from THIS proposal's min_power (exfers), never a
  // hardcoded 50,000 — a proposal can set any threshold (e.g. 0.05 EXFER).
  const goalRaw = minPower / EXFER_UNIT;
  const nowRaw = selected.power / EXFER_UNIT;
  const pct = goalRaw > 0 ? Math.min(100, (nowRaw / goalRaw) * 100) : 0;
  const remaining = Math.max(0, minPower - selected.power);

  return (
    <div className="card mt-5 p-6">
      <div className="text-center">
        <span className="mx-auto mb-3.5 flex h-16 w-16 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
          <IconLock size={28} />
        </span>
        <h2 className="mb-2 text-lg font-semibold text-neutral-100">
          {t("gov.lockTitle", { n: fmtExfer(minPower) })}
        </h2>
        <p className="text-sm leading-relaxed text-neutral-400">
          {t("gov.lockBodySwitch", { label: selected.label })}
        </p>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="mono text-lg font-semibold text-neutral-100">
            {fmtExfer(selected.power)}{" "}
            <small className="text-[0.58em] font-medium text-neutral-500">EXFER</small>
          </span>
          <span className="mono text-sm text-neutral-500">
            {t("gov.threshold", { n: fmtExfer(minPower) })}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-300 to-amber-500 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2.5 text-sm text-neutral-400">
          {t("gov.needMore", { amount: fmtExfer(remaining) })}
        </div>
      </div>

      {/* spot-check reminder — the hold-or-void rule must be visible on the
          ineligible path too (the open-vote path carries gov.preVoteWarn). */}
      <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950 px-3.5 py-3 text-xs leading-relaxed text-neutral-400">
        <IconInfo size={14} className="mt-px flex-none text-neutral-500" />
        <span>{t("gov.ineligibleHint")}</span>
      </div>
    </div>
  );
}

// ── other-addresses card (ineligible right rail) ────────────────────────────

function OtherAddressesCard({
  addrs,
  selectedAddr,
  onPick,
  t,
}: {
  addrs: AddrPower[];
  selectedAddr: string | null;
  onPick: (a: AddrPower) => void;
  t: (k: MsgKey, v?: Record<string, string | number>) => string;
}) {
  // List all addresses EXCEPT the currently-selected (ineligible) one is shown
  // last with a "current" note, matching the mockup.
  const others = addrs.filter((a) => a.address !== selectedAddr);
  const current = addrs.find((a) => a.address === selectedAddr);
  const available = others.filter((a) => a.eligible).length;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3.5 py-3">
        <h3 className="text-sm font-semibold text-neutral-100">{t("gov.otherAddresses")}</h3>
        <span className="text-xs text-neutral-500">
          {t("gov.available", { n: available })}
        </span>
      </div>
      {others.map((a, i) => (
        <button
          key={a.address}
          type="button"
          disabled={!a.eligible}
          onClick={() => a.eligible && onPick(a)}
          className={
            "flex w-full items-center gap-3.5 border-b border-neutral-800 px-3.5 py-3 text-left transition " +
            (i === others.length - 1 && !current ? "border-b-0 " : "") +
            (a.eligible ? "hover:bg-neutral-900" : "cursor-not-allowed opacity-55")
          }
        >
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-300">
            <IconWallet size={18} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-[0.88rem] font-semibold text-neutral-100">
              {a.label}
              {a.eligible && (
                <span className="rounded bg-cyan-500/10 px-1.5 py-px text-[0.66rem] font-medium text-cyan-300">
                  {t("gov.eligible")}
                </span>
              )}
            </span>
            <span className="mono text-xs text-neutral-500">{a.short}</span>
          </span>
          <span className="mono text-[0.82rem] text-neutral-200">
            {fmtExfer(a.power)} <small className="text-xs text-neutral-500">EXFER</small>
          </span>
          <span className="flex w-5 flex-none items-center justify-center text-cyan-400">
            {a.eligible && <IconChevRight size={16} />}
          </span>
        </button>
      ))}
      {current && (
        <div className="flex w-full items-center gap-3.5 px-3.5 py-3 opacity-55">
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-neutral-900 text-neutral-500">
            <IconWallet size={18} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-[0.88rem] font-semibold text-neutral-100">
              {current.label}
              <span className="rounded bg-amber-500/[0.12] px-1.5 py-px text-[0.66rem] font-medium text-amber-300">
                {t("gov.current")}
              </span>
            </span>
            <span className="mono text-xs text-neutral-500">{current.short}</span>
          </span>
          <span className="mono text-[0.82rem] text-neutral-500">
            {fmtExfer(current.power)} <small className="text-xs text-neutral-500">EXFER</small>
          </span>
          <span className="flex w-5 flex-none items-center justify-center text-neutral-600">
            <IconLock size={14} />
          </span>
        </div>
      )}
    </div>
  );
}

// ── back button ─────────────────────────────────────────────────────────────

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-secondary mb-4 px-3 py-1.5 text-sm"
    >
      <IconBack size={15} />
      {label}
    </button>
  );
}
