"use client";

import { useMemo, useState } from "react";

export type CustomerSearchOption = {
  id: string;
  full_name: string;
  phone: string | null;
};

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";

// Type-to-filter customer picker for the referrer field ("הופנתה על
// ידי"). Filters an already-loaded customer list entirely client-side
// rather than a debounced server search — this CRM's realistic scale
// (a single personal-training business) makes that the simplest robust
// choice, the same reasoning already applied to contact matching (see
// lib/crm/contact-matching.ts). Shows name + phone so customers who
// share a first name are still distinguishable, without exposing more
// than that.
export function CustomerSearchSelect({
  name,
  customers,
  required = false,
}: {
  name: string;
  customers: CustomerSearchOption[];
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const selected = customers.find((c) => c.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) return customers.slice(0, 20);
    return customers
      .filter(
        (c) =>
          c.full_name.includes(q) || (c.phone ?? "").includes(q)
      )
      .slice(0, 20);
  }, [customers, query]);

  return (
    <div className="relative">
      <input type="hidden" name={name} value={selectedId ?? ""} />
      <input
        type="text"
        value={selected ? selected.full_name : query}
        onChange={(e) => {
          setSelectedId(null);
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        required={required && !selectedId}
        placeholder="חיפוש לפי שם או טלפון…"
        className={inputClass}
        autoComplete="off"
      />

      {open && (
        <>
          <button
            type="button"
            aria-label="סגירה"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            className="absolute end-0 start-0 z-50 mt-1.5 max-h-56 overflow-y-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
          >
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-400">
                לא נמצאה לקוחה מתאימה.
              </p>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === selectedId}
                  onClick={() => {
                    setSelectedId(c.id);
                    setQuery("");
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  <span className="truncate">{c.full_name}</span>
                  {c.phone && (
                    <span dir="ltr" className="shrink-0 text-xs text-zinc-400">
                      {c.phone}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
