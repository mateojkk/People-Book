/**
 * Three things, only one of which is a destination.
 *
 * "talk" is where you live. "today" is reached from the notification and "book"
 * from a citation or the quiet link at the bottom -- both are receipts behind the
 * conversation, not peers of it. Three tabs side by side is how a chatbot
 * becomes a to-do app with a chat window.
 */
type Tab = "talk" | "notifications" | "book";

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
    /* Contained to the same measure as the conversation, so the sentence and its
       "Open" stay together. Stretched across a wide screen they read as two
       unrelated things 1200 pixels apart. */
    <button
      onClick={onOpen}
      className="group w-full shrink-0 border-b border-rule bg-raised px-5 py-2.5 text-left transition-colors hover:bg-panel"
    >
      <span className="mx-auto flex w-full max-w-thread items-center gap-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <p className="flex-1 text-[12.5px] leading-5 text-text">{notice}</p>
        <span className="shrink-0 whitespace-nowrap text-[11.5px] text-faint transition-colors group-hover:text-muted">
          Open
        </span>
      </span>
    </button>
  );
}

import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView.tsx";
import { NudgeView } from "../components/NudgeView.tsx";
import { NotificationsView } from "../components/NotificationsView.tsx";
import { LedgerView } from "../components/LedgerView.tsx";
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
  error,
  modelReady,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  address?: string;
  version: number;
  onForget: (id: string) => void;
  error?: string | null;
  modelReady: boolean | null;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <aside
        className={`hidden shrink-0 flex-col overflow-hidden border-r border-rule bg-base transition-all duration-200 lg:flex ${
          sidebarCollapsed ? "w-14 items-center" : "w-60"
        }`}
      >
        <div className={`flex items-center gap-2 py-3.5 ${sidebarCollapsed ? "justify-center px-2" : "px-4"}`}>
          <Mark />
          {!sidebarCollapsed && <span className="text-[15px] font-semibold tracking-tight">People Book</span>}
        </div>

        <nav className={`flex flex-col gap-0.5 ${sidebarCollapsed ? "w-full px-2" : "px-2"}`}>
          <button
            onClick={() => setTab("talk")}
            aria-current={tab === "talk"}
            title={sidebarCollapsed ? "Talk to it" : undefined}
            aria-label="Talk to it"
            className={`rail-item flex w-full items-center gap-2.5 py-2 text-left text-[13px] text-quiet ${
              sidebarCollapsed ? "justify-center px-0" : "px-2.5"
            }`}
          >
            <Icon name="talk" />
            {!sidebarCollapsed && <span>Talk to it</span>}
          </button>
          <button
            onClick={() => setTab("notifications")}
            aria-current={tab === "notifications"}
            title={sidebarCollapsed ? "Notifications" : undefined}
            aria-label="Notifications"
            className={`rail-item flex w-full items-center gap-2.5 py-2 text-left text-[13px] text-quiet ${
              sidebarCollapsed ? "justify-center px-0" : "px-2.5"
            }`}
          >
            <Icon name="notifications" />
            {!sidebarCollapsed && <span>Notifications</span>}
          </button>
          <button
            onClick={() => setTab("book")}
            aria-current={tab === "book"}
            title={sidebarCollapsed ? "the book" : undefined}
            aria-label="the book"
            className={`rail-item flex w-full items-center gap-2.5 py-2 text-left text-[12.5px] text-faint ${
              sidebarCollapsed ? "justify-center px-0" : "px-2.5"
            }`}
          >
            <BookmarkIcon className="h-[15px] w-[15px]" />
            {!sidebarCollapsed && <span>the book</span>}
          </button>
        </nav>

        <div className="mt-auto">
          {!sidebarCollapsed && (
            <div className="px-4 py-2.5">
              <p className="mono truncate text-[11px] text-faint">
                {address?.slice(0, 6)}…{address?.slice(-4)}
              </p>
              <p className="mt-1 text-[11px] text-faint">Yours, on Sui</p>
            </div>
          )}
          <div
            className={`flex border-t border-rule px-2 py-2 ${
              sidebarCollapsed ? "justify-center" : "items-center justify-between px-3"
            }`}
          >
            {sidebarCollapsed ? (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-text"
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <SidebarToggleIcon className="h-4 w-4" />
              </button>
            ) : (
              <>
                <span className="text-[11px] text-faint">Collapse</span>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-text"
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
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

        {tab === "talk" && <Notice onOpen={() => setTab("notifications")} />}
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
          {tab === "talk" && <ChatView onOpenBook={() => setTab("book")} />}
          {tab !== "talk" && (
            <div className="h-full overflow-y-auto px-5 py-8">
              <div className="mx-auto w-full max-w-thread">
                {tab === "notifications" && <NotificationsView key={version} />}
                {tab === "book" && (
                  <div>
                    <button
                      onClick={() => setTab("talk")}
                      className="mb-3 text-[11.5px] text-faint transition-colors hover:text-muted"
                    >
                      ← Back to talking
                    </button>
                    <LedgerView key={version} onForget={onForget} />
                  </div>
                )}
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


/**
 * The bookmark, from AnimateIcons (MIT, Avijit Dey). Taken as the path rather
 * than the animated component: the animation pulls in `motion` for one glyph, and
 * a dependency has to earn itself. Say the word and it gets the hover.
 */
export function BookmarkIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 17.9808V9.70753C4 6.07416 4 4.25748 5.17157 3.12874C6.34315 2 8.22876 2 12 2C15.7712 2 17.6569 2 18.8284 3.12874C20 4.25748 20 6.07416 20 9.70753V17.9808C20 20.2867 20 21.4396 19.2272 21.8523C17.7305 22.6514 14.9232 19.9852 13.59 19.1824C12.8168 18.7168 12.4302 18.484 12 18.484C11.5698 18.484 11.1832 18.7168 10.41 19.1824C9.0768 19.9852 6.26947 22.6514 4.77285 21.8523C4 21.4396 4 20.2867 4 17.9808Z" />
    </svg>
  );
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    new: "M8 3.5v9M3.5 8h9",
    talk: "M3 5.5A1.5 1.5 0 0 1 4.5 4h7A1.5 1.5 0 0 1 13 5.5v4a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h-.5A1.5 1.5 0 0 1 3 9.5v-4Z",
    notifications: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
    book: "M3 3.5h10v9H3v-9Zm0 2.5h10M6 9h4",

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
