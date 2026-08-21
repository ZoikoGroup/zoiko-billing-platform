import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, CornerDownLeft } from "lucide-react";
import { createPortal } from "react-dom";
import { globalSearch } from "../service/commandCenterService";

/**
 * ZB-SA-CMD-003 §13/§14 — keyboard-accessible, permission-aware command
 * palette. Opens with Ctrl/Cmd+K on any /super-admin/* route (super_admin
 * only — see BillingShell, which only mounts this for that role). Every
 * result comes from the real, authorization-gated /api/super-admin/search
 * endpoint; there is no client-side fixture data and no static command
 * list pretending to be search results. Static navigation shortcuts are
 * intentionally limited to safe, read-only destinations — no shortcut here
 * performs a mutation directly (that would violate "high-risk commands
 * always open a controlled confirmation workflow").
 */

const STATIC_COMMANDS = [
  { label: "Open Attention queue", route: "/super-admin/governance", domain: "governance" },
  { label: "Open Approval Center", route: "/super-admin/approval-queue", domain: "governance" },
  { label: "Request tenant support access", route: "/super-admin/support-access", domain: "governance" },
  { label: "Open Reliability overview", route: "/super-admin/reliability", domain: "platform" },
  { label: "Open Tenant Health", route: "/super-admin/tenant-health", domain: "platform" },
  { label: "Open Audit Logs", route: "/super-admin/audit-logs", domain: "governance" },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      globalSearch(query)
        .then((res) => setResults(res.results || []))
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);

  const staticMatches = query.trim()
    ? STATIC_COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : STATIC_COMMANDS;

  const items = [
    ...staticMatches.map((c) => ({ kind: "command", ...c })),
    ...results.map((r) => ({ kind: "result", ...r })),
  ];

  function go(item) {
    setOpen(false);
    navigate(item.route);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[activeIndex]) {
      e.preventDefault();
      go(items[activeIndex]);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-slate-900/50 pt-24 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Search size={16} className="text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search organizations, attention items, audit events, correlation IDs…"
            aria-label="Command palette search"
            className="flex-1 border-none text-sm outline-none placeholder:text-slate-500"
          />
          <kbd className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-2" role="listbox">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-500">No matches.</p>
          ) : (
            items.map((item, idx) => (
              <button
                key={`${item.kind}-${item.route}-${item.id || item.label}`}
                type="button"
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => go(item)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm ${
                  idx === activeIndex ? "bg-brand-50 text-brand-700" : "text-slate-700"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {item.kind === "result" && (
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">
                      {item.entity_type}
                    </span>
                  )}
                  <span className="truncate">{item.label}</span>
                </span>
                {idx === activeIndex && <CornerDownLeft size={13} className="shrink-0 text-slate-500" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
