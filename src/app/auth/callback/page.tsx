"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setStoredAuth } from "@/lib/auth";
import { AuthSession } from "@/types/auth";

function OAuthCallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const exchangedRef = useRef(false);
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  const oauthError =
    searchParams.get("error_description") || searchParams.get("error");
  const code = searchParams.get("code");
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const validationError = oauthError
    ? oauthError
    : !code
    ? "Missing GitHub authorization code in callback URL."
    : !apiUrl
    ? "NEXT_PUBLIC_API_URL is not configured."
    : null;

  const error = validationError || exchangeError;

  useEffect(() => {
    if (validationError || !code || !apiUrl) return;
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    async function exchangeCode(authCode: string, baseUrl: string) {
      try {
        const res = await fetch(`${baseUrl}/auth/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: authCode }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            data.message ||
              data.detail ||
              `Authentication failed (${res.status})`
          );
        }

        setStoredAuth(data as AuthSession);
        router.replace("/");
      } catch (err) {
        setExchangeError((err as Error).message);
      }
    }

    exchangeCode(code, apiUrl);
  }, [validationError, code, apiUrl, router]);

  return (
    <main className="cp-grid-bg flex min-h-screen items-center justify-center bg-[var(--bg)] px-6 text-[var(--text)]">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-8 text-center">
        {error ? (
          <div className="space-y-4">
            <div
              style={{
                backgroundColor: "var(--danger-tint)",
                borderColor: "var(--danger-border)",
                color: "var(--danger)",
              }}
              className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border font-bold"
            >
              !
            </div>
            <h1 className="text-lg font-semibold text-[var(--text)]">
              GitHub Sign-In Failed
            </h1>
            <p className="text-xs leading-relaxed text-[var(--danger)]">
              {error}
            </p>
            <button
              type="button"
              onClick={() => router.replace("/")}
              className="mt-2 w-full rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-[#0B0E14] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              Back to CodePilot
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--brand)]" />
            <h1 className="text-base font-semibold text-[var(--text)]">
              Completing GitHub Sign-In…
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              Verifying your GitHub account and securing your workspace session.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-muted)]">
          Loading authentication…
        </main>
      }
    >
      <OAuthCallbackHandler />
    </Suspense>
  );
}