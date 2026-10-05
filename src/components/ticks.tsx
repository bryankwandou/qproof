/** Renders `backtick` spans in scanner messages as inline code. */
export function Ticks({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <code key={i} className="break-all rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}
