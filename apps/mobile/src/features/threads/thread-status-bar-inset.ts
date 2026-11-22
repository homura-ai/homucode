import { createContext } from "react";

export const ThreadBarInsetConsumed = createContext(false);
export const SetThreadBarInsetConsumed = createContext<(consumed: boolean) => void>(() => {});
