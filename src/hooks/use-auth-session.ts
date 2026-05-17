import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type AuthState = {
  session: Session | null;
  loading: boolean;
};

let cached: AuthState = { session: null, loading: true };
const listeners = new Set<(s: AuthState) => void>();
let initialized = false;

function setState(next: AuthState) {
  cached = next;
  listeners.forEach((l) => l(next));
}

function init() {
  if (initialized) return;
  initialized = true;
  // 先订阅，再 getSession（避免漏掉初始事件）
  supabase.auth.onAuthStateChange((_event, session) => {
    setState({ session, loading: false });
  });
  supabase.auth.getSession().then(({ data }) => {
    setState({ session: data.session, loading: false });
  });
}

export function useAuthSession(): AuthState {
  const [state, setLocal] = useState<AuthState>(cached);
  useEffect(() => {
    init();
    setLocal(cached);
    const l = (s: AuthState) => setLocal(s);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}
