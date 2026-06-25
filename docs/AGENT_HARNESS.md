# exfer wallet agent harness — build blueprint

**Status:** Draft / starting. **Target:** an in-wallet AI agent for ordinary users
(no CLI). The agent earns and spends EXFER on the user's behalf, inside the app
they already have, with every value-moving step gated behind explicit user
consent. Pattern borrowed from Codex's agent loop UX (streamed thinking, inline
tool-call cards, an approval gate) — here the "approval" is biometric / passphrase.

## 1. What it is

A conversational agent embedded in the wallet (desktop first, then mobile). The
user talks to it in natural language ("earn me some EXFER while I'm idle", "pay
alice 5 EXFER for that summary", "what can I swap 0.1 BNB for"). The agent plans,
calls exfer tools, and acts — but any tool that **moves funds or signs a
value-bearing credential pauses for the user to approve** (Face/Touch ID on
mobile, passphrase/OS-auth on desktop). Read-only tools run silently.

This is the consumer-facing product. The CLI settlement loop / public arena page
is the proof-and-marketing artifact; this is where ordinary users actually
participate.

## 2. Architecture (desktop-first, Tauri 2)

```
┌─ Tauri app (exfer-walletd-desktop) ───────────────────────────────┐
│                                                                   │
│  React UI (src/)                     Rust backend (src-tauri/)     │
│  ┌─ Agent chat panel ──────┐         ┌─ walletd_supervisor.rs ─┐   │
│  │ • message stream        │  Tauri  │   (already supervises    │   │
│  │ • thinking stream       │ ◀─cmd─▶ │    walletd)              │   │
│  │ • tool-call cards       │ events  ├─ mcp_supervisor.rs (NEW) ┤   │
│  │ • approval (biometric)  │         │   supervises exfer-mcp    │   │
│  └─────────────────────────┘         ├─ agent_loop.rs   (NEW)    ┤   │
│                                       │   LLM ⇄ tools ⇄ consent  │   │
│                                       └─ rpc_client.rs (walletd) ┘   │
└───────────────────────────────────────────────────────────────────┘
            │                                   │
            ▼                                   ▼
     LLM API (Claude)                    exfer-mcp (Python sidecar)
                                          → walletd → node / indexer
```

- **Agent loop lives in the Rust backend** (`src-tauri/src/agent_loop.rs`): owns the
  LLM client, the tool registry, and the consent gate. Reuses the existing
  walletd supervisor + rpc_client. The exfer-mcp Python server is supervised as a
  second sidecar (like walletd already is), and the loop speaks MCP to it — so we
  reuse the 35 tools as-is rather than reimplementing them.
- **UI is a thin renderer**: it receives a stream of typed events from the loop
  (Tauri events) and renders them; it sends user messages and approval results
  back as Tauri commands.
- **Mobile (later):** same React UI + agent loop; the exfer-mcp Python sidecar is
  the hard part on iOS — options: ship a hosted MCP endpoint, or reimplement the
  tool layer natively over walletd RPC. Decide at the mobile milestone, not now.

## 3. The loop and its event protocol

One turn: user message → LLM (streamed) → 0+ tool calls (each consent-checked) →
assistant message. The loop emits these typed events to the UI (mirrors Codex):

| event | UI renders |
|---|---|
| `thinking_delta {text}` | streamed reasoning (collapsible, dimmed) |
| `message_delta {text}` | the assistant's natural-language reply |
| `tool_call_start {id, name, args}` | a tool-call card (name + human-readable args) + spinner |
| `tool_approval_request {id, name, summary, amount?, payee?, fee?}` | **the consent card** — blocks until the user approves/declines |
| `tool_result {id, ok, summary}` | fill the card with the result (collapsible detail) |
| `turn_done` | re-enable input |

UI → loop commands: `send_message {text}`, `approve {id, credential}`,
`decline {id}`, `cancel_turn`.

## 4. Tool surface + consent classification

The 35 exfer-mcp tools split into three consent classes. The loop enforces this
table; the LLM never moves money without passing through it.

**🟢 AUTO (read-only — run silently, no prompt):**
`exfer_get_balance`, `exfer_get_block_height`, `exfer_list_addresses`,
`exfer_generate_address`, `exfer_get_address_history`, `exfer_get_output_datum`,
`exfer_find_settlements_by_quote_id`, `exfer_simulate_transfer`,
`exfer_quote_verify`, `exfer_swap_pool_info`, `exfer_swap_get_quote`,
`exfer_swap_status`, `exfer_swap_list`, `exfer_htlc_status`, `exfer_htlc_list`,
`exfer_wait_for_tx`, `exfer_wait_for_payment`, `exfer_payment_uri_encode`,
`exfer_payment_uri_decode`, `exfer_verify_message`, `exfer_bsc_get_address`,
`exfer_bsc_get_balance`, `exfer_check_update`.

**🔴 CONSENT-GATED (moves funds / signs a value credential — biometric):**
| tool | confirmation card shows |
|---|---|
| `exfer_transfer` | amount, recipient, fee, resulting balance |
| `exfer_swap_execute` | direction, amount_in, quoted amount_out, fee_bps, network_fee_bnb, expiry |
| `exfer_htlc_lock` | locked amount, counterparty, timeout height |
| `exfer_htlc_claim` / `exfer_htlc_reclaim` | which HTLC, amount recovered |
| `exfer_quote_issue` | it signs a value-bearing price credential (Spend scope) — show amount + payee + expiry |
| `exfer_sign_message` | what is being signed (proof of ownership) |
| `exfer_swap_refund` | which swap, refund amount |

Note: exfer-mcp's `exfer_swap_execute` says *"No per-call human approval; bound
your float"* — that posture is for autonomous agents. In a consumer wallet we
**override it** with the consent gate above. The gate lives in the harness, not
the MCP.

**🟡 EARN (mining — confirm once to start, then background):**
`exfer_earn` (start), `exfer_earn_probe`, `exfer_earn_status`, `exfer_earn_stop`.
Starting confirmation explains: uses CPU/battery, pays out to address X. After
that it runs in the background with a status chip; no per-block prompts.

## 5. Consent flow (the gate)

```
LLM emits tool_call(exfer_transfer, {to, amount, fee})
        │
   class = CONSENT-GATED?
        │ yes
        ▼
   loop emits tool_approval_request  ──▶ UI shows confirmation card
        │                                     │ user reviews amount/payee/fee
        │              ◀── approve {credential} / decline ──┘
   verify credential (biometric on mobile / passphrase / OS-auth on desktop)
        │ ok                         │ declined / failed
        ▼                            ▼
   call exfer-mcp tool          return "user declined" to the LLM
        │                       (the agent re-plans or stops)
        ▼
   tool_result → UI
```

- **Credential per platform:** mobile = Face/Touch ID (Tauri biometric plugin);
  desktop = the wallet passphrase or OS auth. The loop's interface is uniform
  (`approve {credential}`); the verification implementation is per-platform.
- **walletd scopes back the gate in depth:** the harness holds a `Spend`-scoped
  walletd token but only invokes spend tools after the consent step. A per-day /
  per-task budget (user-set) caps cumulative autonomous spend; crossing it forces
  re-consent even within an approved task.
- **A declined tool is not an error** — it is returned to the LLM as a normal
  result ("user declined") so the agent adapts, exactly like Codex handling a
  rejected command.

## 6. UX (borrowed from Codex)

Three primitives, all already in Codex's loop, retargeted to a wallet:

1. **Streamed thinking** — show the agent reasoning, dimmed/collapsible, so the
   user sees *why* it's about to pay before it asks. Trust comes from visibility.
2. **Tool-call cards** — every action is a card (name + plain-language args +
   result), not hidden. "Checked pool price → 1 BNB ≈ 1,240 EXFER" reads as a
   step, not magic.
3. **Approval card** — the consent gate is a first-class card: big, clear
   amount/payee/fee, approve/decline, biometric. This is the single most
   important screen in the app.

## 7. LLM location — the one architectural fork (recommend v1 = user key)

The loop needs an LLM. Three options:
- **v1 — user-provided key (recommend):** user pastes an Anthropic key in
  settings. Zero cost to us, fastest to ship, lets us dogfood immediately.
  Default model: Claude Sonnet 4.6 (fast + capable); Haiku 4.5 for cheap
  read-only planning.
- **v2 — hosted proxy:** we run an LLM proxy so end users need no key (freemium /
  metered). This is the consumer productization; it is itself an exfer-402 use
  case (the wallet pays per inference) — nice symmetry, do later.
- **on-device:** research project; out of scope for now.

Everything else in this doc is independent of which we pick.

## 8. Phased plan

- **P1 — desktop dogfood (now).** Agent chat panel + loop + exfer-mcp sidecar +
  consent gate (passphrase on desktop). v1 LLM = user key. One self-contained
  capability to prove it end to end: **earn (mining) + natural-language wallet
  ops (balance / transfer / swap quote+execute)**, each spend behind consent.
- **P2 — mobile.** Port the UI + loop; solve the exfer-mcp-on-iOS question;
  biometric consent.
- **P3 — autonomous services.** The agent buys services from other agents
  (quote → pay with quote_id-in-datum → honor) — needs the services ecosystem +
  the budget/safety model matured. This is where it becomes the agent economy.

## 9. Open forks (decide before P1 code)

1. LLM location for v1 — recommend **user key** (above).
2. exfer-mcp sidecar vs thin native tool layer over walletd RPC — recommend
   **sidecar on desktop** (reuse the 35 tools), revisit at mobile.
3. Where the agent loop lives — recommend **Rust backend** (`src-tauri`), reusing
   the walletd supervisor + rpc_client; UI stays a thin renderer.
