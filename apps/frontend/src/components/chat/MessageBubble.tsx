import clsx from "clsx";

export function MessageBubble({
  role,
  content,
  tone,
}: {
  role: "user" | "assistant";
  content: string;
  tone?: "pending" | "error";
}) {
  const isUser = role === "user";
  return (
    <div className={clsx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
          isUser ? "bg-accent text-accent-fg" : "border border-border bg-bg-elevated",
          tone === "pending" && "opacity-60",
          tone === "error" && "border-2 border-danger",
        )}
      >
        {content}
      </div>
    </div>
  );
}
