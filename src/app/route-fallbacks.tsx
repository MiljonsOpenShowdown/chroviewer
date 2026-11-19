import { AlertCircle, LoaderCircle } from 'lucide-react';

export function PendingFallback() {
  return (
    <main className="flex h-dvh items-center justify-center bg-transparent text-white">
      <LoaderCircle className="size-11 animate-spin" strokeWidth={1.75} aria-label="Loading" />
    </main>
  );
}

export function ErrorFallback({ error }: { error: unknown }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-transparent text-white">
      <AlertCircle className="size-11" strokeWidth={1.75} />
      <span className="text-lg font-semibold tracking-wide">Something went wrong</span>
      {error instanceof Error && error.message !== '' && (
        <span className="max-w-[min(34rem,calc(100vw-1.5rem))] text-sm text-white/60">{error.message}</span>
      )}
      <button
        className="rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload
      </button>
    </main>
  );
}
