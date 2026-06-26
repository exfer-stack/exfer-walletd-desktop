// Multi-conversation store for the agent chat. One agent session is live at a
// time, but the user can keep several conversations side by side and switch
// between them. Each conversation is a persisted transcript (the same Turn shape
// the chat reducer streams into); the live AgentSession is seeded from the
// active conversation's messages and its snapshot is flushed back here on every
// turn boundary.
//
// Storage is a single localStorage blob (id-keyed map + an order list + the
// active id). The blob is intentionally small: we trim each conversation's
// history to the last TRIM_MESSAGES turns before persisting, so a long-running
// chat can't grow the quota without bound (the same invariant the headless core
// applies to the LLM context window — see trimHistory).
//
// This file is duplicated verbatim (idiom + storage key suffix aside) in the
// mobile app; keep the two in sync.

export interface ConvMessage {
  role: "user" | "assistant";
  text?: string;
  thinking?: string;
  // Opaque block list — the chat owns the Block union; the store only persists
  // and replays it, so we keep it untyped here to avoid coupling the store to
  // the view's reducer shape.
  blocks: unknown[];
}

export interface Conversation {
  id: string;
  title: string | null; // null until the first user message auto-titles it
  createdAt: number;
  updatedAt: number;
  messages: ConvMessage[];
}

interface StoreShape {
  order: string[]; // most-recently-updated first
  active: string | null;
  byId: Record<string, Conversation>;
}

const STORE_KEY = "exfer-walletd-desktop-agent-conversations-v1";
// Cap a persisted transcript so the localStorage blob stays bounded. We keep the
// last N messages (a message = one user OR one assistant turn); older turns drop
// out of both the persisted store and the seeded LLM context.
const TRIM_MESSAGES = 60;
// Hard cap on how many conversations we keep; oldest (by updatedAt) are evicted.
const MAX_CONVERSATIONS = 50;

function newId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Keep only the last TRIM_MESSAGES turns. Pure: returns a (possibly new) array.
 *  Mirrors the headless core's context-window trim so the seeded session and the
 *  persisted transcript never diverge. */
export function trimHistory(messages: ConvMessage[]): ConvMessage[] {
  return messages.length > TRIM_MESSAGES ? messages.slice(messages.length - TRIM_MESSAGES) : messages;
}

function emptyStore(): StoreShape {
  return { order: [], active: null, byId: {} };
}

function load(): StoreShape {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const v = JSON.parse(raw) as Partial<StoreShape>;
    if (!v || typeof v !== "object" || !v.byId) return emptyStore();
    return {
      order: Array.isArray(v.order) ? v.order.filter((id) => typeof id === "string") : [],
      active: typeof v.active === "string" ? v.active : null,
      byId: v.byId,
    };
  } catch {
    return emptyStore();
  }
}

function persist(s: StoreShape): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode: the in-memory state still works for this session */
  }
}

/** Derive a short title from the first user message. */
export function deriveTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean || "";
}

/** The full list, most-recently-updated first, with the active id. Conversations
 *  are returned in `order`; any id present in byId but missing from order is
 *  appended (defensive against a torn write). */
export function listConversations(): { conversations: Conversation[]; activeId: string | null } {
  const s = load();
  const seen = new Set<string>();
  const out: Conversation[] = [];
  for (const id of s.order) {
    const c = s.byId[id];
    if (c && !seen.has(id)) {
      out.push(c);
      seen.add(id);
    }
  }
  for (const [id, c] of Object.entries(s.byId)) {
    if (!seen.has(id)) out.push(c);
  }
  return { conversations: out, activeId: s.active };
}

/** Create a fresh conversation, make it active, and return it. */
export function createConversation(): Conversation {
  const s = load();
  const now = Date.now();
  const conv: Conversation = { id: newId(), title: null, createdAt: now, updatedAt: now, messages: [] };
  s.byId[conv.id] = conv;
  s.order = [conv.id, ...s.order.filter((id) => id !== conv.id)];
  s.active = conv.id;
  evict(s);
  persist(s);
  return conv;
}

/** Ensure there is at least one conversation and an active id; returns the active
 *  conversation (creating one on first run). Idempotent. */
export function ensureActive(): Conversation {
  const s = load();
  const active = s.active ? s.byId[s.active] : undefined;
  if (active) return active;
  // Adopt the most-recent existing conversation, or create one.
  const first = s.order.map((id) => s.byId[id]).find(Boolean);
  if (first) {
    s.active = first.id;
    persist(s);
    return first;
  }
  return createConversation();
}

export function getConversation(id: string): Conversation | undefined {
  return load().byId[id];
}

export function setActive(id: string): void {
  const s = load();
  if (!s.byId[id]) return;
  s.active = id;
  persist(s);
}

/** Replace a conversation's transcript (trimmed) and bump updatedAt. Auto-titles
 *  from the first user message if still untitled. */
export function saveMessages(id: string, messages: ConvMessage[]): void {
  const s = load();
  const conv = s.byId[id];
  if (!conv) return;
  const trimmed = trimHistory(messages);
  const firstUser = trimmed.find((m) => m.role === "user" && m.text);
  conv.messages = trimmed;
  conv.updatedAt = Date.now();
  if (conv.title == null && firstUser?.text) conv.title = deriveTitle(firstUser.text);
  // Move to the front of the order (most-recently-updated first).
  s.order = [id, ...s.order.filter((x) => x !== id)];
  persist(s);
}

export function renameConversation(id: string, title: string): void {
  const s = load();
  const conv = s.byId[id];
  if (!conv) return;
  const trimmed = title.trim();
  conv.title = trimmed === "" ? null : trimmed.length > 60 ? trimmed.slice(0, 60) : trimmed;
  conv.updatedAt = Date.now();
  persist(s);
}

/** Delete a conversation. If it was active, the next-most-recent becomes active
 *  (or a fresh one is created so the chat is never left without a conversation).
 *  Returns the new active id. */
export function deleteConversation(id: string): string {
  const s = load();
  if (!s.byId[id]) return s.active ?? ensureActive().id;
  delete s.byId[id];
  s.order = s.order.filter((x) => x !== id);
  if (s.active === id) s.active = s.order[0] ?? null;
  persist(s);
  if (!s.active) return createConversation().id;
  return s.active;
}

/** Evict the oldest conversations past MAX_CONVERSATIONS (never the active one). */
function evict(s: StoreShape): void {
  const ids = Object.keys(s.byId);
  if (ids.length <= MAX_CONVERSATIONS) return;
  const sorted = ids
    .map((id) => s.byId[id])
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const c of sorted.slice(MAX_CONVERSATIONS)) {
    if (c.id === s.active) continue;
    delete s.byId[c.id];
    s.order = s.order.filter((x) => x !== c.id);
  }
}
