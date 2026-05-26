import { useCallback, useEffect, useState } from "react";

export type ParcelViewMode = "parcel" | "item";

const KEY = "jp-parcel-view-mode";
const EVENT = "jp-parcel-view-mode-change";
const DEFAULT: ParcelViewMode = "item";

export function useParcelViewMode(): [ParcelViewMode, (v: ParcelViewMode) => void] {
  const [value, setValue] = useState<ParcelViewMode>(DEFAULT);

  useEffect(() => {
    const v = window.localStorage.getItem(KEY);
    if (v === "parcel" || v === "item") setValue(v);

    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && (e.newValue === "parcel" || e.newValue === "item")) {
        setValue(e.newValue);
      }
    };
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent<ParcelViewMode>).detail;
      if (detail === "parcel" || detail === "item") setValue(detail);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT, onLocal as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT, onLocal as EventListener);
    };
  }, []);

  const set = useCallback((v: ParcelViewMode) => {
    setValue(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(KEY, v);
      window.dispatchEvent(new CustomEvent(EVENT, { detail: v }));
    }
  }, []);

  return [value, set];
}
