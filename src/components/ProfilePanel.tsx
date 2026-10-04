/**
 * Profile.
 *
 * ── What is a memory and what is not ──────────────────────────────────────────
 * The name, the pronouns and the timezone are memories about you, in your own
 * account, readable and revokable alongside everything else you told it. Changing
 * one is a revision, not a new row, so the book shows what it used to call you.
 *
 * The picture is not, and deliberately so. An avatar is a few tens of kilobytes
 * and has no meaning to embed or recall, so storing it in the memory namespace
 * would add weight to the one thing you open the app for without gaining
 * anything. It stays in localStorage, which also means it is the one piece of
 * this screen that does not follow you to another device. That trade is
 * deliberate and it is the reason the field is small and quiet.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";

export interface Profile {
  name?: string;
  pronouns?: string;
  timezone?: string;
}

const AVATAR_KEY = "pb.profile.avatar.v1";

function readAvatar(): string | null {
  try {
    return localStorage.getItem(AVATAR_KEY);
  } catch {
    return null;
  }
}

/** Zones the browser knows, so the list is real rather than a guess at spelling. */
function knownZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = typeof supported === "function" ? supported("timeZone") : [];
  // Intl hands back IANA names. The two people actually care about are their own
  // zone and UTC, so those lead rather than making everyone scroll an alphabet.
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([here, "UTC", ...list].filter(Boolean))];
}

export function ProfilePanel() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraftRaw] = useState<Profile>({});
  // Any edit retires the "Saved." confirmation: it was true of what was there
  // before the keystroke, and leaving it up would claim the new text is saved too.
  const setDraft: typeof setDraftRaw = (update) => {
    setState((s) => (s === "saved" ? "idle" : s));
    setDraftRaw(update);
  };
  const [avatar, setAvatar] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ profile: Profile }>("/api/profile");
      setProfile(data.profile);
      setDraft(data.profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your profile.");
    }
  }, []);

  useEffect(() => {
    void load();
    setAvatar(readAvatar());
  }, [load]);

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      // Only changed fields are sent, so an untouched field is never rewritten
      // and never appears in the book's history as a change nobody made.
      const patch: Record<string, string> = {};
      for (const key of ["name", "pronouns", "timezone"] as const) {
        const next = (draft[key] ?? "").trim();
        if (next !== (profile?.[key] ?? "").trim()) patch[key] = next;
      }
      if (Object.keys(patch).length) {
        const data = await api.post<{ profile: Profile }>("/api/profile", patch);
        setProfile(data.profile);
      }
      setState("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
      setState("error");
    }
  };

  const onAvatar = (file: File | undefined) => {
    if (!file) return;
    // Downscaled before it is stored. A phone photo is several megabytes and this
    // is an avatar shown at 28px; keeping the original would be storing a large
    // file to render a small circle.
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const side = Math.min(image.width, image.height);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        try {
          localStorage.setItem(AVATAR_KEY, dataUrl);
          setAvatar(dataUrl);
        } catch {
          setError("That image is too large to store in this browser.");
        }
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  if (error && !profile) return <p className="text-sm text-stop">{error}</p>;
  if (!profile) return <p className="text-sm text-muted">Loading your profile…</p>;

  const field = "min-h-11 w-full rounded-lg bg-raised px-3 py-2 text-[13px] text-text outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-sm font-bold text-text">How it should address you</h2>
        <p className="mt-1.5 text-[12px] leading-6 text-faint">
          Kept in your own account as part of the book, not in a settings table. It
          can be changed or removed, and the history of what it used to call you is
          in <span className="text-muted">the book</span>.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full bg-raised">
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <Mark />
          )}
        </div>
        <div className="min-w-0">
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-panel px-3.5 py-2 text-[12.5px] text-text transition-colors hover:bg-raised">
            {avatar ? "Change picture" : "Add a picture"}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => onAvatar(e.target.files?.[0])}
            />
          </label>
          <p className="mt-1.5 text-[11px] text-faint">
            Stays in this browser only, and is shrunk to 128px. Not written to your
            account.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[12px] font-bold text-muted">Call you</span>
          <input
            className={`${field} mt-1.5`}
            value={draft.name ?? ""}
            placeholder="Mateo"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
        <label className="block">
          <span className="text-[12px] font-bold text-muted">Pronouns</span>
          <input
            className={`${field} mt-1.5`}
            value={draft.pronouns ?? ""}
            placeholder="he/him"
            onChange={(e) => setDraft((d) => ({ ...d, pronouns: e.target.value }))}
          />
        </label>
      </div>

      <label className="block">
        <span className="text-[12px] font-bold text-muted">Timezone</span>
        <select
          className={`${field} mt-1.5`}
          value={draft.timezone ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
        >
          <option value="">Not set</option>
          {knownZones().map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <span className="mt-1.5 block text-[11px] text-faint">
          Used when it works out what &ldquo;today&rdquo; means, so a birthday
          arrives on the right day rather than yours.
        </span>
      </label>

      {error && state === "error" && <p className="text-[12px] text-stop">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={state === "saving"}
          className="min-h-11 rounded-lg bg-accent px-5 py-3 text-[13px] font-bold text-base transition-colors hover:bg-accent/85 disabled:opacity-50"
        >
          {state === "saving" ? "Saving…" : "Save"}
        </button>
        {state === "saved" && <span className="text-[12px] text-muted">Saved.</span>}
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7cc0f5" aria-hidden="true">
      <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.5" fill="#7cc0f5" />
    </svg>
  );
}
