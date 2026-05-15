import { useLocation } from "@tanstack/react-router";

export function TopBar() {
  const location = useLocation();

  // Hide TopBar completely on login page
  if (location.pathname === "/login") return null;

  // TopBar is now minimal - all controls moved to sidebar
  return null;
}
