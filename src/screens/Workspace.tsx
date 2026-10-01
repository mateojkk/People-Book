type Tab = "talk" | "today" | "book" | "add";

/**
 * The notification.
 *
 * It reaches you rather than waiting to be found, which is the whole difference
 * between a reminder and a database. Deliberately a count and not a list: a
 * banner carrying four tasks is a list nobody reads, and a badge of fourteen
 * teaches people to ignore badges.
 */
function Notice({ onOpen }: { onOpen: () => void }) {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/today", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { notice?: string } | null) => {
        if (!cancelled && body?.notice) setNotice(body.notice);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to say is the normal state, and it should say nothing at all.
  if (!notice) return null;

  return (
    <button
      onClick={onOpen}
      className="group flex w-full shrink-0 items-center gap-3 border-b border-rule bg-raised px-5 py-2.5 text-left transition-colors hover:bg-panel"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <p className="flex-1 text-[12.5px] leading-5 text-text">{notice}</p>
      <span className="shrink-0 text-[11.5px] text-faint transition-colors group-hover:text-muted">
        Open
      </span>
    </button>
  );
}

import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView.tsx";
import { NudgeView } from "../components/NudgeView.tsx";
import { TodayView } from "../components/TodayView.tsx";
import { LedgerView } from "../components/LedgerView.tsx";
import { AddView } from "../components/AddView.tsx";
import { ErrorNote } from "../components/bits.tsx";
import { Mark } from "./Landing.tsx";

/**
 * The signed-in shell: a rail, and one centred column.
 *
 * Split out from App so that routing and authentication are the only things
 * App decides. The conversation is the product, so the column belongs to it; the
 * other views are the same data seen from another angle and live in the rail
 * rather than competing for the space.
 */
export function Workspace({
  tab,
  setTab,
  address,
  version,
  onForget,
  onSaved,
  error,
  modelReady,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  address?: string;
  version: number;
  onForget: (id: string) => void;
  onSaved: () => void;
  error?: string | null;
  modelReady: boolean | null;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <aside
        className={`hidden shrink-0 flex-col border-r border-rule bg-base transition-all duration-200 lg:flex ${
          sidebarCollapsed ? "w-14 items-center" : "w-60"
        }`}
      >
        <div className={`flex items-center gap-2 py-3.5 ${sidebarCollapsed ? "justify-center px-2" : "px-4"}`}>
          <Mark />
          {!sidebarCollapsed && <span className="text-[15px] font-semibold tracking-tight">People Book</span>}
        </div>

        <div className={`pb-2 ${sidebarCollapsed ? "w-full px-2" : "px-3"}`}>
          <button
            onClick={() => setTab("talk")}
            title="Start over"
            className={`flex items-center gap-2.5 rounded-xl border border-rule bg-base text-left text-[13.5px] text-muted transition-colors hover:bg-panel ${
              sidebarCollapsed ? "h-9 w-9 justify-center p-0" : "w-full px-3 py-2"
            }`}
          >
            <Icon name="new" />
            {!sidebarCollapsed && <span>Start over</span>}
          </button>
        </div>

        <nav className={`space-y-0.5 ${sidebarCollapsed ? "w-full px-2" : "px-2"}`}>
          {(
            [
              ["talk", "Talk to it"],
              ["book", "Your book"],
              ["add", "Write one in"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key}
              title={sidebarCollapsed ? label : undefined}
              className={`rail-item flex items-center text-muted transition-colors ${
                sidebarCollapsed
                  ? "h-9 w-9 justify-center rounded-lg p-0"
                  : "w-full gap-2.5 px-2.5 py-2 text-left text-[13.5px]"
              }`}
            >
              <Icon name={key} />
              {!sidebarCollapsed && <span>{label}</span>}
            </button>
          ))}
        </nav>

        <div className="mt-auto flex w-full flex-col border-t border-rule">
          {!sidebarCollapsed && (
            <div className="px-4 py-3">
              <p className="mono truncate text-[11px] text-faint">
                {address?.slice(0, 6)}…{address?.slice(-4)}
              </p>
              <p className="mt-1 text-[11px] text-faint">Yours, on Sui</p>
            </div>
          )}

          {/* Sidebar collapse/expand toggle button matching inspiration */}
          <div className={`p-2 flex ${sidebarCollapsed ? "justify-center" : "justify-between items-center px-3"}`}>
            {sidebarCollapsed ? (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-panel hover:text-text"
                title="Expand sidebar"
              >
                <SidebarToggleIcon className="h-4 w-4" />
              </button>
            ) : (
              <>
                <span className="text-[11px] text-faint">Collapse</span>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-panel hover:text-text"
                  title="Collapse sidebar"
                >
                  <SidebarToggleIcon className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule-soft px-5 py-3 lg:hidden">
          <div className="flex items-center gap-2">
            <Mark />
            <span className="text-[14px] font-semibold">People Book</span>
          </div>
        </header>

        {tab === "talk" && <Notice onOpen={() => setTab("today")} />}
        {modelReady === false && (
          <div className="border-b border-rule bg-warn/10 px-5 py-2.5">
            <p className="text-[13px] leading-5 text-warn">
              <strong className="font-medium">Nothing will be remembered.</strong> GROQ_API_KEY is
              not set, so it has no model to think with and replies are placeholders. Set it, restart.
            </p>
          </div>
        )}

        {error && (
          <div className="px-5 pt-4">
            <ErrorNote message={error} />
          </div>
        )}

        <main className="min-h-0 flex-1">
          {tab === "talk" && <ChatView />}
          {tab !== "talk" && (
            <div className="h-full overflow-y-auto px-5 py-8">
              <div className="mx-auto w-full max-w-thread">
                {tab === "today" && <TodayView key={version} onForget={onForget} />}
                {tab === "book" && <LedgerView key={version} onForget={onForget} />}
                {tab === "add" && <AddView onSaved={onSaved} />}
              </div>
            </div>
          )}
        </main>

      </div>
    </div>
  );
}


function SidebarToggleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2" y="2.5" width="12" height="11" rx="2" strokeWidth="1.3" />
      <path d="M6 2.5v11" strokeWidth="1.3" />
    </svg>
  );
}


function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    new: "M8 3.5v9M3.5 8h9",
    talk: "M3 5.5A1.5 1.5 0 0 1 4.5 4h7A1.5 1.5 0 0 1 13 5.5v4a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h-.5A1.5 1.5 0 0 1 3 9.5v-4Z",
    today: "M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2.1 2.1M9.7 9.7l2.1 2.1M11.8 4.2l-2.1 2.1M6.3 9.7l-2.1 2.1",
    book: "M3 3.5h10v9H3v-9Zm0 2.5h10M6 9h4",
    add: "M8 3.5v9M3.5 8h9",
  };
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-80" aria-hidden="true">
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type IconName = Tab | "new";
