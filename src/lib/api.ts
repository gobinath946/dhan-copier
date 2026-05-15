import axios, { AxiosError } from "axios";
import { getToken, clearToken } from "./auth";

// API Base URL - Use environment variable or default to localhost
// For network access, set VITE_API_BASE_URL=http://192.168.0.104:5000
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 5000, // Reduced from 20000 to 5000ms
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      clearToken();
      // Soft redirect to login if not already there.
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error || err.message;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
