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
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

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
            data.message || data.detail || `Authentication failed (${res.status})`
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
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/70 p-8 text-center shadow-xl">
        {error ? (
          <div className="space-y-4">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-red-500/40 bg-red-950/50 text-red-300">
              !
            </div>
            <h1 className="text-lg font-semibold text-zinc-100">
              GitHub Sign-In Failed
            </h1>
            <p className="text-xs leading-relaxed text-red-300">{error}</p>
            <button
              type="button"
              onClick={() => router.replace("/")}
              className="mt-2 w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200"
            >
              Back to CodePilot
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
            <h1 className="text-base font-semibold text-zinc-100">
              Completing GitHub Sign-In…
            </h1>
            <p className="text-xs text-zinc-400">
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
        <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400 text-sm">
          Loading authentication…
        </main>
      }
    >
      <OAuthCallbackHandler />
    </Suspense>
  );
}