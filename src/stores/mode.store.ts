import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TradingMode = "sandbox" | "production";

interface ModeState {
  mode: TradingMode;
  setMode: (m: TradingMode) => void;
}

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: "sandbox",
      setMode: (mode) => set({ mode }),
    }),
    { name: "dhan_ct_mode" }
  )
);
